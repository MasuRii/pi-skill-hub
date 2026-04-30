import { request } from "node:https";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { SkillHubConfig } from "../config/config.js";
import { computeSkillFingerprint } from "../inventory/fingerprint.js";
import type { InventoryItem, ProvenanceEntry, ProviderId, StagedProviderContent } from "../types.js";
import { parseSkillsShReference } from "../providers/skills-sh-identifiers.js";
import { stageSkillsShSkillDirectory } from "../providers/skills-sh-download.js";
import { SkillHubError } from "../utils/errors.js";
import { parseGithubSourceUrl, type GithubSource } from "../utils/source-reference.js";
import { githubRequestHeaders, formatGithubHttpError } from "../utils/github-http.js";
import { isPathInside } from "../utils/path-utils.js";
import { diffDirectories } from "./file-diff.js";

interface GithubRepoSource extends GithubSource {
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

function requestText(url: URL, timeoutMs: number, githubApiKey?: string | undefined): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: githubRequestHeaders(url, "application/vnd.github+json, text/plain;q=0.9, */*;q=0.8", USER_AGENT, githubApiKey),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const statusCode = res.statusCode ?? 500;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new SkillHubError(formatGithubHttpError(url, statusCode, body, res.headers, githubApiKey)));
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

async function requestJson<T>(url: URL, timeoutMs: number, githubApiKey?: string | undefined): Promise<T> {
  const text = await requestText(url, timeoutMs, githubApiKey);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SkillHubError(`Remote provider returned invalid JSON for ${url.hostname}${url.pathname}.`);
  }
}

function githubSourceForEntry(entry: ProvenanceEntry): GithubRepoSource | undefined {
  if (!entry.provider || !entry.sourceId || entry.provider === "skills-sh") {
    return undefined;
  }

  const github = parseGithubSourceUrl(entry.sourceUrl) ?? parseGithubSourceUrl(entry.sourceId);
  if (!github || !SAFE_SEGMENT_PATTERN.test(entry.name)) {
    return undefined;
  }
  return { ...github, skill: entry.name };
}

function hasSkillsShSource(entry: ProvenanceEntry): boolean {
  return Boolean(entry.provider === "skills-sh" && (parseSkillsShReference(entry.sourceId) ?? parseSkillsShReference(entry.sourceUrl)));
}

async function fetchDefaultBranch(source: GithubRepoSource, timeoutMs: number, githubApiKey?: string | undefined): Promise<string> {
  const metadata = await requestJson<GithubRepoMetadata>(
    new URL(`https://api.github.com/repos/${source.owner}/${source.repo}`),
    timeoutMs,
    githubApiKey,
  );
  const branch = metadata.default_branch;
  if (!branch || branch.includes("..") || branch.includes("/") || branch.includes("\\")) {
    throw new SkillHubError(`GitHub repository ${source.owner}/${source.repo} did not expose a safe default branch.`);
  }
  return branch;
}

async function fetchTree(source: GithubRepoSource, branch: string, timeoutMs: number, githubApiKey?: string | undefined): Promise<GithubTreeItem[]> {
  const payload = await requestJson<GithubTreeResponse>(
    new URL(`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${branch}?recursive=1`),
    timeoutMs,
    githubApiKey,
  );
  if (!Array.isArray(payload.tree)) {
    throw new SkillHubError(`GitHub repository ${source.owner}/${source.repo} did not expose a file tree.`);
  }
  return payload.tree.filter((item) => item.type === "blob" && typeof item.path === "string");
}

function candidateRoots(skill: string): string[] {
  return [skill, `skills/${skill}`, `.agents/skills/${skill}`, `.pi/agent/skills/${skill}`];
}

function hasTreeRoot(tree: readonly GithubTreeItem[], root: string): boolean {
  return tree.some((item) => item.path === `${root}/SKILL.md` || item.path?.startsWith(`${root}/`));
}

function selectSkillRoot(tree: readonly GithubTreeItem[], source: GithubRepoSource): string {
  const explicitRoot = source.pathSegments.join("/");
  if (explicitRoot.length > 0) {
    if (hasTreeRoot(tree, explicitRoot)) {
      return explicitRoot;
    }
    throw new SkillHubError(`Provider metadata did not include the linked skill directory '${explicitRoot}' in ${source.owner}/${source.repo}.`);
  }

  for (const root of candidateRoots(source.skill)) {
    if (hasTreeRoot(tree, root)) {
      return root;
    }
  }
  throw new SkillHubError(`Provider metadata did not identify a full skill directory for '${source.skill}'.`);
}

function safeStageFilePath(stagingPath: string, relativePath: string): string {
  const targetPath = resolve(stagingPath, relativePath);
  if (!isPathInside(targetPath, stagingPath)) {
    throw new SkillHubError(`Provider returned an unsafe file path: ${relativePath}`);
  }
  return targetPath;
}

async function writeGithubFile(source: GithubRepoSource, branch: string, remotePath: string, localPath: string, timeoutMs: number, githubApiKey?: string | undefined): Promise<void> {
  const encodedPath = remotePath.split("/").map(encodeURIComponent).join("/");
  const content = await requestText(
    new URL(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(branch)}/${encodedPath}`),
    timeoutMs,
    githubApiKey,
  );
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, content, "utf-8");
}

async function stageGithubSkillDirectory(source: GithubRepoSource, stagingPath: string, timeoutMs: number, githubApiKey?: string | undefined): Promise<void> {
  const branch = source.branch ?? await fetchDefaultBranch(source, timeoutMs, githubApiKey);
  const tree = await fetchTree(source, branch, timeoutMs, githubApiKey);
  const root = selectSkillRoot(tree, source);
  const files = tree
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path?.startsWith(`${root}/`)));

  if (files.length === 0) {
    throw new SkillHubError(`No files were available from provider source ${source.owner}/${source.repo}/${root}.`);
  }

  await Promise.all(files.map(async (remotePath) => {
    const relativePath = relative(root, remotePath).replace(/\\/g, "/");
    await writeGithubFile(source, branch, remotePath, safeStageFilePath(stagingPath, relativePath), timeoutMs, githubApiKey);
  }));
}

export function hasReliableProviderMetadata(entry: ProvenanceEntry | undefined): entry is ProvenanceEntry & { provider: ProviderId; sourceId: string } {
  if (!entry?.provider || !entry.sourceId) {
    return false;
  }
  return hasSkillsShSource(entry) || Boolean(githubSourceForEntry(entry));
}

export async function stageProviderContent(item: InventoryItem, config: SkillHubConfig): Promise<StagedProviderContent> {
  const entry = item.manifestEntry;
  if (!hasReliableProviderMetadata(entry)) {
    throw new SkillHubError("Stored manifest provenance does not include reliable provider/source metadata.");
  }

  const skillsShSource = entry.provider === "skills-sh" ? parseSkillsShReference(entry.sourceId) ?? parseSkillsShReference(entry.sourceUrl) : undefined;
  const githubSource = skillsShSource ? undefined : githubSourceForEntry(entry);
  if (!skillsShSource && !githubSource) {
    throw new SkillHubError("Stored provider metadata cannot be resolved to a safe upstream content source.");
  }

  mkdirSync(config.updateStagingRoot, { recursive: true });
  const stagingPath = join(config.updateStagingRoot, `${item.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(stagingPath, { recursive: true });
  try {
    if (skillsShSource) {
      await stageSkillsShSkillDirectory(skillsShSource, stagingPath, config.requestTimeoutMs, undefined, config.skillsSh);
    } else if (githubSource) {
      await stageGithubSkillDirectory(githubSource, stagingPath, config.requestTimeoutMs, config.apiKeys.github);
    }
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
