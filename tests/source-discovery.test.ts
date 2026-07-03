import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectInventory } from "../src/inventory/inventory.js";
import { loadManifest, emptyManifest } from "../src/manifest/manifest-store.js";
import { applyBindSourcePlan, applyBulkBindSourcePlan } from "../src/plans/apply.js";
import { buildBindSourcePlan, buildBulkBindSourcePlan } from "../src/plans/plans.js";
import { buildManualSourceMatch, discoverBulkSourceBindings, discoverSourceMatches } from "../src/discovery/source-discovery.js";
import type { SkillContentPreview, SkillSearchResult } from "../src/types.js";
import { createSkill, fixtureConfig } from "./helpers.js";
import type { SkillHubConfig } from "../src/config/config.js";

function cliFixtureConfig(localRoot: string, externalRoot: string): SkillHubConfig {
  const config = fixtureConfig(localRoot, externalRoot);
  return { ...config, skillsSh: { ...config.skillsSh, transport: "cli", cliCompatibility: true } };
}

test("source discovery ranks provider candidates by local SKILL.md similarity", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-source-discovery-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  createSkill(localRoot, "backend-testing", "Node.js API integration testing with database fixtures and contract assertions.");
  const snapshot = collectInventory(cliFixtureConfig(localRoot, externalRoot), emptyManifest());
  const item = snapshot.items.find((entry) => entry.name === "backend-testing");
  assert.ok(item);

  const report = await discoverSourceMatches(item, cliFixtureConfig(localRoot, externalRoot), {
    async run() {
      return {
        stdout: JSON.stringify([
          {
            skillId: "backend-testing",
            name: "backend-testing",
            source: "owner/repo",
            description: "Node.js API integration testing with database fixtures and contract assertions.",
            installs: 42,
          },
          {
            skillId: "frontend-design",
            name: "frontend-design",
            source: "owner/repo",
            description: "Polished landing page visual design.",
            installs: 100,
          },
        ]),
        stderr: "",
        code: 0,
      };
    },
  }, {
    async previewBuilder(skill: SkillSearchResult): Promise<SkillContentPreview> {
      return {
        title: skill.name,
        body: skill.name === "backend-testing"
          ? "# backend-testing\n\nNode.js API integration testing with database fixtures and contract assertions."
          : "# frontend-design\n\nPolished landing page visual design.",
        source: "remote",
        metadata: { provider: skill.provider, securityAudits: [], status: "available" },
      };
    },
  });

  assert.equal(report.matches[0]?.skill.name, "backend-testing");
  assert.equal(report.matches[0]?.confidence, "high");
  assert.ok((report.matches[0]?.score ?? 0) > (report.matches[1]?.score ?? 0));
});

test("bind source plan records provider provenance without changing local skill files", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-bind-source-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const manifestPath = join(root, "provenance.json");
  createSkill(localRoot, "backend-testing", "Node.js API integration testing with database fixtures and contract assertions.");
  const snapshot = collectInventory(cliFixtureConfig(localRoot, externalRoot), emptyManifest());
  const item = snapshot.items.find((entry) => entry.name === "backend-testing");
  assert.ok(item);

  const report = await discoverSourceMatches(item, cliFixtureConfig(localRoot, externalRoot), {
    async run() {
      return {
        stdout: JSON.stringify([{ skillId: "backend-testing", name: "backend-testing", source: "owner/repo", description: item.metadata.description }]),
        stderr: "",
        code: 0,
      };
    },
  }, {
    previewBuilder: async (skill) => ({
      title: skill.name,
      body: `# ${skill.name}\n\n${item.metadata.description}`,
      source: "remote",
      metadata: { provider: skill.provider, securityAudits: [], status: "available" },
    }),
  });
  const match = report.matches[0];
  assert.ok(match);

  const plan = buildBindSourcePlan(snapshot, item.name, match);
  assert.equal(plan.canApply, true);
  applyBindSourcePlan(plan, snapshot, match, { confirmToken: plan.confirmationToken ?? "", manifestPath });

  const manifest = loadManifest(manifestPath);
  assert.equal(manifest.skills["backend-testing"]?.provenance, "installed");
  assert.equal(manifest.skills["backend-testing"]?.provider, "skills-sh");
  assert.equal(manifest.skills["backend-testing"]?.sourceId, "owner/repo@backend-testing");
});

test("manual source binding records GitHub owner repository and path metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-manual-bind-source-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const manifestPath = join(root, "provenance.json");
  createSkill(localRoot, "backend-testing", "Node.js API integration testing with database fixtures and contract assertions.");
  const snapshot = collectInventory(fixtureConfig(localRoot, externalRoot), emptyManifest());
  const item = snapshot.items.find((entry) => entry.name === "backend-testing");
  assert.ok(item);

  const match = await buildManualSourceMatch(
    item,
    "https://github.com/example/skills/tree/main/backend-testing",
    async (skill) => ({
      title: skill.name,
      body: `# ${skill.name}

Manual preview`,
      source: "remote",
      metadata: { provider: skill.provider, weeklyInstalls: 64200, securityAudits: [], status: "available" },
    }),
  );

  assert.equal(match.skill.popularity, 64200);
  const plan = buildBindSourcePlan(snapshot, item.name, match);
  assert.equal(plan.canApply, true);
  applyBindSourcePlan(plan, snapshot, match, { confirmToken: plan.confirmationToken ?? "", manifestPath });

  const manifest = loadManifest(manifestPath);
  const entry = manifest.skills["backend-testing"];
  assert.equal(entry?.provider, "github");
  assert.equal(entry?.sourceId, "https://github.com/example/skills/tree/main/backend-testing");
  assert.equal(entry?.sourceOwner, "example");
  assert.equal(entry?.sourceRepository, "skills");
  assert.equal(entry?.sourcePath, "backend-testing");
});

test("bulk source discovery auto-binds only high-confidence unlinked skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-bulk-bind-source-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const manifestPath = join(root, "provenance.json");
  createSkill(localRoot, "backend-testing", "Node.js API integration testing with database fixtures and contract assertions.");
  createSkill(localRoot, "frontend-design", "Production-grade frontend interface design with React components and accessibility polish.");
  createSkill(localRoot, "private-workflow", "Personal local workflow notes that should not match public provider skills.");
  const config = cliFixtureConfig(localRoot, externalRoot);
  const snapshot = collectInventory(config, emptyManifest());

  const report = await discoverBulkSourceBindings(snapshot.items, config, {
    async run(_command, args) {
      const query = args[args.length - 1] ?? "";
      const results = query.includes("backend")
        ? [{ skillId: "backend-testing", name: "backend-testing", source: "owner/repo", description: "Node.js API integration testing with database fixtures and contract assertions." }]
        : query.includes("frontend")
          ? [{ skillId: "frontend-design", name: "frontend-design", source: "owner/repo", description: "Production-grade frontend interface design with React components and accessibility polish." }]
          : [{ skillId: "random-skill", name: "random-skill", source: "owner/repo", description: "Unrelated public provider content." }];
      return { stdout: JSON.stringify(results), stderr: "", code: 0 };
    },
  }, {
    previewBuilder: async (skill) => ({
      title: skill.name,
      body: skill.name === "backend-testing"
        ? "# backend-testing\n\nNode.js API integration testing with database fixtures and contract assertions."
        : skill.name === "frontend-design"
          ? "# frontend-design\n\nProduction-grade frontend interface design with React components and accessibility polish."
          : "# random-skill\n\nUnrelated public provider content.",
      source: "remote",
      metadata: { provider: skill.provider, securityAudits: [], status: "available" },
    }),
    concurrency: 2,
  });

  assert.deepEqual(report.bindings.map((binding) => binding.item.name).sort(), ["backend-testing", "frontend-design"]);
  assert.deepEqual(report.skipped.map((skipped) => skipped.item.name), ["private-workflow"]);

  const plan = buildBulkBindSourcePlan(snapshot, report.bindings);
  assert.equal(plan.canApply, true);
  assert.equal(plan.operations.length, 2);
  applyBulkBindSourcePlan(plan, snapshot, report.bindings, { confirmToken: plan.confirmationToken ?? "", manifestPath });

  const manifest = loadManifest(manifestPath);
  assert.equal(manifest.skills["backend-testing"]?.sourceId, "owner/repo@backend-testing");
  assert.equal(manifest.skills["frontend-design"]?.sourceId, "owner/repo@frontend-design");
  assert.equal(manifest.skills["private-workflow"], undefined);
});
