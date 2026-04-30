import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
import type { SkillsShProviderConfig } from "../config/config.js";
import { SkillHubError } from "../utils/errors.js";
import { isPathInside } from "../utils/path-utils.js";
import type { SkillsShSource } from "./skills-sh-identifiers.js";

export interface SkillsShHttpRequest {
  url: URL;
  accept: string;
  timeoutMs: number;
  apiKey?: string | undefined;
}

export interface SkillsShHttpResponse {
  statusCode: number;
  body: string;
}

export type SkillsShHttpClient = (request: SkillsShHttpRequest) => Promise<SkillsShHttpResponse>;
export type SkillsShDownloadHttpClient = SkillsShHttpClient;

interface SkillsShDownloadFilePayload {
  path?: string;
  name?: string;
  contents?: string;
  content?: string;
  data?: string;
}

interface SkillsShDownloadPayload {
  files?: SkillsShDownloadFilePayload[];
}

export interface SkillsShDownloadedFile {
  relativePath: string;
  content: string;
}

export interface SkillsShContentOptions {
  timeoutMs: number;
  config?: Partial<Pick<SkillsShProviderConfig, "downloadBaseUrl" | "apiKey">> | undefined;
  httpClient?: SkillsShHttpClient | undefined;
}

const USER_AGENT = "pi-skill-hub/0.1.0";
const DEFAULT_DOWNLOAD_BASE_URL = "https://skills.sh";
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;

export function skillsShDownloadUrl(source: SkillsShSource, downloadBaseUrl = DEFAULT_DOWNLOAD_BASE_URL): URL {
  return new URL(
    `/api/download/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(source.skill)}`,
    downloadBaseUrl,
  );
}

function transportRequest(url: URL): typeof httpRequest {
  if (url.protocol === "http:") {
    return httpRequest;
  }
  if (url.protocol === "https:") {
    return httpsRequest;
  }
  throw new SkillHubError(`Unsupported skills.sh URL protocol: ${url.protocol}`);
}

export async function defaultSkillsShHttpClient(requestOptions: SkillsShHttpRequest): Promise<SkillsShHttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = {
      accept: requestOptions.accept,
      "user-agent": USER_AGENT,
    };
    if (requestOptions.apiKey) {
      headers.authorization = `Bearer ${requestOptions.apiKey}`;
    }

    const req = transportRequest(requestOptions.url)(
      requestOptions.url,
      {
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolvePromise({
            statusCode: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.setTimeout(requestOptions.timeoutMs, () => {
      req.destroy(new SkillHubError(`skills.sh request timed out after ${String(requestOptions.timeoutMs)}ms for ${requestOptions.url.hostname}${requestOptions.url.pathname}.`));
    });
    req.on("error", reject);
    req.end();
  });
}

export function parseSkillsShJsonObject(text: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SkillHubError(`skills.sh returned invalid JSON for ${sourceLabel}.`);
  }
}

function sourceLabel(source: SkillsShSource): string {
  return `${source.owner}/${source.repo}@${source.skill}`;
}

function fileContent(file: SkillsShDownloadFilePayload): string | undefined {
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

function filePath(file: SkillsShDownloadFilePayload): string | undefined {
  return file.path ?? file.name;
}

function safePathSegments(pathValue: string, source: SkillsShSource): string[] {
  const normalized = pathValue.replace(/\\/gu, "/");
  if (normalized.includes("\0") || normalized.startsWith("/") || WINDOWS_DRIVE_PREFIX_PATTERN.test(normalized)) {
    throw new SkillHubError(`skills.sh returned an unsafe file path for ${sourceLabel(source)}: ${pathValue}`);
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new SkillHubError(`skills.sh returned an unsafe file path for ${sourceLabel(source)}: ${pathValue}`);
  }
  return segments;
}

function hasSegmentPrefix(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => segments[index] === segment);
}

function selectSkillRoot(files: readonly SkillsShDownloadFilePayload[], source: SkillsShSource): string[] {
  for (const file of files) {
    const pathValue = filePath(file);
    if (!pathValue) {
      continue;
    }
    const segments = safePathSegments(pathValue, source);
    if (segments.at(-1)?.toLowerCase() === "skill.md") {
      return segments.slice(0, -1);
    }
  }
  throw new SkillHubError(`skills.sh download for ${sourceLabel(source)} did not include SKILL.md.`);
}

function relativePathForFile(file: SkillsShDownloadFilePayload, rootSegments: readonly string[], source: SkillsShSource): string | undefined {
  const pathValue = filePath(file);
  if (!pathValue) {
    throw new SkillHubError(`skills.sh download for ${sourceLabel(source)} included a file without a path.`);
  }

  const segments = safePathSegments(pathValue, source);
  if (!hasSegmentPrefix(segments, rootSegments)) {
    return undefined;
  }

  const relativeSegments = segments.slice(rootSegments.length);
  if (relativeSegments.length === 0) {
    return undefined;
  }
  return relativeSegments.join("/");
}

function downloadFiles(payload: unknown): SkillsShDownloadFilePayload[] {
  const download = payload && typeof payload === "object" ? (payload as SkillsShDownloadPayload) : undefined;
  return Array.isArray(download?.files) ? download.files : [];
}

export function extractSkillsShDownloadedFiles(payload: unknown, source: SkillsShSource): SkillsShDownloadedFile[] {
  const files = downloadFiles(payload);
  if (files.length === 0) {
    throw new SkillHubError(`skills.sh download for ${sourceLabel(source)} did not include any files.`);
  }

  const rootSegments = selectSkillRoot(files, source);
  const downloadedFiles: SkillsShDownloadedFile[] = [];
  for (const file of files) {
    const relativePath = relativePathForFile(file, rootSegments, source);
    if (!relativePath) {
      continue;
    }
    const content = fileContent(file);
    if (content === undefined) {
      throw new SkillHubError(`skills.sh download file ${relativePath} did not include string content.`);
    }
    downloadedFiles.push({ relativePath, content });
  }

  if (!downloadedFiles.some((file) => file.relativePath.toLowerCase() === "skill.md")) {
    throw new SkillHubError(`skills.sh download for ${sourceLabel(source)} did not include a root SKILL.md file.`);
  }
  return downloadedFiles;
}

export function extractSkillsShMarkdownFromPayload(payload: unknown, source: SkillsShSource): string | undefined {
  const skillFile = extractSkillsShDownloadedFiles(payload, source).find((file) => file.relativePath.toLowerCase() === "skill.md");
  const content = skillFile?.content;
  return content && content.trim().length > 0 ? content : undefined;
}

export async function downloadSkillsShSkillFiles(
  source: SkillsShSource,
  timeoutMs: number,
  httpClient: SkillsShHttpClient = defaultSkillsShHttpClient,
  config?: Partial<Pick<SkillsShProviderConfig, "downloadBaseUrl" | "apiKey">> | undefined,
): Promise<SkillsShDownloadedFile[]> {
  const response = await httpClient({
    url: skillsShDownloadUrl(source, config?.downloadBaseUrl),
    accept: "application/json",
    timeoutMs,
    apiKey: config?.apiKey,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new SkillHubError(`skills.sh download failed with HTTP ${String(response.statusCode)} for ${sourceLabel(source)}.`);
  }
  return extractSkillsShDownloadedFiles(parseSkillsShJsonObject(response.body, `download ${sourceLabel(source)}`), source);
}

export async function fetchSkillsShMarkdown(
  source: SkillsShSource,
  timeoutMs: number,
  httpClient: SkillsShHttpClient = defaultSkillsShHttpClient,
  config?: Partial<Pick<SkillsShProviderConfig, "downloadBaseUrl" | "apiKey">> | undefined,
): Promise<string | undefined> {
  const response = await httpClient({
    url: skillsShDownloadUrl(source, config?.downloadBaseUrl),
    accept: "application/json",
    timeoutMs,
    apiKey: config?.apiKey,
  });
  if (response.statusCode < 200 || response.statusCode >= 300 || response.body.trim().length === 0) {
    return undefined;
  }
  return extractSkillsShMarkdownFromPayload(parseSkillsShJsonObject(response.body, `download ${sourceLabel(source)}`), source);
}

function safeOutputPath(stagingPath: string, relativePath: string): string {
  const outputPath = resolve(stagingPath, relativePath);
  if (!isPathInside(outputPath, stagingPath)) {
    throw new SkillHubError(`Refusing to write unsafe skills.sh download path: ${relativePath}`);
  }
  return outputPath;
}

export function writeDownloadedSkillDirectory(files: readonly SkillsShDownloadedFile[], targetPath: string): void {
  const parentPath = dirname(targetPath);
  mkdirSync(parentPath, { recursive: true });
  const stagingPath = mkdtempSync(join(parentPath, ".pi-skill-hub-install-"));

  try {
    for (const file of files) {
      const outputPath = safeOutputPath(stagingPath, file.relativePath);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, file.content, "utf-8");
    }

    if (existsSync(targetPath)) {
      throw new SkillHubError(`Refusing to install over existing skill directory: ${targetPath}`);
    }
    renameSync(stagingPath, targetPath);
  } catch (error) {
    if (existsSync(stagingPath)) {
      rmSync(stagingPath, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function stageSkillsShSkillDirectory(
  source: SkillsShSource,
  targetPath: string,
  timeoutMs: number,
  httpClient?: SkillsShHttpClient | undefined,
  config?: Partial<Pick<SkillsShProviderConfig, "downloadBaseUrl" | "apiKey">> | undefined,
): Promise<void> {
  const files = await downloadSkillsShSkillFiles(source, timeoutMs, httpClient ?? defaultSkillsShHttpClient, config);
  for (const file of files) {
    const outputPath = safeOutputPath(targetPath, file.relativePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, file.content, "utf-8");
  }
}

export async function installSkillsShSkillDirectory(
  source: SkillsShSource,
  targetPath: string,
  timeoutMs: number,
  httpClient?: SkillsShHttpClient | undefined,
  config?: Partial<Pick<SkillsShProviderConfig, "downloadBaseUrl" | "apiKey">> | undefined,
): Promise<void> {
  const files = await downloadSkillsShSkillFiles(source, timeoutMs, httpClient ?? defaultSkillsShHttpClient, config);
  writeDownloadedSkillDirectory(files, targetPath);
}
