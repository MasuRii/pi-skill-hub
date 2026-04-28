import { request } from "node:https";
import type {
  SkillContentPreview,
  SkillPreviewAudit,
  SkillPreviewAuditStatus,
  SkillPreviewMetadata,
  SkillSearchResult,
} from "../types.js";
import { sanitizeTerminalText } from "../utils/terminal-text.js";

const USER_AGENT = "pi-skill-hub/0.1.0";
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const PREVIEW_TIMEOUT_MS = 8_000;
const AUDIT_LABELS = ["Agent Trust Hub", "Socket", "Snyk"] as const;

interface SkillsShSource {
  owner: string;
  repo: string;
  skill: string;
}

interface GithubSkillMarkdownSource {
  owner: string;
  repo: string;
  branch: string;
  skillPath: string[];
}

interface PreviewHttpRequest {
  url: URL;
  accept: string;
  timeoutMs: number;
}

interface PreviewHttpResponse {
  statusCode: number;
  body: string;
}

export type PreviewHttpClient = (request: PreviewHttpRequest) => Promise<PreviewHttpResponse>;

interface SkillsShDownloadFile {
  path?: string;
  name?: string;
  contents?: string;
  content?: string;
  data?: string;
}

interface SkillsShDownloadPayload {
  files?: SkillsShDownloadFile[];
}

function parseCompactNumber(value: string): number | undefined {
  const normalized = value.trim().replace(/,/gu, "").toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/u);
  if (!match) {
    const parsed = Number.parseInt(normalized.replace(/[^\d]/gu, ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  const amount = Number.parseFloat(match[1] ?? "0");
  const suffix = match[2];
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Math.round(amount * multiplier);
}

function metadataStatus(metadata: Omit<SkillPreviewMetadata, "status">): SkillPreviewMetadata["status"] {
  const hasStars = metadata.githubStars !== undefined;
  const hasAudits = metadata.securityAudits.length > 0;
  if (hasStars && hasAudits) {
    return "available";
  }
  if (hasStars || hasAudits) {
    return "partial";
  }
  return "unavailable";
}

function createPreviewMetadata(metadata: Omit<SkillPreviewMetadata, "status">): SkillPreviewMetadata {
  return { ...metadata, status: metadataStatus(metadata) };
}

function unavailableMetadata(skill: SkillSearchResult): SkillPreviewMetadata {
  return createPreviewMetadata({ provider: skill.provider, securityAudits: [] });
}

function metadataPreview(skill: SkillSearchResult, limitation: string, metadata = unavailableMetadata(skill)): SkillContentPreview {
  const source = skill.sourceUrl ? `\nSource: ${skill.sourceUrl}` : "";
  const github = skill.githubUrl && skill.githubUrl !== skill.sourceUrl ? `\nGitHub: ${skill.githubUrl}` : "";
  return {
    title: skill.name,
    body: `${skill.description}\n\nProvider: ${skill.provider}\nPopularity: ${String(skill.popularity)}${source}${github}`,
    source: "metadata",
    limitation,
    metadata,
  };
}

function safeSegments(...segments: string[]): boolean {
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && SAFE_SEGMENT_PATTERN.test(segment));
}

function sourceFromIdentifier(identifier: string): SkillsShSource | undefined {
  const identifierParts = identifier.split("@");
  if (identifierParts.length !== 2) {
    return undefined;
  }
  const [repoPart, skill] = identifierParts;
  const repoParts = repoPart?.split("/") ?? [];
  if (repoParts.length !== 2) {
    return undefined;
  }
  const [owner, repo] = repoParts;
  if (!owner || !repo || !skill || !safeSegments(owner, repo, skill)) {
    return undefined;
  }
  return { owner, repo, skill };
}

function sourceFromUrl(urlValue: string | undefined): SkillsShSource | undefined {
  if (!urlValue) {
    return undefined;
  }
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.hostname !== "skills.sh") {
      return undefined;
    }
    const pathSegments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (pathSegments.length !== 3) {
      return undefined;
    }
    const [owner, repo, skill] = pathSegments;
    if (!owner || !repo || !skill || !safeSegments(owner, repo, skill)) {
      return undefined;
    }
    return { owner, repo, skill };
  } catch {
    return undefined;
  }
}

function parseSkillsShSource(skill: SkillSearchResult): SkillsShSource | undefined {
  return sourceFromIdentifier(skill.id) ?? sourceFromUrl(skill.sourceUrl);
}

function parseGithubTreeSkillSource(urlValue: string | undefined): GithubSkillMarkdownSource | undefined {
  if (!urlValue) {
    return undefined;
  }

  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return undefined;
    }

    const [owner, repoWithSuffix, treeSegment, branch, ...skillPath] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const repo = repoWithSuffix?.replace(/\.git$/u, "");
    if (treeSegment !== "tree" || !owner || !repo || !branch || !safeSegments(owner, repo, branch, ...skillPath)) {
      return undefined;
    }

    return { owner, repo, branch, skillPath };
  } catch {
    return undefined;
  }
}

function rawGithubSkillMarkdownUrl(source: GithubSkillMarkdownSource): URL {
  const encodedPath = [...source.skillPath, "SKILL.md"].map(encodeURIComponent).join("/");
  return new URL(
    `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(source.branch)}/${encodedPath}`,
  );
}

function canonicalSkillsShDetailUrl(source: SkillsShSource): URL {
  return new URL(`https://skills.sh/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(source.skill)}`);
}

function defaultHttpClient(requestOptions: PreviewHttpRequest): Promise<PreviewHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      requestOptions.url,
      {
        method: "GET",
        headers: {
          accept: requestOptions.accept,
          "user-agent": USER_AGENT,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf-8") });
        });
      },
    );
    req.setTimeout(requestOptions.timeoutMs, () => {
      req.destroy(new Error(`Preview request timed out after ${String(requestOptions.timeoutMs)}ms.`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function requestOptionalText(url: URL, accept: string, httpClient: PreviewHttpClient): Promise<string | undefined> {
  try {
    const response = await httpClient({ url, accept, timeoutMs: PREVIEW_TIMEOUT_MS });
    if (response.statusCode < 200 || response.statusCode >= 300 || response.body.trim().length === 0) {
      return undefined;
    }
    return response.body;
  } catch {
    return undefined;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function fileContent(file: SkillsShDownloadFile): string | undefined {
  if (typeof file.contents === "string") {
    return file.contents;
  }
  if (typeof file.content === "string") {
    return file.content;
  }
  if (typeof file.data === "string") {
    return file.data;
  }
  return undefined;
}

function isSkillMarkdownFile(file: SkillsShDownloadFile): boolean {
  const pathValue = file.path ?? file.name;
  const fileName = pathValue?.split(/[\\/]/u).pop()?.toLowerCase();
  return fileName === "skill.md";
}

function extractSkillMarkdown(payload: unknown): string | undefined {
  const download = payload && typeof payload === "object" ? (payload as SkillsShDownloadPayload) : undefined;
  const files = Array.isArray(download?.files) ? download.files : [];
  const skillFile = files.find(isSkillMarkdownFile);
  const content = skillFile ? fileContent(skillFile) : undefined;
  return content && content.trim().length > 0 ? content : undefined;
}

async function fetchSkillsShMarkdown(source: SkillsShSource, httpClient: PreviewHttpClient): Promise<string | undefined> {
  const url = new URL(
    `https://skills.sh/api/download/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(source.skill)}`,
  );
  const text = await requestOptionalText(url, "application/json", httpClient);
  if (!text) {
    return undefined;
  }
  return extractSkillMarkdown(parseJsonObject(text));
}

async function fetchGithubSkillMarkdown(source: GithubSkillMarkdownSource, httpClient: PreviewHttpClient): Promise<string | undefined> {
  const text = await requestOptionalText(rawGithubSkillMarkdownUrl(source), "text/markdown, text/plain;q=0.9, */*;q=0.8", httpClient);
  return text && text.trim().length > 0 ? text : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#39;/giu, "'")
    .replace(/&quot;/giu, '"');
}

function visibleTextFromHtml(html: string): string {
  return decodeEntities(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
}

export function parseGithubStarsFromText(text: string): number | undefined {
  const patterns = [
    /github\s+stars?\s*[:\-]?\s*([\d,.]+\s*[KMB]?)/iu,
    /([\d,.]+\s*[KMB]?)\s*(?:github\s+)?stars?\b/iu,
    /stargazers_count["'\s:]+([\d,.]+)/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const stars = match?.[1] ? parseCompactNumber(match[1].replace(/\s+/gu, "")) : undefined;
    if (stars !== undefined) {
      return stars;
    }
  }
  return undefined;
}

function normalizedAuditStatus(value: string): SkillPreviewAuditStatus {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("pass")) {
    return "pass";
  }
  if (normalized.startsWith("fail")) {
    return "fail";
  }
  if (normalized.startsWith("warn")) {
    return "warning";
  }
  return "unknown";
}

function escapedLabelPattern(label: string): string {
  return label.split(/\s+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+");
}

export function parseSecurityAuditsFromText(text: string): SkillPreviewAudit[] {
  const audits: SkillPreviewAudit[] = [];
  for (const label of AUDIT_LABELS) {
    const pattern = new RegExp(`${escapedLabelPattern(label)}.{0,80}?\\b(Pass(?:ed)?|Fail(?:ed)?|Warning|Unknown)\\b`, "iu");
    const match = text.match(pattern);
    if (match?.[1]) {
      audits.push({ label, status: normalizedAuditStatus(match[1]) });
    }
  }
  return audits;
}

export function parseSkillsShRenderedMetadata(html: string, provider: SkillSearchResult["provider"] = "skills-sh"): SkillPreviewMetadata {
  const text = visibleTextFromHtml(html);
  return createPreviewMetadata({
    provider,
    githubStars: parseGithubStarsFromText(text),
    securityAudits: parseSecurityAuditsFromText(text),
  });
}

async function fetchGithubStars(source: SkillsShSource, httpClient: PreviewHttpClient): Promise<number | undefined> {
  const text = await requestOptionalText(
    new URL(`https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`),
    "application/vnd.github+json",
    httpClient,
  );
  if (!text) {
    return undefined;
  }
  const parsed = parseJsonObject(text);
  const stars = parsed?.stargazers_count;
  return typeof stars === "number" && Number.isFinite(stars) ? stars : undefined;
}

async function fetchSkillsShMetadata(
  skill: SkillSearchResult,
  source: SkillsShSource,
  httpClient: PreviewHttpClient,
): Promise<SkillPreviewMetadata> {
  const html = await requestOptionalText(canonicalSkillsShDetailUrl(source), "text/html, */*;q=0.8", httpClient);
  const renderedMetadata = html ? parseSkillsShRenderedMetadata(html, skill.provider) : unavailableMetadata(skill);
  if (renderedMetadata.githubStars !== undefined) {
    return renderedMetadata;
  }

  const githubStars = await fetchGithubStars(source, httpClient);
  return createPreviewMetadata({
    provider: skill.provider,
    githubStars,
    securityAudits: renderedMetadata.securityAudits,
  });
}

export function buildMetadataPreview(skill: SkillSearchResult): SkillContentPreview {
  return metadataPreview(skill, "Full remote SKILL.md/README content is not safely exposed by this provider result.");
}

export async function buildRemotePreview(skill: SkillSearchResult, httpClient: PreviewHttpClient = defaultHttpClient): Promise<SkillContentPreview> {
  if (skill.provider === "skills-sh") {
    const source = parseSkillsShSource(skill);
    if (!source) {
      return buildMetadataPreview(skill);
    }

    const [markdown, metadata] = await Promise.all([
      fetchSkillsShMarkdown(source, httpClient),
      fetchSkillsShMetadata(skill, source, httpClient),
    ]);

    if (!markdown) {
      return metadataPreview(skill, "Remote SKILL.md was unavailable from skills.sh; showing provider metadata instead.", metadata);
    }

    return {
      title: skill.name,
      body: markdown,
      source: "remote",
      metadata,
    };
  }

  if (skill.provider === "skillsmp") {
    const source = parseGithubTreeSkillSource(skill.githubUrl);
    if (!source) {
      return buildMetadataPreview(skill);
    }

    const markdown = await fetchGithubSkillMarkdown(source, httpClient);
    if (!markdown) {
      return metadataPreview(skill, "Remote SKILL.md was unavailable from the safe GitHub source; showing provider metadata instead.");
    }

    return {
      title: skill.name,
      body: markdown,
      source: "remote",
      metadata: unavailableMetadata(skill),
    };
  }

  return buildMetadataPreview(skill);
}

function formatAuditStatus(audit: SkillPreviewAudit): string {
  return `${audit.label} ${audit.status}`;
}

export function formatPreviewMetadataTags(metadata: SkillPreviewMetadata): string {
  const stars = metadata.githubStars === undefined ? "GitHub stars: unavailable" : `GitHub stars: ${String(metadata.githubStars)}`;
  const audits = metadata.securityAudits.length > 0
    ? `Security audits: ${metadata.securityAudits.map(formatAuditStatus).join(", ")}`
    : "Security audits: unavailable";
  return [`Provider: ${metadata.provider}`, stars, audits, `Metadata: ${metadata.status}`].join(" | ");
}

export function formatPreview(preview: SkillContentPreview): string {
  const lines = [`Preview: ${preview.title}`, formatPreviewMetadataTags(preview.metadata), preview.body.trim()];
  if (preview.limitation) {
    lines.push(`Limitation: ${preview.limitation}`);
  }
  return sanitizeTerminalText(lines.join("\n\n"));
}
