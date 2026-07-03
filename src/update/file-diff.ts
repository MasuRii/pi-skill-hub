import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { UpdateDiffSummary } from "../types.js";
import { walkSkillFiles } from "../utils/file-traversal.js";

interface FileDigest {
  path: string;
  digest: string;
}

function readFileDigestMap(root: string): Map<string, string> {
  const stat = statSync(root);
  if (!stat.isDirectory()) {
    throw new Error(`Cannot diff non-directory path: ${root}`);
  }
  const digests = new Map<string, string>();
  for (const entry of walkSkillFiles(root)) {
    const hash = createHash("sha256");
    hash.update(readFileSync(entry.absolutePath));
    digests.set(entry.relativePath, hash.digest("hex"));
  }
  return digests;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function diffDirectories(localPath: string, upstreamPath: string): UpdateDiffSummary {
  const local = readFileDigestMap(localPath);
  const upstream = readFileDigestMap(upstreamPath);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [path, digest] of upstream.entries()) {
    const localDigest = local.get(path);
    if (localDigest === undefined) {
      added.push(path);
      continue;
    }
    if (localDigest !== digest) {
      changed.push(path);
    }
  }

  for (const path of local.keys()) {
    if (!upstream.has(path)) {
      removed.push(path);
    }
  }

  return {
    added: sorted(added),
    removed: sorted(removed),
    changed: sorted(changed),
  };
}

export function hasDiff(diff: UpdateDiffSummary): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

export function summarizeDiff(diff: UpdateDiffSummary): string {
  return `${String(diff.added.length)} added, ${String(diff.changed.length)} changed, ${String(diff.removed.length)} removed`;
}
