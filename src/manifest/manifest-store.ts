import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MANIFEST_PATH, MANIFEST_VERSION } from "../constants.js";
import type { ProvenanceEntry, ProvenanceManifest, SkillFingerprint } from "../types.js";
import { getErrorMessage, ManifestValidationError } from "../utils/errors.js";

function emptyManifest(): ProvenanceManifest {
  return {
    version: MANIFEST_VERSION,
    updatedAt: new Date(0).toISOString(),
    skills: {},
  };
}

function isFingerprint(value: unknown): value is SkillFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.algorithm === "sha256" &&
    typeof record.digest === "string" &&
    typeof record.fileCount === "number" &&
    typeof record.totalBytes === "number"
  );
}

function isEntry(value: unknown): value is ProvenanceEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const provenance = record.provenance;
  return (
    typeof record.name === "string" &&
    typeof record.localPath === "string" &&
    (provenance === "installed" || provenance === "adopted") &&
    typeof record.installedAt === "string" &&
    typeof record.updatedAt === "string" &&
    isFingerprint(record.fingerprint)
  );
}

export function validateManifest(value: unknown): ProvenanceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestValidationError("Provenance manifest must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  if (record.version !== MANIFEST_VERSION) {
    throw new ManifestValidationError(`Unsupported provenance manifest version: ${String(record.version)}.`);
  }
  if (typeof record.updatedAt !== "string") {
    throw new ManifestValidationError("Provenance manifest updatedAt must be a string.");
  }
  if (!record.skills || typeof record.skills !== "object" || Array.isArray(record.skills)) {
    throw new ManifestValidationError("Provenance manifest skills must be an object.");
  }

  const skills: Record<string, ProvenanceEntry> = {};
  for (const [key, entry] of Object.entries(record.skills as Record<string, unknown>)) {
    if (!isEntry(entry)) {
      throw new ManifestValidationError(`Invalid provenance entry for ${key}.`);
    }
    skills[key] = entry;
  }

  return {
    version: MANIFEST_VERSION,
    updatedAt: record.updatedAt,
    skills,
  };
}

export function loadManifest(pathValue = MANIFEST_PATH): ProvenanceManifest {
  if (!existsSync(pathValue)) {
    return emptyManifest();
  }

  try {
    return validateManifest(JSON.parse(readFileSync(pathValue, "utf-8")) as unknown);
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      throw error;
    }
    throw new ManifestValidationError(`Unable to read provenance manifest: ${getErrorMessage(error)}`);
  }
}

export function saveManifest(manifest: ProvenanceManifest, pathValue = MANIFEST_PATH): void {
  const nextManifest: ProvenanceManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
  };
  validateManifest(nextManifest);

  mkdirSync(dirname(pathValue), { recursive: true });
  const temporaryPath = `${pathValue}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf-8");
  renameSync(temporaryPath, pathValue);
}

export function upsertManifestEntry(
  manifest: ProvenanceManifest,
  entry: ProvenanceEntry,
): ProvenanceManifest {
  return {
    version: MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    skills: {
      ...manifest.skills,
      [entry.name]: entry,
    },
  };
}

export function removeManifestEntry(manifest: ProvenanceManifest, skillName: string): ProvenanceManifest {
  const nextSkills = { ...manifest.skills };
  delete nextSkills[skillName];
  return {
    version: MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    skills: nextSkills,
  };
}
