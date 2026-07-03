import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectInventory } from "../src/inventory/inventory.js";
import { computeSkillFingerprint } from "../src/inventory/fingerprint.js";
import type { ProvenanceManifest } from "../src/types.js";
import { createFixtureRoots, createSkill, emptyManifest, fixtureConfig } from "./helpers.js";

test("inventory classifies managed, unknown, and external skills", () => {
  const { localRoot, externalRoot } = createFixtureRoots("inventory");
  const managedPath = createSkill(localRoot, "managed-skill");
  createSkill(localRoot, "custom-skill");
  createSkill(externalRoot, "external-skill");

  const manifest: ProvenanceManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: {
      "managed-skill": {
        name: "managed-skill",
        localPath: managedPath,
        provenance: "adopted",
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fingerprint: computeSkillFingerprint(managedPath),
      },
    },
  };

  const inventory = collectInventory(fixtureConfig(localRoot, externalRoot), manifest);
  assert.equal(inventory.items.find((item) => item.name === "managed-skill")?.classification, "adopted");
  assert.equal(inventory.items.find((item) => item.name === "managed-skill")?.driftStatus, "clean");
  assert.equal(inventory.items.find((item) => item.name === "custom-skill")?.classification, "unknown");
  assert.equal(inventory.items.find((item) => item.name === "external-skill")?.classification, "external");
});

test("inventory detects fingerprint drift for adopted skills", () => {
  const { localRoot, externalRoot } = createFixtureRoots("drift");
  const skillPath = createSkill(localRoot, "drift-skill");
  const fingerprint = computeSkillFingerprint(skillPath);
  writeFileSync(join(skillPath, "SKILL.md"), "# drift-skill\n\nChanged content\n", "utf-8");

  const manifest: ProvenanceManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    skills: {
      "drift-skill": {
        name: "drift-skill",
        localPath: skillPath,
        provenance: "adopted",
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fingerprint,
      },
    },
  };

  const inventory = collectInventory(fixtureConfig(localRoot, externalRoot), manifest);
  assert.equal(inventory.items.find((item) => item.name === "drift-skill")?.driftStatus, "drifted");
});
