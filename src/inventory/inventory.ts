import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SkillHubConfig } from "../config/config.js";
import { computeSkillFingerprint, fingerprintsEqual } from "./fingerprint.js";
import type {
  DriftStatus,
  InventoryItem,
  InventorySnapshot,
  ProvenanceEntry,
  ProvenanceManifest,
  SkillClassification,
  SkillMetadata,
  SkillRootType,
} from "../types.js";
import { isPathInside, normalizePathForKey } from "../utils/path-utils.js";

function listDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const stat = statSync(root);
  if (!stat.isDirectory()) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

function readMetadata(skillPath: string): SkillMetadata {
  const skillFilePath = join(skillPath, "SKILL.md");
  if (!existsSync(skillFilePath)) {
    return {
      name: basename(skillPath),
      description: "No SKILL.md found.",
      hasSkillFile: false,
    };
  }

  const content = readFileSync(skillFilePath, "utf-8");
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim();
  const description = lines.find((line) => line.length > 0 && !line.startsWith("#")) ?? "No description provided.";

  return {
    name: heading && heading.length > 0 ? heading : basename(skillPath),
    description,
    hasSkillFile: true,
  };
}

function findManifestEntryByPath(manifest: ProvenanceManifest, skillPath: string): ProvenanceEntry | undefined {
  const normalized = normalizePathForKey(skillPath);
  return Object.values(manifest.skills).find((entry) => normalizePathForKey(entry.localPath) === normalized);
}

function classifyLocalSkill(
  manifestEntry: ProvenanceEntry | undefined,
  fingerprint: ReturnType<typeof computeSkillFingerprint>,
): { classification: SkillClassification; driftStatus: DriftStatus } {
  if (!manifestEntry) {
    return { classification: "unknown", driftStatus: "untracked" };
  }

  return {
    classification: manifestEntry.provenance === "adopted" ? "adopted" : "managed",
    driftStatus: fingerprintsEqual(fingerprint, manifestEntry.fingerprint) ? "clean" : "drifted",
  };
}

function buildItem(
  skillPath: string,
  rootType: SkillRootType,
  manifest: ProvenanceManifest,
): InventoryItem {
  const resolvedPath = resolve(skillPath);
  const metadata = readMetadata(resolvedPath);
  const manifestEntry = findManifestEntryByPath(manifest, resolvedPath);

  if (rootType === "external") {
    return {
      name: basename(resolvedPath),
      path: resolvedPath,
      rootType,
      classification: "external",
      driftStatus: "external",
      metadata,
      manifestEntry,
    };
  }

  const fingerprint = computeSkillFingerprint(resolvedPath);
  const classified = classifyLocalSkill(manifestEntry, fingerprint);
  return {
    name: basename(resolvedPath),
    path: resolvedPath,
    rootType,
    classification: classified.classification,
    driftStatus: classified.driftStatus,
    metadata,
    fingerprint,
    manifestEntry,
  };
}

function buildMissingManifestItems(config: SkillHubConfig, manifest: ProvenanceManifest, knownPaths: Set<string>): InventoryItem[] {
  return Object.values(manifest.skills)
    .filter((entry) => !knownPaths.has(normalizePathForKey(entry.localPath)))
    .map((entry) => ({
      name: entry.name,
      path: resolve(entry.localPath),
      rootType: isPathInside(entry.localPath, config.localSkillRoot) ? "local" : "external",
      classification: "missing",
      driftStatus: "missing",
      metadata: {
        name: entry.name,
        description: "Manifest entry points to a missing directory.",
        hasSkillFile: false,
      },
      manifestEntry: entry,
    }));
}

export function collectInventory(config: SkillHubConfig, manifest: ProvenanceManifest): InventorySnapshot {
  const localRoot = resolve(config.localSkillRoot);
  const externalRoots = config.externalSkillRoots.map((item) => resolve(item));
  const items: InventoryItem[] = [];

  for (const skillPath of listDirectories(localRoot)) {
    items.push(buildItem(skillPath, "local", manifest));
  }

  for (const externalRoot of externalRoots) {
    for (const skillPath of listDirectories(externalRoot)) {
      items.push(buildItem(skillPath, "external", manifest));
    }
  }

  const knownPaths = new Set(items.map((item) => normalizePathForKey(item.path)));
  const manifestOnlyMissing = buildMissingManifestItems(config, manifest, knownPaths);

  return {
    localRoot,
    externalRoots,
    items: [...items, ...manifestOnlyMissing].sort((left, right) => left.name.localeCompare(right.name)),
    manifestOnlyMissing,
  };
}

export function findInventoryItem(snapshot: InventorySnapshot, nameOrPath: string): InventoryItem | undefined {
  const normalizedQuery = nameOrPath.trim().toLowerCase();
  const normalizedPath = normalizePathForKey(nameOrPath);
  return snapshot.items.find(
    (item) => item.name.toLowerCase() === normalizedQuery || item.metadata.name.toLowerCase() === normalizedQuery || normalizePathForKey(item.path) === normalizedPath,
  );
}
