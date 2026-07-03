import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { SkillFingerprint } from "../types.js";
import { SkillHubError } from "../utils/errors.js";
import { walkSkillFiles } from "../utils/file-traversal.js";

interface FingerprintFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

export function computeSkillFingerprint(skillPath: string): SkillFingerprint {
  if (!existsSync(skillPath)) {
    throw new SkillHubError(`Cannot fingerprint missing skill path: ${skillPath}`);
  }

  const stat = statSync(skillPath);
  if (!stat.isDirectory()) {
    throw new SkillHubError(`Cannot fingerprint non-directory skill path: ${skillPath}`);
  }

  const files: FingerprintFile[] = walkSkillFiles(skillPath).map((entry) => ({
    ...entry,
    size: statSync(entry.absolutePath).size,
  }));
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
