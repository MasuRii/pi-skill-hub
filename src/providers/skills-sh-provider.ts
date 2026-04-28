import type { CommandRunner, CommandRunnerResult, ProviderId, SearchMode, SkillSearchResult } from "../types.js";
import { buildSkillsFindCommand, type SkillsCliCommand } from "../commands/skills-command.js";
import { sanitizeTerminalText } from "../utils/terminal-text.js";
import type { SkillProvider } from "./provider-types.js";

interface SkillsShRawResult {
  id?: string;
  skillId?: string;
  name?: string;
  author?: string;
  owner?: string;
  source?: string;
  description?: string;
  summary?: string;
  installs?: number | string;
  installCount?: number | string;
  stars?: number;
  url?: string;
  skillUrl?: string;
  githubUrl?: string;
  html_url?: string;
}

const NO_RESULTS_REGEX = /No skills found for\s+["“]?/iu;

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

function sourceUrlFromIdentifier(identifier: string): string | undefined {
  const [repo, skill] = identifier.split("@");
  if (!repo || !skill) {
    return undefined;
  }
  return `https://skills.sh/${repo}/${skill}`;
}

function normalizeSourceRepo(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const githubMatch = source.match(/(?:github[:/]+|https:\/\/github\.com\/)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/iu);
  return githubMatch?.[1];
}

function identifierFromJsonResult(item: SkillsShRawResult): string | undefined {
  if (item.id?.includes("@")) {
    return item.id;
  }
  const skillId = item.skillId ?? item.id ?? item.name;
  const sourceRepo = normalizeSourceRepo(item.source);
  return sourceRepo && skillId ? `${sourceRepo}@${skillId}` : item.id ?? item.name;
}

function resultFromIdentifier(identifier: string, installs: number, description?: string, url?: string): SkillSearchResult {
  const [author = "unknown", name = identifier] = identifier.split("@");
  return {
    id: identifier,
    name,
    author,
    description: description && description.trim().length > 0 ? description : `skills.sh skill from ${author}`,
    popularity: installs,
    provider: "skills-sh" satisfies ProviderId,
    sourceUrl: url ?? sourceUrlFromIdentifier(identifier),
    installHint: `npm exec --yes --package=skills -- skills add ${identifier}`,
    installReference: identifier,
  };
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

function jsonItemsFromPayload(parsed: unknown): unknown[] | undefined {
  const container = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  return Array.isArray(parsed)
    ? parsed
    : Array.isArray(container?.results)
      ? container.results
      : Array.isArray(container?.skills)
        ? container.skills
        : undefined;
}

function parseJsonResults(cleaned: string): SkillSearchResult[] | undefined {
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const items = jsonItemsFromPayload(parsed);

    if (!items) {
      return undefined;
    }

    const results: SkillSearchResult[] = [];
    for (const item of items.filter((entry): entry is SkillsShRawResult => Boolean(entry && typeof entry === "object"))) {
      const identifier = identifierFromJsonResult(item);
      if (!identifier) {
        continue;
      }
      const installs = numericPopularity(item.installs ?? item.installCount ?? item.stars);
      const baseResult = resultFromIdentifier(identifier, installs, item.description ?? item.summary, item.skillUrl ?? item.url);
      const sourceUrl = item.skillUrl ?? item.url ?? baseResult.sourceUrl ?? item.githubUrl ?? item.html_url;
      results.push({
        ...baseResult,
        name: item.name ?? baseResult.name,
        author: item.author ?? item.owner ?? baseResult.author,
        sourceUrl,
      });
    }
    return results;
  } catch {
    return undefined;
  }
}

export function parseSkillsShOutput(stdout: string): SkillSearchResult[] {
  const cleaned = sanitizeTerminalText(stdout);
  const jsonResults = parseJsonResults(cleaned);
  if (jsonResults) {
    return jsonResults;
  }

  const results: SkillSearchResult[] = [];
  const lines = cleaned.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const compactMatch = line.match(/^(\S+\/\S+@\S+)\s+([\d.]+[KMB]?)\s+installs?$/iu);
    if (compactMatch) {
      const nextLine = lines[index + 1]?.replace(/^└\s*/u, "");
      results.push(resultFromIdentifier(compactMatch[1] ?? "", parseCompactNumber(compactMatch[2] ?? "0"), undefined, nextLine));
      continue;
    }

    const numberedMatch = line.match(/^\d+[.)]\s*(\S+\/\S+@\S+)\s*[-–—]\s*(.+)$/u);
    if (numberedMatch) {
      results.push(resultFromIdentifier(numberedMatch[1] ?? "", 0, numberedMatch[2]));
    }
  }

  return results.filter((item) => item.id.length > 0);
}

function isStructuredEmptyOutput(stdout: string): boolean {
  const cleaned = sanitizeTerminalText(stdout).trim();
  if (!cleaned) {
    return false;
  }

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const items = jsonItemsFromPayload(parsed);
    return Array.isArray(items) && items.length === 0;
  } catch {
    return false;
  }
}

function isExpectedEmptySearch(result: CommandRunnerResult): boolean {
  const output = sanitizeTerminalText(`${result.stdout}\n${result.stderr}`);
  return NO_RESULTS_REGEX.test(output) || isStructuredEmptyOutput(result.stdout);
}

function firstFailureLine(result: CommandRunnerResult): string | undefined {
  return sanitizeTerminalText(`${result.stderr}\n${result.stdout}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function formatFailure(result: CommandRunnerResult): string {
  const detail = firstFailureLine(result);
  return detail
    ? `skills.sh search failed with exit code ${String(result.code)}: ${detail}`
    : `skills.sh search failed with exit code ${String(result.code)}.`;
}

function resultsFromCommandResult(result: CommandRunnerResult, limit: number): SkillSearchResult[] {
  const parsed = parseSkillsShOutput(result.stdout).slice(0, limit);
  if (parsed.length > 0) {
    return parsed;
  }

  if (isExpectedEmptySearch(result)) {
    return [];
  }

  if (result.code !== 0) {
    throw new Error(formatFailure(result));
  }

  return [];
}

export function buildSkillsShFindCommand(query: string): SkillsCliCommand {
  return buildSkillsFindCommand(query);
}

export function createSkillsShProvider(runner: CommandRunner, timeoutMs: number): SkillProvider {
  return {
    id: "skills-sh",
    name: "skills.sh",
    requiresAuth: false,
    isAvailable(): boolean {
      return true;
    },
    async search(query: string, _mode: SearchMode, limit: number): Promise<SkillSearchResult[]> {
      const command = buildSkillsShFindCommand(query);
      const result = await runner.run(command.command, command.args, { timeoutMs });
      return resultsFromCommandResult(result, limit);
    },
  };
}
