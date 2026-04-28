import { request as httpsRequest } from "node:https";
import type { ProviderId, SearchMode, SkillSearchResult } from "../types.js";
import type { SkillProvider } from "./provider-types.js";

const API_HOST = "skillsmp.com";
const USER_AGENT = "pi-skill-hub/0.1.0";

interface SkillsMpApiSkill {
  id?: string;
  slug?: string;
  name?: string;
  author?: string;
  owner?: string;
  username?: string;
  publisher?: string;
  description?: string;
  summary?: string;
  stars?: number | string;
  downloads?: number | string;
  downloadCount?: number | string;
  installCount?: number | string;
  installs?: number | string;
  githubUrl?: string;
  github_url?: string;
  repositoryUrl?: string;
  sourceUrl?: string;
  skillUrl?: string;
  url?: string;
}

interface SkillsMpRequest {
  endpoint: string;
  query: string;
  limit: number;
  mode: SearchMode;
  apiKey?: string | undefined;
  timeoutMs: number;
}

export type SkillsMpHttpClient = (request: SkillsMpRequest) => Promise<unknown>;

function apiKey(): string | undefined {
  const value = process.env.SKILLSMP_API_KEY?.trim();
  return value && value.length > 0 ? value : undefined;
}

function endpointForMode(mode: SearchMode): string {
  return mode === "ai" ? "skills/ai-search" : "skills/search";
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function unwrapSkill(value: unknown): SkillsMpApiSkill | undefined {
  const record = objectRecord(value);
  if (!record) {
    return undefined;
  }
  const nestedSkill = objectRecord(record.skill);
  return (nestedSkill ?? record) as SkillsMpApiSkill;
}

function arrayFrom(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function candidateArrays(payload: unknown): unknown[][] {
  const root = objectRecord(payload);
  const data = objectRecord(root?.data);
  const arrays = [
    arrayFrom(payload),
    arrayFrom(root?.skills),
    arrayFrom(root?.results),
    arrayFrom(root?.items),
    arrayFrom(root?.data),
    arrayFrom(data?.skills),
    arrayFrom(data?.results),
    arrayFrom(data?.items),
    arrayFrom(data?.data),
  ];
  return arrays.filter((items): items is unknown[] => Array.isArray(items));
}

export function extractSkillsMpSkills(payload: unknown): SkillsMpApiSkill[] {
  const skills: SkillsMpApiSkill[] = [];
  for (const items of candidateArrays(payload)) {
    for (const item of items) {
      const skill = unwrapSkill(item);
      if (skill) {
        skills.push(skill);
      }
    }
  }
  return skills;
}

function parseCompactNumber(value: string): number {
  const normalized = value.trim().toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/u);
  if (!match) {
    return Number.parseInt(normalized.replace(/[^\d]/gu, ""), 10) || 0;
  }
  const amount = Number.parseFloat(match[1] ?? "0");
  const suffix = match[2];
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Math.round(amount * multiplier);
}

function numericPopularity(value: number | string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parseCompactNumber(value);
  }
  return 0;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function requestJson(request: SkillsMpRequest): Promise<unknown> {
  const params = new URLSearchParams({ q: request.query, limit: String(request.limit) });
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (request.apiKey) {
    headers.authorization = `Bearer ${request.apiKey}`;
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: API_HOST,
        path: `/api/v1/${request.endpoint}?${params.toString()}`,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(body) as unknown;
          } catch {
            reject(new Error("SkillsMP returned invalid JSON."));
            return;
          }
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`SkillsMP ${request.mode} request failed with HTTP ${String(res.statusCode ?? 500)}.`));
            return;
          }
          resolve(parsed);
        });
      },
    );

    req.setTimeout(request.timeoutMs, () => {
      req.destroy(new Error(`SkillsMP request timed out after ${String(request.timeoutMs)}ms.`));
    });
    req.on("error", reject);
    req.end();
  });
}

function toSearchResult(skill: SkillsMpApiSkill): SkillSearchResult | undefined {
  const id = firstNonEmpty(skill.id, skill.slug, skill.name);
  const name = firstNonEmpty(skill.name, skill.slug, skill.id);
  if (!id || !name) {
    return undefined;
  }
  const githubUrl = firstNonEmpty(skill.githubUrl, skill.github_url, skill.repositoryUrl);
  const sourceUrl = firstNonEmpty(skill.skillUrl, skill.sourceUrl, skill.url, githubUrl);
  return {
    id,
    name,
    author: firstNonEmpty(skill.author, skill.owner, skill.username, skill.publisher) ?? "unknown",
    description: firstNonEmpty(skill.description, skill.summary) ?? "No description provided.",
    popularity: numericPopularity(skill.downloads ?? skill.downloadCount ?? skill.installCount ?? skill.installs ?? skill.stars),
    provider: "skillsmp" satisfies ProviderId,
    sourceUrl,
    githubUrl,
    installHint: githubUrl ? `npm exec --yes --package=skills -- skills add ${githubUrl}` : undefined,
    installReference: githubUrl ?? id,
  };
}

export function createSkillsMpProvider(timeoutMs: number, httpClient: SkillsMpHttpClient = requestJson): SkillProvider {
  return {
    id: "skillsmp",
    name: "SkillsMP",
    requiresAuth: false,
    isAvailable(): boolean {
      return true;
    },
    async search(query: string, mode: SearchMode, limit: number): Promise<SkillSearchResult[]> {
      const key = apiKey();
      if (mode === "ai" && !key) {
        throw new Error("SkillsMP AI search requires SKILLSMP_API_KEY. Use a shorter keyword query or configure the API key for AI search.");
      }
      const payload = await httpClient({ endpoint: endpointForMode(mode), query, limit, mode, apiKey: key, timeoutMs });
      return extractSkillsMpSkills(payload).map(toSearchResult).filter((item): item is SkillSearchResult => Boolean(item)).slice(0, limit);
    },
  };
}
