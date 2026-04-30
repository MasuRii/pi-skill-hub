import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectInventory } from "../src/inventory/inventory.js";
import { computeSkillFingerprint } from "../src/inventory/fingerprint.js";
import { saveManifest } from "../src/manifest/manifest-store.js";
import { buildUpdateApplyPlan } from "../src/plans/plans.js";
import { applyUpdatePlan } from "../src/update/update-apply.js";
import { checkUpdateStatuses, type StageProviderContent } from "../src/update/update-checker.js";
import { stageProviderContent } from "../src/update/provider-content.js";
import { diffDirectories } from "../src/update/file-diff.js";
import type { InventoryItem, ProvenanceEntry, ProvenanceManifest, StagedProviderContent } from "../src/types.js";
import { createSkill, fixtureConfig } from "./helpers.js";

function installedEntry(name: string, localPath: string): ProvenanceEntry {
  return {
    name,
    localPath,
    provenance: "installed",
    provider: "skills-sh",
    sourceId: `owner/repo@${name}`,
    sourceUrl: `https://skills.sh/owner/repo/${name}`,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fingerprint: computeSkillFingerprint(localPath),
  };
}

function manifestWith(...entries: ProvenanceEntry[]): ProvenanceManifest {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: Object.fromEntries(entries.map((entry) => [entry.name, entry])),
  };
}

function stagedSkill(root: string, name: string, description: string): string {
  return createSkill(root, name, description);
}

function fakeStage(stagingRoot: string, description: string): StageProviderContent {
  return async (item: InventoryItem): Promise<StagedProviderContent> => {
    mkdirSync(stagingRoot, { recursive: true });
    const stageRoot = mkdtempSync(join(stagingRoot, "provider-"));
    const stagedPath = stagedSkill(stageRoot, item.name, description);
    return {
      provider: item.manifestEntry?.provider ?? "skills-sh",
      sourceId: item.manifestEntry?.sourceId ?? `owner/repo@${item.name}`,
      stagingPath: stagedPath,
      fingerprint: computeSkillFingerprint(stagedPath),
      diff: diffDirectories(item.path, stagedPath),
    };
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("stage provider content uses skills.sh download payload for skills-sh provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-update-skills-sh-stage-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const skillPath = createSkill(localRoot, "managed-skill", "Local content");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      files: [
        { path: "managed-skill/SKILL.md", contents: "# managed-skill\n\nUpstream content\n" },
        { path: "managed-skill/assets/example.txt", contents: "asset" },
      ],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config = fixtureConfig(localRoot, externalRoot);
  config.skillsSh = { ...config.skillsSh, downloadBaseUrl: `http://127.0.0.1:${String(address.port)}` };
  const manifest = manifestWith({ ...installedEntry("managed-skill", skillPath), sourceId: "owner/repo/managed-skill" });
  const inventory = collectInventory(config, manifest);
  const item = inventory.items.find((entry) => entry.name === "managed-skill");
  assert.ok(item);

  try {
    const staged = await stageProviderContent(item, config);
    assert.deepEqual(requests, ["/api/download/owner/repo/managed-skill"]);
    assert.equal(staged.provider, "skills-sh");
    assert.equal(staged.sourceId, "owner/repo/managed-skill");
    assert.match(readFileSync(join(staged.stagingPath, "SKILL.md"), "utf-8"), /Upstream content/u);
    assert.equal(readFileSync(join(staged.stagingPath, "assets", "example.txt"), "utf-8"), "asset");
    assert.equal(staged.diff.changed.includes("SKILL.md"), true);
    rmSync(staged.stagingPath, { recursive: true, force: true });
  } finally {
    await closeServer(server);
  }
});

test("update check reports current and available using reliable manifest provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-update-status-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const skillPath = createSkill(localRoot, "managed-skill", "Local content");
  const config = fixtureConfig(localRoot, externalRoot);
  const manifest = manifestWith(installedEntry("managed-skill", skillPath));
  const inventory = collectInventory(config, manifest);

  const current = await checkUpdateStatuses(inventory, config, "managed-skill", fakeStage(config.updateStagingRoot, "Local content"));
  assert.equal(current.results[0]?.status, "current");
  assert.equal(current.results[0]?.applicable, false);

  const available = await checkUpdateStatuses(inventory, config, "managed-skill", fakeStage(config.updateStagingRoot, "Upstream content"));
  assert.equal(available.results[0]?.status, "available");
  assert.equal(available.results[0]?.applicable, true);
  assert.equal(available.results[0]?.diff?.changed.includes("SKILL.md"), true);
});

test("update check marks adopted, custom, provenance-weak, and drifted skills non-applicable", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-update-blocks-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const adoptedPath = createSkill(localRoot, "adopted-skill");
  const weakPath = createSkill(localRoot, "weak-skill");
  const driftPath = createSkill(localRoot, "drift-skill");
  createSkill(localRoot, "custom-skill");
  const driftEntry = installedEntry("drift-skill", driftPath);
  writeFileSync(join(driftPath, "SKILL.md"), "# drift-skill\n\nChanged locally\n", "utf-8");
  const manifest = manifestWith(
    { ...installedEntry("adopted-skill", adoptedPath), provenance: "adopted", provider: undefined, sourceId: undefined, sourceUrl: undefined },
    { ...installedEntry("weak-skill", weakPath), provider: undefined, sourceId: undefined, sourceUrl: undefined },
    driftEntry,
  );
  const config = fixtureConfig(localRoot, externalRoot);
  const report = await checkUpdateStatuses(collectInventory(config, manifest), config, undefined, fakeStage(config.updateStagingRoot, "ignored"));
  const byName = new Map(report.results.map((result) => [result.item.name, result]));

  assert.equal(byName.get("adopted-skill")?.status, "unknown");
  assert.equal(byName.get("custom-skill")?.status, "unknown");
  assert.equal(byName.get("weak-skill")?.status, "unknown");
  assert.equal(byName.get("drift-skill")?.status, "blocked");
  assert.equal([...byName.values()].every((result) => !result.applicable), true);
});

test("staged update apply replaces only clean managed target and updates manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-update-apply-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const manifestPath = join(root, "provenance.json");
  const managedPath = createSkill(localRoot, "managed-skill", "Local content");
  const customPath = createSkill(localRoot, "custom-skill", "Custom content");
  const config = fixtureConfig(localRoot, externalRoot);
  const manifest = manifestWith(installedEntry("managed-skill", managedPath));
  saveManifest(manifest, manifestPath);
  const inventory = collectInventory(config, manifest);
  const report = await checkUpdateStatuses(inventory, config, "managed-skill", fakeStage(config.updateStagingRoot, "Upstream content"));
  const plan = buildUpdateApplyPlan(report, "managed-skill");

  await applyUpdatePlan(plan, inventory, config, { confirmToken: "managed-skill", manifestPath }, fakeStage(config.updateStagingRoot, "Upstream content"));

  assert.match(readFileSync(join(managedPath, "SKILL.md"), "utf-8"), /Upstream content/u);
  assert.match(readFileSync(join(customPath, "SKILL.md"), "utf-8"), /Custom content/u);
  assert.equal(existsSync(customPath), true);
});

test("staged update apply refuses drifted target after preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-update-drift-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const manifestPath = join(root, "provenance.json");
  const managedPath = createSkill(localRoot, "managed-skill", "Local content");
  const config = fixtureConfig(localRoot, externalRoot);
  const manifest = manifestWith(installedEntry("managed-skill", managedPath));
  saveManifest(manifest, manifestPath);
  const inventory = collectInventory(config, manifest);
  const report = await checkUpdateStatuses(inventory, config, "managed-skill", fakeStage(config.updateStagingRoot, "Upstream content"));
  const plan = buildUpdateApplyPlan(report, "managed-skill");
  writeFileSync(join(managedPath, "SKILL.md"), "# managed-skill\n\nLocal drift\n", "utf-8");

  await assert.rejects(
    applyUpdatePlan(plan, inventory, config, { confirmToken: "managed-skill", manifestPath }, fakeStage(config.updateStagingRoot, "Upstream content")),
    /Local skill changed after preview/u,
  );
});
