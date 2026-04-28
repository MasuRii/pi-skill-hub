import { request } from "node:https";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { SkillHubConfig } from "../config/config.js";
import { computeSkillFingerprint } from "../inventory/fingerprint.js";
import type { InventoryItem, ProvenanceEntry, ProviderId, StagedProviderContent } from "../types.js";
import { SkillHubError } from "../utils/errors.js";
import { isPathInside } from "../utils/path-utils.js";
import { diffDirectories } from "./file-diff.js";

interface SkillsShSource {
  owner: string;
  repo: string;
  skill: string;
}

interface GithubRepoSource {
  owner: string;
  repo: string;
  skill: string;
}

interface GithubTreeItem {
  path?: string;
  type?: string;
}

interface GithubRepoMetadata {
  default_branch?: string;
}

interface GithubTreeResponse {
  tree?: GithubTreeItem[];
}

const USER_AGENT = "pi-skill-hub/0.1.0";
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

function requestText(url: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json, text/plain;q=0.9, */*;q=0.8",
          "user-agent": USER_AGENT,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const statusCode = res.statusCode ?? 500;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new SkillHubError(`Remote request failed with HTTP ${String(statusCode)} for ${url.hostname}${url.pathname}.`));
            return;
          }
          resolvePromise(body);
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new SkillHubError(`Remote request timed out after ${String(timeoutMs)}ms for ${url.hostname}${url.pathname}.`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function requestJson<T>(url: URL, timeoutMs: number): Promise<T> {
  const text = await requestText(url, timeoutMs);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SkillHubError(`Remote provider returned invalid JSON for ${url.hostname}${url.pathname}.`);
  }
}

function parseSkillsShSource(sourceId: string): SkillsShSource | undefined {
  const [repoPart, skill] = sourceId.split("@");
  const [owner, repo] = repoPart?.split("/") ?? [];
  if (!owner || !repo || !skill) {
    return undefined;
  }
  if (![owner, repo, skill].every((segment) => SAFE_SEGMENT_PATTERN.test(segment))) {
    return undefined;
  }
  return { owner, repo, skill };
}

function parseGithubUrl(value: string | undefined): { owner: string; repo: string } | undefined {
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hostname !== "github.com") {
    return undefined;
  }
  const [owner, repoWithSuffix] = url.pathname.split("/").filter(Boolean);
  const repo = repoWithSuffix?.replace(/\.git$/u, "");
  if (!owner || !repo || !SAFE_SEGMENT_PATTERN.test(owner) || !SAFE_SEGMENT_PATTERN.test(repo)) {
    return undefined;
  }
  return { owner, repo };
}

function githubSourceForEntry(entry: ProvenanceEntry): GithubRepoSource | undefined {
  if (!entry.provider || !entry.sourceId) {
    return undefined;
  }

  if (entry.provider === "skills-sh") {
    return parseSkillsShSource(entry.sourceId);
  }

  const github = parseGithubUrl(entry.sourceUrl) ?? parseGithubUrl(entry.sourceId);
  if (!github || !SAFE_SEGMENT_PATTERN.test(entry.name)) {
    return undefined;
  }
  return { ...github, skill: entry.name };
}

async function fetchDefaultBranch(source: GithubRepoSource, timeoutMs: number): Promise<string> {
  const metadata = await requestJson<GithubRepoMetadata>(
    new URL(`https://api.github.com/repos/${source.owner}/${source.repo}`),
    timeoutMs,
  );
  const branch = metadata.default_branch;
  if (!branch || branch.includes("..") || branch.includes("/") || branch.includes("\\")) {
    throw new SkillHubError(`GitHub repository ${source.owner}/${source.repo} did not expose a safe default branch.`);
  }
  return branch;
}

async function fetchTree(source: GithubRepoSource, branch: string, timeoutMs: number): Promise<GithubTreeItem[]> {
  const payload = await requestJson<GithubTreeResponse>(
    new URL(`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${branch}?recursive=1`),
    timeoutMs,
  );
  if (!Array.isArray(payload.tree)) {
    throw new SkillHubError(`GitHub repository ${source.owner}/${source.repo} did not expose a file tree.`);
  }
  return payload.tree.filter((item) => item.type === "blob" && typeof item.path === "string");
}

function candidateRoots(skill: string): string[] {
  return [skill, `skills/${skill}`, `.agents/skills/${skill}`, `.pi/agent/skills/${skill}`];
}

function selectSkillRoot(tree: readonly GithubTreeItem[], skill: string): string {
  for (const root of candidateRoots(skill)) {
    if (tree.some((item) => item.path === `${root}/SKILL.md` || item.path?.startsWith(`${root}/`))) {
      return root;
    }
  }
  throw new SkillHubError(`Provider metadata did not identify a full skill directory for '${skill}'.`);
}

function safeStageFilePath(stagingPath: string, relativePath: string): string {
  const targetPath = resolve(stagingPath, relativePath);
  if (!isPathInside(targetPath, stagingPath)) {
    throw new SkillHubError(`Provider returned an unsafe file path: ${relativePath}`);
  }
  return targetPath;
}

async function writeGithubFile(source: GithubRepoSource, branch: string, remotePath: string, localPath: string, timeoutMs: number): Promise<void> {
  const encodedPath = remotePath.split("/").map(encodeURIComponent).join("/");
  const content = await requestText(
    new URL(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(branch)}/${encodedPath}`),
    timeoutMs,
  );
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, content, "utf-8");
}

async function stageGithubSkillDirectory(source: GithubRepoSource, stagingPath: string, timeoutMs: number): Promise<void> {
  const branch = await fetchDefaultBranch(source, timeoutMs);
  const tree = await fetchTree(source, branch, timeoutMs);
  const root = selectSkillRoot(tree, source.skill);
  const files = tree
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path?.startsWith(`${root}/`)));

  if (files.length === 0) {
    throw new SkillHubError(`No files were available from provider source ${source.owner}/${source.repo}/${root}.`);
  }

  await Promise.all(files.map(async (remotePath) => {
    const relativePath = relative(root, remotePath).replace(/\\/g, "/");
    await writeGithubFile(source, branch, remotePath, safeStageFilePath(stagingPath, relativePath), timeoutMs);
  }));
}

export function hasReliableProviderMetadata(entry: ProvenanceEntry | undefined): entry is ProvenanceEntry & { provider: ProviderId; sourceId: string } {
  return Boolean(entry?.provider && entry.sourceId && githubSourceForEntry(entry));
}

export async function stageProviderContent(item: InventoryItem, config: SkillHubConfig): Promise<StagedProviderContent> {
  const entry = item.manifestEntry;
  if (!hasReliableProviderMetadata(entry)) {
    throw new SkillHubError("Stored manifest provenance does not include reliable provider/source metadata.");
  }

  const source = githubSourceForEntry(entry);
  if (!source) {
    throw new SkillHubError("Stored provider metadata cannot be resolved to a safe upstream content source.");
  }

  mkdirSync(config.updateStagingRoot, { recursive: true });
  const stagingPath = join(config.updateStagingRoot, `${item.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stagingPath, { recursive: true });
  try {
    await stageGithubSkillDirectory(source, stagingPath, config.requestTimeoutMs);
    const fingerprint = computeSkillFingerprint(stagingPath);
    return {
      provider: entry.provider,
      sourceId: entry.sourceId,
      stagingPath,
      fingerprint,
      diff: diffDirectories(item.path, stagingPath),
    };
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}
