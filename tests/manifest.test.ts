import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest, saveManifest, upsertManifestEntry } from "../src/manifest/manifest-store.js";
import type { ProvenanceEntry, ProvenanceManifest } from "../src/types.js";

const fingerprint = { algorithm: "sha256" as const, digest: "abc", fileCount: 1, totalBytes: 3 };

test("manifest persists provenance entries atomically", () => {
  const path = join(mkdtempSync(join(tmpdir(), "skill-hub-manifest-")), "provenance.json");
  const manifest: ProvenanceManifest = { version: 1, updatedAt: new Date().toISOString(), skills: {} };
  const entry: ProvenanceEntry = {
    name: "sample",
    localPath: join(tmpdir(), "sample"),
    provenance: "adopted",
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fingerprint,
  };

  saveManifest(upsertManifestEntry(manifest, entry), path);
  const loaded = loadManifest(path);
  assert.deepEqual(loaded.skills.sample?.fingerprint, fingerprint);
  assert.equal(loaded.skills.sample?.provenance, "adopted");
});

test("missing manifest loads as empty manifest", () => {
  const path = join(mkdtempSync(join(tmpdir(), "skill-hub-empty-manifest-")), "missing.json");
  const loaded = loadManifest(path);
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.skills, {});
});
