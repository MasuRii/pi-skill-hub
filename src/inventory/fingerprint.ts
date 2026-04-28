import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SkillFingerprint } from "../types.js";
import { SkillHubError } from "../utils/errors.js";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

interface FingerprintFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

function collectFiles(root: string, current: string, files: FingerprintFile[]): void {
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        collectFiles(root, absolutePath, files);
      }
      continue;
    }

    if (entry.isFile()) {
      const stat = statSync(absolutePath);
      files.push({ absolutePath, relativePath: relative(root, absolutePath).replace(/\\/g, "/"), size: stat.size });
    }
  }
}

export function computeSkillFingerprint(skillPath: string): SkillFingerprint {
  if (!existsSync(skillPath)) {
    throw new SkillHubError(`Cannot fingerprint missing skill path: ${skillPath}`);
  }

  const stat = statSync(skillPath);
  if (!stat.isDirectory()) {
    throw new SkillHubError(`Cannot fingerprint non-directory skill path: ${skillPath}`);
  }

  const files: FingerprintFile[] = [];
  collectFiles(skillPath, skillPath, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    const content = readFileSync(file.absolutePath);
    totalBytes += file.size;
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return {
    algorithm: "sha256",
    digest: hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
  };
}

export function fingerprintsEqual(left: SkillFingerprint | undefined, right: SkillFingerprint | undefined): boolean {
  return Boolean(left && right && left.algorithm === right.algorithm && left.digest === right.digest);
}
