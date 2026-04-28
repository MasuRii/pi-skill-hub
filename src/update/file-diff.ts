import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { UpdateDiffSummary } from "../types.js";

interface FileDigest {
  path: string;
  digest: string;
}

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

function collectDigests(root: string, current: string, digests: Map<string, string>): void {
  if (!existsSync(current)) {
    return;
  }
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        collectDigests(root, absolutePath, digests);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const hash = createHash("sha256");
    hash.update(readFileSync(absolutePath));
    digests.set(relative(root, absolutePath).replace(/\\/g, "/"), hash.digest("hex"));
  }
}

function readFileDigestMap(root: string): Map<string, string> {
  const stat = statSync(root);
  if (!stat.isDirectory()) {
    throw new Error(`Cannot diff non-directory path: ${root}`);
  }
  const digests = new Map<string, string>();
  collectDigests(root, root, digests);
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
