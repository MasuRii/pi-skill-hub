import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillsAddCommand } from "../src/commands/skills-command.js";
import { buildSkillsShFindCommand, createSkillsShProvider } from "../src/providers/skills-sh-provider.js";
import { createSkillsMpProvider, extractSkillsMpSkills, type SkillsMpHttpClient } from "../src/providers/skillsmp-provider.js";
import { parseSkillsShReference, skillsShIdentifier } from "../src/providers/skills-sh-identifiers.js";
import type { CommandRunner, CommandRunnerResult } from "../src/types.js";

function runnerReturning(result: CommandRunnerResult, calls: Array<{ command: string; args: readonly string[] }> = []): CommandRunner {
  return {
    async run(command, args) {
      calls.push({ command, args });
      return result;
    },
  };
}

const SKILLS_SH_CLI_CONFIG = {
  apiBaseUrl: "https://skills.sh",
  downloadBaseUrl: "https://skills.sh",
  detailBaseUrl: "https://skills.sh",
  transport: "cli" as const,
  cliCompatibility: true,
};

function assertSkillsCommandShape(command: { command: string; args: readonly string[] }, skillsArgs: readonly string[]): void {
  if (process.platform === "win32") {
    assert.match(command.command, /(?:cmd(?:\.exe)?)$/iu);
    assert.deepEqual(command.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(command.args.length, 4);
    const commandLine = command.args[3] ?? "";
    assert.match(commandLine, /^npm exec --yes --package=skills -- skills /u);
    for (const arg of skillsArgs) {
      assert.match(commandLine, new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }
  } else {
    assert.equal(command.command, "npm");
    assert.deepEqual(command.args, ["exec", "--yes", "--package=skills", "--", "skills", ...skillsArgs]);
  }
}

test("skills.sh identifiers support legacy install references and documented API IDs", () => {
  assert.deepEqual(parseSkillsShReference("owner/repo@skill-name"), { owner: "owner", repo: "repo", skill: "skill-name" });
  assert.deepEqual(parseSkillsShReference("owner/repo/skill-name"), { owner: "owner", repo: "repo", skill: "skill-name" });
  assert.equal(skillsShIdentifier({ owner: "owner", repo: "repo", skill: "skill-name" }), "owner/repo@skill-name");
});

test("skills.sh provider is unavailable for CLI transport until compatibility mode is explicit", () => {
  const provider = createSkillsShProvider(
    runnerReturning({ stdout: "", stderr: "", code: 0 }),
    1000,
    {
      apiBaseUrl: "https://skills.sh",
      downloadBaseUrl: "https://skills.sh",
      detailBaseUrl: "https://skills.sh",
      transport: "cli",
      cliCompatibility: false,
    },
  );

  assert.equal(provider.isAvailable(), false);
});

test("skills.sh provider uses npm exec command form only in explicit CLI compatibility mode", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const provider = createSkillsShProvider(
    runnerReturning(
      {
        stdout: "owner/repo@frontend-design 1.2K installs\n└ https://skills.sh/owner/repo/frontend-design\n",
        stderr: "",
        code: 0,
      },
      calls,
    ),
    1000,
    SKILLS_SH_CLI_CONFIG,
  );

  const results = await provider.search("frontend design", "keyword", 10);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "owner/repo@frontend-design");
  assert.equal(results[0]?.popularity, 1200);
  assert.equal(results[0]?.installReference, "owner/repo@frontend-design");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assertSkillsCommandShape(call, ["find", "frontend design"]);
});

test("skills.sh command builder preserves query as one final executable argument", () => {
  const command = buildSkillsShFindCommand("react&echo unsafe");
  if (process.platform === "win32") {
    assert.equal(command.args[3]?.includes('"react&echo unsafe"'), true);
  } else {
    assert.equal(command.args.at(-1), "react&echo unsafe");
  }
});

test("skills add command builder uses the same cross-platform npm exec strategy", () => {
  const command = buildSkillsAddCommand("https://github.com/example/skill.git");
  assertSkillsCommandShape(command, ["add", "https://github.com/example/skill.git", "-g", "-y"]);
});

test("skills.sh provider parses API search source and skillId into download-compatible identifiers", async () => {
  const calls: string[] = [];
  const provider = createSkillsShProvider(
    runnerReturning({ stdout: "unexpected CLI", stderr: "", code: 1 }),
    1000,
    {
      apiBaseUrl: "https://registry.example.test",
      downloadBaseUrl: "https://skills.sh",
      detailBaseUrl: "https://skills.sh",
      transport: "api",
      cliCompatibility: false,
      apiKey: "configured-key",
    },
    async ({ url, apiKey }) => {
      calls.push(`${url.toString()}|${apiKey ?? ""}`);
      return {
        statusCode: 200,
        body: JSON.stringify({
          skills: [
            {
              id: "frontend-design",
              skillId: "frontend-design",
              name: "Frontend Design",
              source: "anthropics/skills",
              installs: 42,
              description: "Design frontend UI",
            },
          ],
        }),
      };
    },
  );

  const results = await provider.search("frontend", "keyword", 20);

  assert.equal(results[0]?.id, "anthropics/skills@frontend-design");
  assert.equal(results[0]?.sourceUrl, "https://skills.sh/anthropics/skills/frontend-design");
  assert.equal(results[0]?.sourceOwner, "anthropics");
  assert.equal(results[0]?.sourceRepository, "skills");
  assert.equal(results[0]?.sourcePath, "frontend-design");
  assert.equal(results[0]?.name, "Frontend Design");
  assert.deepEqual(calls, ["https://registry.example.test/api/search?q=frontend&limit=20|configured-key"]);
});

test("skills.sh provider parses useful stdout even when CLI exits nonzero", async () => {
  const provider = createSkillsShProvider(
    runnerReturning({
      stdout: "owner/repo@frontend-design 344.5K installs\n└ https://skills.sh/owner/repo/frontend-design\n",
      stderr: "transient wrapper exit",
      code: 1,
    }),
    1000,
    SKILLS_SH_CLI_CONFIG,
  );

  const results = await provider.search("frontend", "keyword", 5);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.name, "frontend-design");
  assert.equal(results[0]?.popularity, 344500);
});

test("skills.sh provider treats explicit nonzero no-results output as empty results", async () => {
  const provider = createSkillsShProvider(
    runnerReturning({
      stdout: "No skills found for \"zzzzzzzzzzzzzzznotaskillquery\"\n",
      stderr: "",
      code: 1,
    }),
    1000,
    SKILLS_SH_CLI_CONFIG,
  );

  await assert.doesNotReject(async () => {
    const results = await provider.search("zzzzzzzzzzzzzzznotaskillquery", "keyword", 5);
    assert.deepEqual(results, []);
  });
});

test("skills.sh provider returns actionable failure details for genuine nonzero command errors", async () => {
  const provider = createSkillsShProvider(
    runnerReturning({
      stdout: "npm error Missing script: \"skills\"\n",
      stderr: "",
      code: 1,
    }),
    1000,
    SKILLS_SH_CLI_CONFIG,
  );

  await assert.rejects(
    () => provider.search("frontend", "keyword", 5),
    /skills\.sh CLI compatibility search failed with exit code 1: npm error Missing script: "skills"/u,
  );
});

test("SkillsMP keyword search is available without API key and parses observed nested payloads", async () => {
  const previousKey = process.env.SKILLSMP_API_KEY;
  delete process.env.SKILLSMP_API_KEY;
  const calls: Array<Parameters<SkillsMpHttpClient>[0]> = [];
  const provider = createSkillsMpProvider(1000, async (request) => {
    calls.push(request);
    return {
      data: {
        data: [
          {
            skill: {
              id: "skillsmp-id",
              name: "friendly-name",
              username: "publisher",
              summary: "Skill from SkillsMP payload",
              downloads: "1.5K",
              github_url: "https://github.com/example/friendly-name",
              skillUrl: "https://skillsmp.com/skills/friendly-name",
            },
          },
        ],
      },
    };
  });

  try {
    assert.equal(provider.requiresAuth, false);
    assert.equal(provider.isAvailable(), true);
    const results = await provider.search("friendly", "keyword", 10);

    assert.equal(calls[0]?.endpoint, "skills/search");
    assert.equal(calls[0]?.apiKey, undefined);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "skillsmp-id");
    assert.equal(results[0]?.name, "friendly-name");
    assert.equal(results[0]?.author, "publisher");
    assert.equal(results[0]?.popularity, 1500);
    assert.equal(results[0]?.githubUrl, "https://github.com/example/friendly-name");
    assert.equal(results[0]?.sourceOwner, "example");
    assert.equal(results[0]?.sourceRepository, "friendly-name");
    assert.equal(results[0]?.installReference, "https://github.com/example/friendly-name");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SKILLSMP_API_KEY;
    } else {
      process.env.SKILLSMP_API_KEY = previousKey;
    }
  }
});

test("SkillsMP provider sends configured API key without requiring environment mutation", async () => {
  const calls: Array<Parameters<SkillsMpHttpClient>[0]> = [];
  const provider = createSkillsMpProvider(1000, async (request) => {
    calls.push(request);
    return { results: [{ id: "keyed-id", name: "keyed", owner: "owner" }] };
  }, "configured-key");

  const results = await provider.search("multi token ai query", "ai", 10);

  assert.equal(calls[0]?.apiKey, "configured-key");
  assert.equal(calls[0]?.endpoint, "skills/ai-search");
  assert.equal(results[0]?.name, "keyed");
});

test("SkillsMP AI search requires API key with actionable guidance", async () => {
  const previousKey = process.env.SKILLSMP_API_KEY;
  delete process.env.SKILLSMP_API_KEY;
  const provider = createSkillsMpProvider(1000, async () => {
    throw new Error("HTTP client should not be called without AI credentials.");
  });

  try {
    await assert.rejects(
      () => provider.search("find a skill for complex multi token request", "ai", 10),
      /SkillsMP AI search requires apiKeys\.skillsMp or SKILLSMP_API_KEY.*shorter keyword query/u,
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.SKILLSMP_API_KEY;
    } else {
      process.env.SKILLSMP_API_KEY = previousKey;
    }
  }
});

test("SkillsMP parser supports root and data result array payload variants", () => {
  const skills = extractSkillsMpSkills({
    results: [{ id: "root-id", name: "root-name" }],
    data: { skills: [{ id: "data-id", name: "data-name" }] },
  });

  assert.deepEqual(skills.map((item) => item.id), ["root-id", "data-id"]);
});
