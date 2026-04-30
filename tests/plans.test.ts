import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectInventory } from "../src/inventory/inventory.js";
import { computeSkillFingerprint } from "../src/inventory/fingerprint.js";
import { loadManifest } from "../src/manifest/manifest-store.js";
import { applyInstallPlan } from "../src/plans/apply.js";
import { buildAdoptPlan, buildInstallPreviewPlan, buildRemovePreviewPlan, buildUpdatePreviewPlan } from "../src/plans/plans.js";
import type { ProvenanceManifest, SkillSearchResult } from "../src/types.js";
import { buildSkillsAddCommand } from "../src/commands/skills-command.js";
import { isPathInside, normalizePathForKey, resolveSafeLocalSkillPath } from "../src/utils/path-utils.js";
import { createSkill, fixtureConfig } from "./helpers.js";

test("plans protect unknown and external skills from removal", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-plan-protect-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  createSkill(localRoot, "custom-skill");
  createSkill(externalRoot, "external-skill");
  const inventory = collectInventory(fixtureConfig(localRoot, externalRoot), { version: 1, updatedAt: new Date().toISOString(), skills: {} });

  const unknownPlan = buildRemovePreviewPlan(inventory, "custom-skill");
  const externalPlan = buildRemovePreviewPlan(inventory, "external-skill");
  assert.equal(unknownPlan.canApply, false);
  assert.equal(unknownPlan.blocked[0]?.protected, true);
  assert.equal(externalPlan.canApply, false);
  assert.equal(externalPlan.blocked[0]?.protected, true);
});

test("plans allow managed clean removal and unknown adoption previews", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-plan-managed-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const managedPath = createSkill(localRoot, "managed-skill");
  createSkill(localRoot, "custom-skill");
  const manifest: ProvenanceManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: {
      "managed-skill": {
        name: "managed-skill",
        localPath: managedPath,
        provenance: "installed",
        sourceId: "owner/repo@managed-skill",
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fingerprint: computeSkillFingerprint(managedPath),
      },
    },
  };
  const inventory = collectInventory(fixtureConfig(localRoot, externalRoot), manifest);

  assert.equal(buildRemovePreviewPlan(inventory, "managed-skill").canApply, true);
  assert.equal(buildAdoptPlan(inventory, "custom-skill").canApply, true);
  const updatePlan = buildUpdatePreviewPlan(inventory);
  assert.equal(updatePlan.operations.length, 0);
  assert.ok(updatePlan.blocked.some((operation) => /lacks reliable provider\/source metadata/u.test(operation.description)));
});

test("install preview blocks overwriting existing local skill directories", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-install-plan-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  createSkill(localRoot, "existing-skill");
  const plan = buildInstallPreviewPlan(fixtureConfig(localRoot, externalRoot), "owner/repo@existing-skill");
  assert.equal(plan.canApply, false);
  assert.equal(plan.blocked[0]?.protected, true);
});

test("install preview targets only direct local skill children for valid install identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-install-valid-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const plan = buildInstallPreviewPlan(fixtureConfig(localRoot, externalRoot), "owner/repo@new-skill");

  assert.equal(plan.canApply, true);
  assert.equal(plan.operations.length, 2);
  assert.ok(plan.operations.every((operation) => isPathInside(operation.target, localRoot) || operation.target === "owner/repo@new-skill"));
});

test("install preview canonicalizes skills.sh URLs and display names to installer-safe skill identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-install-skills-sh-url-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const config = fixtureConfig(localRoot, externalRoot);

  const urlPlan = buildInstallPreviewPlan(config, "https://skills.sh/owner/repo/new-skill");
  assert.equal(urlPlan.canApply, true);
  assert.equal(urlPlan.confirmationToken, "owner/repo@new-skill");
  assert.equal(urlPlan.operations.find((operation) => operation.kind === "run_command")?.target, "owner/repo@new-skill");
  assert.ok(urlPlan.operations.find((operation) => operation.kind === "write_manifest")?.target.endsWith(join("local", "new-skill")));

  const sourceSkill: SkillSearchResult = {
    id: "owner/repo@display-skill",
    name: "Display Skill",
    author: "owner",
    description: "Provider display name fixture",
    popularity: 4,
    provider: "skills-sh",
    sourceUrl: "https://skills.sh/owner/repo/display-skill",
  };
  const displayPlan = buildInstallPreviewPlan(config, sourceSkill);
  assert.equal(displayPlan.canApply, true);
  assert.equal(displayPlan.confirmationToken, "owner/repo@display-skill");
  assert.ok(displayPlan.operations.find((operation) => operation.kind === "write_manifest")?.target.endsWith(join("local", "display-skill")));
});

test("install preview blocks traversal and path-like skill names before target path construction", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-install-traversal-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const config = fixtureConfig(localRoot, externalRoot);
  const unsafeIdentifiers = [
    "owner/repo@../../outside-skill",
    "owner/repo@..\\outside-skill",
    "owner/repo@nested/skill",
    "owner/repo@nested\\skill",
    "owner/repo@/outside-skill",
    "owner/repo@C:\\outside-skill",
    "../../outside-skill",
  ];

  for (const skillId of unsafeIdentifiers) {
    const plan = buildInstallPreviewPlan(config, skillId);
    assert.equal(plan.canApply, false, skillId);
    assert.equal(plan.operations.length, 0, skillId);
    assert.equal(plan.blocked[0]?.protected, true, skillId);
    assert.ok(plan.blocked.every((operation) => isPathInside(operation.target, localRoot)), skillId);
  }
});

test("install preview blocks unsafe skill names returned by providers", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-install-provider-name-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const unsafeSkill: SkillSearchResult = {
    id: "owner/repo@../../outside-skill",
    name: "../../outside-skill",
    author: "owner",
    description: "Unsafe fixture skill",
    popularity: 0,
    provider: "skills-sh",
  };

  const plan = buildInstallPreviewPlan(fixtureConfig(localRoot, externalRoot), unsafeSkill);
  assert.equal(plan.canApply, false);
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.blocked[0]?.protected, true);
  assert.ok(plan.blocked.every((operation) => isPathInside(operation.target, localRoot)));
});

test("install preview separates provider id, local skill name, and install reference", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-install-descriptor-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const sourceSkill: SkillSearchResult = {
    id: "skillsmp-remote-id",
    name: "friendly-local-name",
    author: "publisher",
    description: "Descriptor fixture",
    popularity: 10,
    provider: "skillsmp",
    sourceUrl: "https://skillsmp.com/skills/friendly-local-name",
    installReference: "https://github.com/example/friendly-local-name",
  };

  const plan = buildInstallPreviewPlan(fixtureConfig(localRoot, externalRoot), sourceSkill);

  assert.equal(plan.canApply, true);
  assert.equal(plan.confirmationToken, "https://github.com/example/friendly-local-name");
  assert.equal(plan.operations.find((operation) => operation.kind === "run_command")?.target, "https://github.com/example/friendly-local-name");
  const manifestTarget = plan.operations.find((operation) => operation.kind === "write_manifest")?.target;
  assert.ok(manifestTarget?.endsWith(join("local", "friendly-local-name")));
});

test("apply install plan uses descriptor local name and does not overwrite existing directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-apply-install-descriptor-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const manifestPath = join(root, "provenance.json");
  const config = fixtureConfig(localRoot, externalRoot);
  const sourceSkill: SkillSearchResult = {
    id: "skillsmp-remote-id",
    name: "friendly-local-name",
    author: "publisher",
    description: "Descriptor fixture",
    popularity: 10,
    provider: "skillsmp",
    sourceUrl: "https://skillsmp.com/skills/friendly-local-name",
    installReference: "https://github.com/example/friendly-local-name",
  };
  const plan = buildInstallPreviewPlan(config, sourceSkill);
  const calls: Array<{ command: string; args: readonly string[] }> = [];

  await applyInstallPlan(plan, config, {
    async run(command, args) {
      calls.push({ command, args });
      createSkill(localRoot, "friendly-local-name", "Installed content");
      return { stdout: "installed", stderr: "", code: 0 };
    },
  }, { confirmToken: plan.confirmationToken ?? "", manifestPath, sourceSkill });

  assert.equal(existsSync(join(localRoot, "friendly-local-name")), true);
  assert.deepEqual(calls[0], buildSkillsAddCommand("https://github.com/example/friendly-local-name"));
  const manifest = loadManifest(manifestPath);
  assert.equal(manifest.skills["friendly-local-name"]?.sourceId, "skillsmp-remote-id");
  assert.equal(manifest.skills["friendly-local-name"]?.provider, "skillsmp");

  await assert.rejects(
    applyInstallPlan(plan, config, { async run() { return { stdout: "", stderr: "", code: 0 }; } }, { confirmToken: plan.confirmationToken ?? "", manifestPath, sourceSkill }),
    /Refusing to install over existing skill directory/u,
  );
});


test("apply install plan installs skills.sh content through the download API", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-apply-skills-sh-display-"));
  const localRoot = join(root, "local");
  const externalRoot = join(root, "external");
  const manifestPath = join(root, "provenance.json");
  const config = fixtureConfig(localRoot, externalRoot);
  const sourceSkill: SkillSearchResult = {
    id: "owner/repo@display-skill",
    name: "Display Skill",
    author: "owner",
    description: "skills.sh display title fixture",
    popularity: 10,
    provider: "skills-sh",
    sourceUrl: "https://skills.sh/owner/repo/display-skill",
  };
  const plan = buildInstallPreviewPlan(config, sourceSkill);
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const httpRequests: string[] = [];

  await applyInstallPlan(plan, config, {
    async run(command, args) {
      calls.push({ command, args });
      return { stdout: "unexpected CLI install", stderr: "", code: 1 };
    },
  }, {
    confirmToken: plan.confirmationToken ?? "",
    manifestPath,
    sourceSkill,
    async skillsShHttpClient({ url }) {
      httpRequests.push(url.toString());
      return {
        statusCode: 200,
        body: JSON.stringify({
          files: [
            { path: "display-skill/SKILL.md", contents: "# Display Skill\n\nInstalled from skills.sh download." },
            { path: "display-skill/assets/example.txt", contents: "asset" },
          ],
        }),
      };
    },
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(httpRequests, ["https://skills.sh/api/download/owner/repo/display-skill"]);
  assert.equal(existsSync(join(localRoot, "display-skill")), true);
  assert.match(readFileSync(join(localRoot, "display-skill", "SKILL.md"), "utf-8"), /Installed from skills\.sh download/u);
  assert.equal(readFileSync(join(localRoot, "display-skill", "assets", "example.txt"), "utf-8"), "asset");
  const manifest = loadManifest(manifestPath);
  assert.equal(manifest.skills["display-skill"]?.sourceId, "owner/repo@display-skill");
  assert.equal(manifest.skills["display-skill"]?.provider, "skills-sh");
  assert.equal(manifest.skills["display-skill"]?.sourceOwner, "owner");
  assert.equal(manifest.skills["display-skill"]?.sourceRepository, "repo");
  assert.equal(manifest.skills["display-skill"]?.skillPath, "display-skill");
  assert.equal(manifest.skills["display-skill"]?.sourceTransport, "api");
});

test("path safety rejects Windows reserved basenames and trailing spaces or dots", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hub-path-safety-"));
  for (const name of ["CON", "con.txt", "NUL", "COM1", "LPT9", "skill.", "skill "]) {
    const result = resolveSafeLocalSkillPath(root, name);
    assert.equal(result.ok, false, name);
  }
});

test("path key normalization is case-insensitive only for Windows keys", () => {
  const mixedPath = join(tmpdir(), "SkillHubCasePath");
  assert.equal(normalizePathForKey(mixedPath, "win32"), normalizePathForKey(mixedPath.toUpperCase(), "win32"));
  assert.notEqual(normalizePathForKey(mixedPath, "linux"), normalizePathForKey(mixedPath.toUpperCase(), "linux"));
});
