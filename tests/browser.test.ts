import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  calculateBrowserListMaxVisible,
  createSkillBrowserModal,
  createSkillBrowserSessionState,
  type BrowserAction,
  type BrowserServices,
  type SkillBrowserSessionState,
} from "../src/browser/browser-ui.js";
import { buildSkillsShFindCommand } from "../src/providers/skills-sh-provider.js";
import {
  buildMetadataPreview,
  buildRemotePreview,
  extractSkillsShRenderedMarkdown,
  formatPreview,
  parseSecurityAuditsFromText,
  parseSkillsShRenderedMetadata,
  type PreviewHttpClient,
} from "../src/browser/preview.js";
import {
  createBrowserState,
  cycleProviderFilter,
  cycleSortMode,
  filterBrowserResults,
  sortBrowserResults,
  visibleBrowserResults,
} from "../src/browser/browser-model.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatBrowserResultColumns } from "../src/browser/result-layout.js";
import type { CommandRunnerResult, InventorySnapshot, SkillSearchResult } from "../src/types.js";

function skill(name: string, popularity: number, provider: "skills-sh" | "skillsmp", description = `${name} helper`): SkillSearchResult {
  return {
    id: provider === "skills-sh" ? `owner/repo@${name}` : `skillsmp-${name}`,
    name,
    author: "author",
    description,
    popularity,
    provider,
    sourceUrl: `https://example.test/${name}`,
  };
}

function themeFixture(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function boldMarkerThemeFixture(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => `<bold>${text}</bold>`,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function createTuiFixture(renderRequests: { count: number }, rows = 30): TUI {
  return {
    terminal: { rows },
    requestRender: () => {
      renderRequests.count += 1;
    },
  } as unknown as TUI;
}

function inventorySnapshotWithSkill(name: string, sourceId?: string | undefined): InventorySnapshot {
  const localPath = `C:/tmp/pi-skill-hub/local/${name}`;
  return {
    localRoot: "C:/tmp/pi-skill-hub/local",
    externalRoots: [],
    items: [
      {
        name,
        path: localPath,
        rootType: "local",
        classification: "managed",
        driftStatus: "clean",
        metadata: {
          name,
          description: `${name} installed locally`,
          hasSkillFile: true,
        },
        ...(sourceId
          ? {
              manifestEntry: {
                name,
                localPath,
                provenance: "installed" as const,
                provider: "skills-sh" as const,
                sourceId,
                installedAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                fingerprint: {
                  algorithm: "sha256" as const,
                  digest: "test-digest",
                  fileCount: 1,
                  totalBytes: 1,
                },
              },
            }
          : {}),
      },
    ],
    manifestOnlyMissing: [],
  };
}

function browserServices(
  run: BrowserServices["runner"]["run"],
  previewBuilder: BrowserServices["previewBuilder"] = async (result) => buildMetadataPreview(result),
): BrowserServices {
  return {
    config: {
      debug: false,
      localSkillRoot: "C:/tmp/pi-skill-hub/local",
      externalSkillRoots: [],
      providers: { skillsSh: true, skillsMp: false },
      skillsSh: {
        apiBaseUrl: "https://skills.sh",
        downloadBaseUrl: "https://skills.sh",
        detailBaseUrl: "https://skills.sh",
        transport: "cli",
        cliCompatibility: true,
      },
      maxSearchResults: 20,
      requestTimeoutMs: 1000,
      updateStagingRoot: "C:/tmp/pi-skill-hub/staging",
      apiKeys: {},
    },
    runner: { run },
    previewBuilder,
  };
}

function createBrowserHarness(
  services: BrowserServices,
  options: { rows?: number; done?: (action: BrowserAction) => void; theme?: Theme; session?: SkillBrowserSessionState } = {},
): { component: Component & Focusable; render: () => string; renderRequests: { count: number } } {
  const renderRequests = { count: 0 };
  const component = createSkillBrowserModal(
    createTuiFixture(renderRequests, options.rows),
    options.theme ?? themeFixture(),
    services,
    options.done ?? (() => undefined),
    options.session,
  );
  component.focused = true;
  return {
    component,
    render: () => component.render(140).join("\n"),
    renderRequests,
  };
}

function sendInput(component: Component & Focusable, data: string): void {
  if (!component.handleInput) {
    throw new Error("Browser component must expose a keyboard input handler.");
  }
  component.handleInput(data);
}

function typeSearch(component: Component & Focusable, query: string): void {
  for (const character of query) {
    sendInput(component, character);
  }
}

function deferredResult(): { promise: Promise<CommandRunnerResult>; resolve: (result: CommandRunnerResult) => void } {
  let resolvePromise: (result: CommandRunnerResult) => void = () => undefined;
  const promise = new Promise<CommandRunnerResult>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushSearch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("browser model sorts by relevance, popularity, name, and provider", () => {
  const results = [
    skill("zeta", 100, "skillsmp", "general utility"),
    skill("alpha", 5, "skills-sh", "typescript testing helper"),
    skill("beta", 30, "skills-sh", "container helper"),
  ];

  assert.equal(sortBrowserResults(results, "typescript", "relevance")[0]?.name, "alpha");
  assert.equal(sortBrowserResults(results, "typescript", "popularity")[0]?.name, "zeta");
  assert.equal(sortBrowserResults(results, "typescript", "name")[0]?.name, "alpha");
  assert.equal(sortBrowserResults(results, "typescript", "provider")[0]?.provider, "skills-sh");
});

test("browser model applies provider filter and cycles state", () => {
  const state = createBrowserState();
  state.query = "helper";
  state.results = [skill("alpha", 1, "skills-sh"), skill("beta", 2, "skillsmp")];
  state.providerFilter = "skillsmp";
  state.sortMode = "popularity";

  assert.deepEqual(filterBrowserResults(state.results, "skillsmp").map((item) => item.name), ["beta"]);
  assert.deepEqual(visibleBrowserResults(state).map((item) => item.name), ["beta"]);
  assert.equal(cycleSortMode("relevance"), "popularity");
  assert.equal(cycleProviderFilter("all"), "skills-sh");
});

test("browser modal submits typed query on enter and renders loading state", async () => {
  const pending = deferredResult();
  const calls: string[][] = [];
  const harness = createBrowserHarness(
    browserServices(async (_command, args) => {
      calls.push([...args]);
      return pending.promise;
    }),
  );

  typeSearch(harness.component, "frontend");
  sendInput(harness.component, "\r");

  assert.deepEqual(calls, [buildSkillsShFindCommand("frontend").args]);
  assert.match(harness.render(), /Searching providers for "frontend"/u);
  assert.ok(harness.renderRequests.count > 0);

  pending.resolve({ stdout: "[]", stderr: "", code: 0 });
  await flushSearch();
});

test("browser modal renders no-result feedback instead of the empty SelectList placeholder", async () => {
  const harness = createBrowserHarness(
    browserServices(async () => ({ stdout: "[]", stderr: "", code: 0 })),
  );

  typeSearch(harness.component, "frontend");
  sendInput(harness.component, "\r");
  await flushSearch();

  const rendered = harness.render();
  assert.match(rendered, /No skills found for "frontend"/u);
  assert.doesNotMatch(rendered, /No matching commands/u);
});

test("browser modal renders useful results when provider exits nonzero with parseable output", async () => {
  const harness = createBrowserHarness(
    browserServices(async () => ({
      stdout: "owner/repo@frontend-design 1K installs\n└ https://skills.sh/owner/repo/frontend-design\n",
      stderr: "wrapper exited after writing results",
      code: 1,
    })),
  );

  typeSearch(harness.component, "frontend");
  sendInput(harness.component, "\r");
  await flushSearch();

  const rendered = harness.render();
  assert.match(rendered, /1 result for "frontend"/u);
  assert.match(rendered, /frontend-design/u);
  assert.doesNotMatch(rendered, /Provider errors/u);
  assert.doesNotMatch(rendered, /No matching commands/u);
});

test("browser modal surfaces provider errors returned by aggregated search", async () => {
  const harness = createBrowserHarness(
    browserServices(async () => ({ stdout: "", stderr: "simulated provider failure", code: 1 })),
  );

  typeSearch(harness.component, "frontend");
  sendInput(harness.component, "\r");
  await flushSearch();

  const rendered = harness.render();
  assert.match(rendered, /Provider errors: skills-sh: skills\.sh CLI compatibility search failed with exit code 1: simulated provid/u);
  assert.doesNotMatch(rendered, /No matching commands/u);
});

test("browser list capacity renders default twenty results when terminal height allows and fewer when constrained", () => {
  assert.equal(calculateBrowserListMaxVisible({ terminalRows: 40, resultCount: 24, maxSearchResults: 20 }), 20);
  assert.equal(calculateBrowserListMaxVisible({ terminalRows: 16, resultCount: 24, maxSearchResults: 20 }), 3);
});

test("browser result layout truncates plain columns without injecting ANSI resets or line breaks", () => {
  const row = formatBrowserResultColumns(
    {
      prefix: "→ ",
      name: "shopify-polaris-admin-extension-with-extra-long-name",
      provider: "skills-sh",
      downloads: "2061",
      description: "Pi extension development master reference.\nUse when: building pi extensions, debugging extension behavior, or customizing Pi.",
    },
    96,
  );

  assert.equal(visibleWidth(row), 96);
  assert.doesNotMatch(row, /\u001B\[[\d;]*m/u);
  assert.doesNotMatch(row, /[\r\n\u2028\u2029]/u);
  assert.match(row, /…/u);
});

test("browser modal renders aligned headers and up to twenty result rows when height allows", async () => {
  const results = Array.from({ length: 24 }, (_value, index) => ({
    id: `owner/repo@skill-${String(index + 1).padStart(2, "0")}`,
    name: `skill-${String(index + 1).padStart(2, "0")}`,
    author: "owner",
    description: `Skill ${String(index + 1)} description`,
    installs: index + 1,
  }));
  const harness = createBrowserHarness(
    browserServices(async () => ({ stdout: JSON.stringify(results), stderr: "", code: 0 })),
    { rows: 40 },
  );

  typeSearch(harness.component, "skill");
  sendInput(harness.component, "\r");
  await flushSearch();

  const rendered = harness.render();
  assert.match(rendered, /Name\s+Provider\s+Downloads\s+Description/u);
  assert.match(rendered, /skill-01/u);
  assert.match(rendered, /skill-20/u);
  assert.doesNotMatch(rendered, /skill-21/u);
  const headerLine = rendered.split("\n").find((line) => line.includes("Name") && line.includes("Provider"));
  const rowLine = rendered.split("\n").find((line) => line.includes("skill-01"));
  assert.ok(headerLine);
  assert.ok(rowLine);
  assert.equal(headerLine.indexOf("Provider"), rowLine.indexOf("skills-sh"));
  assert.equal(rowLine.indexOf("1", rowLine.indexOf("skills-sh")), headerLine.indexOf("Downloads") + "Downloads".length - 1);
});

test("browser modal pages over cached client-side results with explicit page controls", async () => {
  const results = Array.from({ length: 20 }, (_value, index) => ({
    id: `owner/repo@skill-${String(index + 1).padStart(2, "0")}`,
    name: `skill-${String(index + 1).padStart(2, "0")}`,
    author: "owner",
    description: `Skill ${String(index + 1)} description`,
    installs: index + 1,
  }));
  const harness = createBrowserHarness(
    browserServices(async () => ({ stdout: JSON.stringify(results), stderr: "", code: 0 })),
    { rows: 16 },
  );

  typeSearch(harness.component, "skill");
  sendInput(harness.component, "\r");
  await flushSearch();

  assert.match(harness.render(), /Page 1\/7/u);
  assert.match(harness.render(), /skill-20/u);
  assert.doesNotMatch(harness.render(), /skill-17/u);

  sendInput(harness.component, "\x1b[6~");
  const rendered = harness.render();
  assert.match(rendered, /Page 2\/7/u);
  assert.match(rendered, /skill-17/u);
  assert.doesNotMatch(rendered, /skill-20/u);
});

test("browser session preserves search results and current page across modal recreation", async () => {
  const results = Array.from({ length: 20 }, (_value, index) => ({
    id: `owner/repo@skill-${String(index + 1).padStart(2, "0")}`,
    name: `skill-${String(index + 1).padStart(2, "0")}`,
    author: "owner",
    description: `Skill ${String(index + 1)} description`,
    installs: index + 1,
  }));
  const session = createSkillBrowserSessionState();
  const services = browserServices(async () => ({ stdout: JSON.stringify(results), stderr: "", code: 0 }));
  const firstHarness = createBrowserHarness(services, { rows: 16, session });

  typeSearch(firstHarness.component, "skill");
  sendInput(firstHarness.component, "\r");
  await flushSearch();
  sendInput(firstHarness.component, "\x1b[6~");
  assert.match(firstHarness.render(), /Page 2\/7/u);

  const reopenedHarness = createBrowserHarness(services, { rows: 16, session });
  const rendered = reopenedHarness.render();
  assert.match(rendered, /20 results for "skill"\. Page 2\/7/u);
  assert.match(rendered, /skill-17/u);
  assert.doesNotMatch(rendered, /Type a search query/u);
});

test("browser modal highlights already installed skills in search results", async () => {
  const services = browserServices(async () => ({
    stdout: JSON.stringify([
      { id: "owner/repo@installed-skill", name: "installed-skill", description: "Already present", installs: 1 },
      { id: "owner/repo@new-skill", name: "new-skill", description: "Not present", installs: 3 },
    ]),
    stderr: "",
    code: 0,
  }));
  services.inventorySnapshot = inventorySnapshotWithSkill("installed-skill", "owner/repo@installed-skill");
  const harness = createBrowserHarness(services);

  typeSearch(harness.component, "skill");
  sendInput(harness.component, "\r");
  await flushSearch();

  const rendered = harness.render();
  assert.match(rendered, /matching installed provenance sources are marked ✓ and \[installed:source\]/u);
  assert.match(rendered, /✓\s+installed-skill/u);
  assert.match(rendered, /\[installed:source\] Already present/u);
});

test("browser modal does not highlight same-name skills from different sources as installed", async () => {
  const services = browserServices(async () => ({
    stdout: JSON.stringify([
      { id: "anthropics/skills@frontend-design", name: "frontend-design", description: "Installed source", installs: 10 },
      { id: "pbakaus/impeccable@frontend-design", name: "frontend-design", description: "Different same-name source", installs: 9 },
    ]),
    stderr: "",
    code: 0,
  }));
  services.inventorySnapshot = inventorySnapshotWithSkill("frontend-design", "anthropics/skills@frontend-design");
  const harness = createBrowserHarness(services);

  typeSearch(harness.component, "frontend");
  sendInput(harness.component, "\r");
  await flushSearch();

  const rendered = harness.render();
  assert.match(rendered, /→\s+frontend-design\s+skills-sh\s+10\s+\[installed:source\] Installed source/u);
  assert.match(rendered, /\s+frontend-design\s+skills-sh\s+9\s+Different same-name source/u);
  assert.doesNotMatch(rendered, /\[installed:name\]/u);
  assert.doesNotMatch(rendered, /✓\s+frontend-design\s+skills-sh\s+9\s+\[installed/u);
});

test("browser modal opens preview on first selection and only emits install action after second enter", async () => {
  const actions: BrowserAction[] = [];
  const harness = createBrowserHarness(
    browserServices(async () => ({
      stdout: JSON.stringify([{ id: "owner/repo@preview-skill", name: "preview-skill", description: "Previewable skill", installs: 7 }]),
      stderr: "",
      code: 0,
    })),
    { rows: 30, done: (nextAction) => { actions.push(nextAction); } },
  );

  typeSearch(harness.component, "preview");
  sendInput(harness.component, "\r");
  await flushSearch();
  sendInput(harness.component, "\r");

  assert.equal(actions.length, 0);
  assert.match(harness.render(), /Loading remote SKILL\.md preview/u);
  await flushSearch();
  assert.match(harness.render(), /Review skill details/u);
  assert.match(harness.render(), /Install reference: owner\/repo@preview-skill/u);

  sendInput(harness.component, "\r");
  const action = actions[0];
  assert.ok(action);
  assert.equal(action.type, "install");
  assert.equal(action.skill.name, "preview-skill");
});

test("browser preview scrolls long markdown body with preview navigation keys", async () => {
  const longBody = Array.from({ length: 12 }, (_value, index) => `- Scroll row ${String(index + 1).padStart(2, "0")}`).join("\n");
  const harness = createBrowserHarness(
    browserServices(
      async () => ({
        stdout: JSON.stringify([{ id: "owner/repo@scroll-skill", name: "scroll-skill", description: "Scrollable", installs: 7 }]),
        stderr: "",
        code: 0,
      }),
      async (result) => ({
        title: result.name,
        body: longBody,
        source: "remote",
        metadata: { provider: result.provider, securityAudits: [], status: "unavailable" },
      }),
    ),
    { rows: 18 },
  );

  typeSearch(harness.component, "scroll");
  sendInput(harness.component, "\r");
  await flushSearch();
  sendInput(harness.component, "\r");
  await flushSearch();

  assert.match(harness.render(), /Scroll row 01/u);
  assert.doesNotMatch(harness.render(), /Scroll row 12/u);
  assert.match(harness.render(), /↑\/↓ scroll • pgup\/pgdn page • home\/end top\/bottom/u);

  sendInput(harness.component, "\x1b[B");
  const afterDown = harness.render();
  assert.doesNotMatch(afterDown, /Scroll row 01/u);
  assert.match(afterDown, /Scroll row 02/u);

  sendInput(harness.component, "\x1b[6~");
  const afterPageDown = harness.render();
  assert.doesNotMatch(afterPageDown, /Scroll row 02/u);
  assert.match(afterPageDown, /Scroll row 04/u);

  sendInput(harness.component, "\x1b[5~");
  assert.match(harness.render(), /Scroll row 02/u);

  sendInput(harness.component, "\x1b[F");
  assert.match(harness.render(), /Scroll row 12/u);

  sendInput(harness.component, "\x1b[H");
  assert.match(harness.render(), /Scroll row 01/u);
});

test("browser preview renders markdown strong text through Pi TUI Markdown", async () => {
  const harness = createBrowserHarness(
    browserServices(
      async () => ({
        stdout: JSON.stringify([{ id: "owner/repo@bold-skill", name: "bold-skill", description: "Bold", installs: 7 }]),
        stderr: "",
        code: 0,
      }),
      async (result) => ({
        title: result.name,
        body: "Plain **Test** text",
        source: "remote",
        metadata: { provider: result.provider, securityAudits: [], status: "unavailable" },
      }),
    ),
    { rows: 24, theme: boldMarkerThemeFixture() },
  );

  typeSearch(harness.component, "bold");
  sendInput(harness.component, "\r");
  await flushSearch();
  sendInput(harness.component, "\r");
  await flushSearch();

  const rendered = harness.render();
  assert.match(rendered, /Plain <bold>Test<\/bold> text/u);
  assert.doesNotMatch(rendered, /\*\*Test\*\*/u);
});

test("browser preview escape returns to list with selected result preserved", async () => {
  const actions: BrowserAction[] = [];
  const harness = createBrowserHarness(
    browserServices(async () => ({
      stdout: JSON.stringify([
        { id: "owner/repo@first-skill", name: "first-skill", description: "First", installs: 1 },
        { id: "owner/repo@second-skill", name: "second-skill", description: "Second", installs: 2 },
      ]),
      stderr: "",
      code: 0,
    })),
    { rows: 30, done: (nextAction) => { actions.push(nextAction); } },
  );

  typeSearch(harness.component, "skill");
  sendInput(harness.component, "\r");
  await flushSearch();
  sendInput(harness.component, "\r");
  await flushSearch();
  assert.match(harness.render(), /Name: second-skill/u);

  sendInput(harness.component, "\x1b");
  assert.equal(actions.length, 0);
  const rendered = harness.render();
  assert.match(rendered, /Name\s+Provider\s+Downloads/u);
  sendInput(harness.component, "\r");
  await flushSearch();
  sendInput(harness.component, "\r");
  const action = actions[0];
  assert.ok(action);
  assert.equal(action.skill.name, "second-skill");
});

test("metadata preview explains full-content limitation before install", () => {
  const preview = buildMetadataPreview(skill("metadata-only", 0, "skillsmp"));
  const formatted = formatPreview(preview);
  assert.equal(preview.source, "metadata");
  assert.match(formatted, /Full remote SKILL\.md\/README content is not safely exposed/u);
  assert.match(formatted, /metadata-only/u);
  assert.match(formatted, /GitHub stars: unavailable/u);
  assert.match(formatted, /Security audits: unavailable/u);
});

test("preview formatting strips terminal controls while preserving markdown whitespace", () => {
  const formatted = formatPreview({
    title: "remote-preview\u001B[31m",
    body: "# Heading\n\n\tTabbed **markdown** \u001B[32mgreen\u001B[0m\nBell\u0007 done\n\u001B]52;c;clipboard\u0007safe",
    source: "remote",
    metadata: {
      provider: "skills-sh",
      githubStars: 1,
      securityAudits: [],
      status: "partial",
    },
  });

  assert.doesNotMatch(formatted, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u);
  assert.doesNotMatch(formatted, /\u001B\[/u);
  assert.doesNotMatch(formatted, /clipboard/u);
  assert.match(formatted, /# Heading\n\n\tTabbed \*\*markdown\*\* green/u);
  assert.match(formatted, /Bell done\nsafe/u);
});

test("skills.sh preview fetches SKILL.md from download API and displays metadata tags", async () => {
  const calls: string[] = [];
  const httpClient: PreviewHttpClient = async ({ url }) => {
    calls.push(url.toString());
    if (url.pathname === "/api/download/anthropics/skills/frontend-design") {
      return {
        statusCode: 200,
        body: JSON.stringify({ files: [{ path: "frontend-design/SKILL.md", contents: "# Frontend Design\n\nUse visual hierarchy." }], hash: "abc" }),
      };
    }
    if (url.pathname === "/anthropics/skills/frontend-design") {
      return {
        statusCode: 200,
        body: "<html><body><span>GitHub stars 12.5K</span><div>Agent Trust Hub Pass</div><div>Socket Pass</div><div>Snyk Fail</div></body></html>",
      };
    }
    return { statusCode: 404, body: "" };
  };

  const preview = await buildRemotePreview(
    {
      ...skill("frontend-design", 42, "skills-sh"),
      id: "anthropics/skills@frontend-design",
      sourceUrl: "https://skills.sh/anthropics/skills/frontend-design",
    },
    httpClient,
  );
  const formatted = formatPreview(preview);

  assert.equal(preview.source, "remote");
  assert.match(formatted, /# Frontend Design/u);
  assert.match(formatted, /GitHub stars: 12500/u);
  assert.match(formatted, /Agent Trust Hub pass/u);
  assert.match(formatted, /Snyk fail/u);
  assert.deepEqual(calls, [
    "https://skills.sh/api/download/anthropics/skills/frontend-design",
    "https://skills.sh/anthropics/skills/frontend-design",
  ]);
});

test("skills.sh preview falls back to rendered detail SKILL.md and weekly installs when download API is unavailable", async () => {
  const calls: string[] = [];
  const html = `
    <html><body>
      <span>SKILL.md</span>
      <div class="prose prose-invert">
        <h1>Test-Driven Development (TDD)</h1>
        <p>Write tests first, watch them fail, then implement minimal code to pass.</p>
        <h2>Verification Checklist</h2>
        <ul><li>Every new function/method has a test</li></ul>
      </div>
      <span>Weekly Installs</span><div>64.2K</div>
      <span>GitHub Stars</span><div>168.5K</div>
      <span>Agent Trust Hub Pass</span><span>Socket Pass</span><span>Snyk Pass</span>
    </body></html>`;
  const httpClient: PreviewHttpClient = async ({ url }) => {
    calls.push(url.toString());
    if (url.pathname === "/api/download/obra/superpowers/test-driven-development") {
      return { statusCode: 429, body: JSON.stringify({ error: "rate_limit_exceeded" }) };
    }
    if (url.pathname === "/obra/superpowers/test-driven-development") {
      return { statusCode: 200, body: html };
    }
    return { statusCode: 404, body: "" };
  };

  const preview = await buildRemotePreview(
    {
      ...skill("test-driven-development", 0, "skills-sh"),
      id: "obra/superpowers@test-driven-development",
      sourceUrl: "https://skills.sh/obra/superpowers/test-driven-development",
    },
    httpClient,
  );
  const formatted = formatPreview(preview);

  assert.equal(preview.source, "remote");
  assert.match(preview.body, /# Test-Driven Development \(TDD\)/u);
  assert.match(preview.body, /- Every new function\/method has a test/u);
  assert.equal(preview.metadata.weeklyInstalls, 64200);
  assert.match(formatted, /Weekly installs: 64200/u);
  assert.match(formatted, /GitHub stars: 168500/u);
  assert.doesNotMatch(formatted, /Limitation:/u);
  assert.deepEqual(calls, [
    "https://skills.sh/api/download/obra/superpowers/test-driven-development",
    "https://skills.sh/obra/superpowers/test-driven-development",
  ]);
});

test("skills.sh rendered detail parser extracts markdown from the SKILL.md prose section", () => {
  const markdown = extractSkillsShRenderedMarkdown(`
    <section><span>Summary</span><p>Not this text</p></section>
    <div><span>SKILL.md</span></div>
    <div class="prose prose-invert"><h1>Skill Title</h1><p>Use the skill.</p><ul><li>First step</li></ul></div>
    <aside><span>Weekly Installs</span><div>64.2K</div></aside>
  `);

  assert.equal(markdown, "# Skill Title\n\nUse the skill.\n\n- First step");
});

test("skills.sh preview remains compatible with legacy content payloads", async () => {
  const httpClient: PreviewHttpClient = async ({ url }) => {
    if (url.pathname === "/api/download/anthropics/skills/legacy-preview") {
      return {
        statusCode: 200,
        body: JSON.stringify({ files: [{ path: "legacy-preview/SKILL.md", content: "# Legacy Content Preview" }] }),
      };
    }
    return { statusCode: 404, body: "" };
  };

  const preview = await buildRemotePreview(
    {
      ...skill("legacy-preview", 1, "skills-sh"),
      id: "anthropics/skills@legacy-preview",
      sourceUrl: "https://skills.sh/anthropics/skills/legacy-preview",
    },
    httpClient,
  );

  assert.equal(preview.source, "remote");
  assert.match(preview.body, /# Legacy Content Preview/u);
});

test("SkillsMP preview fetches SKILL.md from safe GitHub tree URLs", async () => {
  const calls: string[] = [];
  const httpClient: PreviewHttpClient = async ({ url }) => {
    calls.push(url.toString());
    assert.equal(url.hostname, "raw.githubusercontent.com");
    if (url.pathname === "/anthropics/skills/main/frontend-design/SKILL.md") {
      return { statusCode: 200, body: "# SkillsMP Frontend Design\n\nUse GitHub-hosted instructions." };
    }
    return { statusCode: 404, body: "" };
  };

  const preview = await buildRemotePreview(
    {
      ...skill("frontend-design", 5, "skillsmp"),
      sourceUrl: "https://skillsmp.com/skills/frontend-design",
      githubUrl: "https://github.com/anthropics/skills/tree/main/frontend-design",
    },
    httpClient,
  );

  assert.equal(preview.source, "remote");
  assert.match(preview.body, /# SkillsMP Frontend Design/u);
  assert.deepEqual(calls, ["https://raw.githubusercontent.com/anthropics/skills/main/frontend-design/SKILL.md"]);
});

test("SkillsMP preview does not fetch arbitrary non-GitHub source URLs", async () => {
  const calls: string[] = [];
  const httpClient: PreviewHttpClient = async ({ url }) => {
    calls.push(url.toString());
    return { statusCode: 200, body: "# Unexpected" };
  };

  const preview = await buildRemotePreview(
    {
      ...skill("metadata-only", 3, "skillsmp"),
      sourceUrl: "https://attacker.test/skills/metadata-only",
    },
    httpClient,
  );
  const formatted = formatPreview(preview);

  assert.equal(preview.source, "metadata");
  assert.deepEqual(calls, []);
  assert.match(formatted, /Full remote SKILL\.md\/README content is not safely exposed/u);
  assert.match(formatted, /metadata-only/u);
});

test("skills.sh preview ignores malicious provider sourceUrl when fetching metadata", async () => {
  const calls: string[] = [];
  const httpClient: PreviewHttpClient = async ({ url }) => {
    calls.push(url.toString());
    assert.notEqual(url.hostname, "attacker.test");
    if (url.pathname === "/api/download/anthropics/skills/safe-preview") {
      return {
        statusCode: 200,
        body: JSON.stringify({ files: [{ path: "safe-preview/SKILL.md", contents: "# Safe Preview" }] }),
      };
    }
    if (url.pathname === "/anthropics/skills/safe-preview") {
      return { statusCode: 200, body: "<p>GitHub stars 7</p><p>Socket Pass</p>" };
    }
    return { statusCode: 404, body: "" };
  };

  const preview = await buildRemotePreview(
    {
      ...skill("safe-preview", 7, "skills-sh"),
      id: "anthropics/skills@safe-preview",
      sourceUrl: "https://attacker.test/collect?target=skills.sh",
    },
    httpClient,
  );

  assert.equal(preview.source, "remote");
  assert.deepEqual(calls, [
    "https://skills.sh/api/download/anthropics/skills/safe-preview",
    "https://skills.sh/anthropics/skills/safe-preview",
  ]);
});

test("skills.sh preview falls back to metadata with unavailable audit indicators", async () => {
  const httpClient: PreviewHttpClient = async ({ url }) => {
    if (url.hostname === "api.github.com") {
      return { statusCode: 404, body: "" };
    }
    return { statusCode: 404, body: "" };
  };

  const preview = await buildRemotePreview(
    {
      ...skill("missing-preview", 0, "skills-sh"),
      id: "owner/repo@missing-preview",
      sourceUrl: "https://skills.sh/owner/repo/missing-preview",
    },
    httpClient,
  );
  const formatted = formatPreview(preview);

  assert.equal(preview.source, "metadata");
  assert.match(formatted, /Remote SKILL\.md was unavailable/u);
  assert.match(formatted, /GitHub stars: unavailable/u);
  assert.match(formatted, /Security audits: unavailable/u);
  assert.doesNotMatch(formatted, /Security audits: .*pass/u);
});

test("security audit parser reports available pass and fail statuses without inventing missing audits", () => {
  const audits = parseSecurityAuditsFromText("Agent Trust Hub Pass Socket Failed unrelated badge");
  assert.deepEqual(audits, [
    { label: "Agent Trust Hub", status: "pass" },
    { label: "Socket", status: "fail" },
  ]);

  const metadata = parseSkillsShRenderedMetadata("<p>Weekly Installs 64.2K</p><p>GitHub stars: 999</p><p>No audits published</p>");
  assert.equal(metadata.weeklyInstalls, 64200);
  assert.equal(metadata.githubStars, 999);
  assert.deepEqual(metadata.securityAudits, []);
  assert.equal(metadata.status, "partial");
});
