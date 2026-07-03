import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Directory names excluded from skill fingerprinting and diff traversal.
 * Shared by {@link computeSkillFingerprint} (inventory/fingerprint.ts) and
 * {@link diffDirectories} (update/file-diff.ts) to avoid duplicating the
 * exclusion set across the two independent directory-walk implementations.
 */
export const EXCLUDED_SKILL_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface SkillFileEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/**
 * Recursively walk a skill directory and return its files (excluding
 * {@link EXCLUDED_SKILL_DIRECTORIES}). Each entry carries both the absolute
 * path and the path relative to `root` normalized to forward slashes.
 *
 * Consolidates the recursive `readdirSync` + exclusion + path-normalization
 * walk that was duplicated between fingerprinting and directory diffing.
 */
export function walkSkillFiles(root: string, current: string = root): SkillFileEntry[] {
  const entries: SkillFileEntry[] = [];
  for (const dirent of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = join(current, dirent.name);
    if (dirent.isDirectory()) {
      if (!EXCLUDED_SKILL_DIRECTORIES.has(dirent.name)) {
        entries.push(...walkSkillFiles(root, absolutePath));
      }
      continue;
    }
    if (dirent.isFile()) {
      entries.push({ absolutePath, relativePath: relative(root, absolutePath).replace(/\\/g, "/") });
    }
  }
  return entries;
}
