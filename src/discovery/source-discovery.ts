import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SkillHubConfig } from "../config/config.js";
import type { CommandRunner, InventoryItem, ProviderSearchSummary, SkillContentPreview, SkillSearchResult } from "../types.js";
import { createProviders } from "../providers/index.js";
import { chooseSearchMode, normalizeQuery, searchAllProviders, tokenizeSearchText } from "../search/search.js";
import { buildMetadataPreview, buildRemotePreview, createPreviewHttpClient } from "../browser/preview.js";
import { getErrorMessage } from "../utils/errors.js";
import { parseSkillsShReference } from "../providers/skills-sh-identifiers.js";
import { canonicalGithubUrl, parseGithubSourceUrl, sourceReferenceFromGithubSource, sourceReferenceFromSkillsShSource, sourceReferenceLabel } from "../utils/source-reference.js";

export type SourceMatchConfidence = "high" | "medium" | "low";
export type SourcePreviewBuilder = (skill: SkillSearchResult) => Promise<SkillContentPreview>;

export interface SourceDiscoveryMatch {
  skill: SkillSearchResult;
  score: number;
  confidence: SourceMatchConfidence;
  reasons: string[];
  preview: SkillContentPreview;
}

export interface SourceDiscoveryReport {
  item: InventoryItem;
  query: string;
  matches: SourceDiscoveryMatch[];
  sources: ProviderSearchSummary[];
}

export interface SourceDiscoveryOptions {
  maxCandidates?: number | undefined;
  previewBuilder?: SourcePreviewBuilder | undefined;
}

const DEFAULT_MAX_CANDIDATES = 8;
const MIN_RESULT_SCORE = 0.18;
export const MIN_BIND_SOURCE_SCORE = 0.45;

function localSkillMarkdown(item: InventoryItem): string {
  const skillFilePath = join(item.path, "SKILL.md");
  if (!existsSync(skillFilePath)) {
    return `${item.metadata.name}\n\n${item.metadata.description}`;
  }
  try {
    return readFileSync(skillFilePath, "utf-8");
  } catch (error) {
    throw new Error(`Unable to read local SKILL.md for source discovery: ${getErrorMessage(error)}`);
  }
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenizeSearchText(value))];
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = uniqueTokens(left);
  const rightTokens = new Set(uniqueTokens(right));
  if (leftTokens.length === 0 || rightTokens.size === 0) {
    return 0;
  }
  const intersection = leftTokens.filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.length, rightTokens.size);
}

function compactName(value: string): string {
  return tokenizeSearchText(value).join("");
}

function bigrams(value: string): Set<string> {
  const compact = compactName(value);
  if (compact.length < 2) {
    return new Set(compact ? [compact] : []);
  }
  const values: string[] = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    values.push(compact.slice(index, index + 2));
  }
  return new Set(values);
}

function diceCoefficient(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of leftBigrams) {
    if (rightBigrams.has(value)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function nameSimilarity(item: InventoryItem, skill: SkillSearchResult): number {
  const localNames = [item.name, item.metadata.name, basename(item.path)];
  return Math.max(...localNames.map((name) => diceCoefficient(name, skill.name)));
}

function buildDiscoveryQuery(item: InventoryItem): string {
  const nameTokens = uniqueTokens(`${item.name} ${item.metadata.name}`);
  const descriptionTokens = uniqueTokens(item.metadata.description).slice(0, 6);
  return normalizeQuery([...nameTokens, ...descriptionTokens].join(" ")) || item.name;
}

function confidence(score: number): SourceMatchConfidence {
  if (score >= 0.72) {
    return "high";
  }
  if (score >= MIN_BIND_SOURCE_SCORE) {
    return "medium";
  }
  return "low";
}

function sourceReliability(skill: SkillSearchResult): number {
  if (skill.githubUrl || skill.installReference?.includes("github.com") || skill.sourceUrl?.includes("github.com")) {
    return 1;
  }
  if (skill.provider === "skills-sh" && skill.id.includes("@")) {
    return 1;
  }
  if (skill.sourceUrl || skill.installReference) {
    return 0.65;
  }
  return 0.25;
}

function scoreMatch(item: InventoryItem, localMarkdown: string, skill: SkillSearchResult, preview: SkillContentPreview): SourceDiscoveryMatch {
  const nameScore = nameSimilarity(item, skill);
  const metadataScore = tokenOverlap(`${item.metadata.name} ${item.metadata.description}`, `${skill.name} ${skill.description}`);
  const bodyScore = tokenOverlap(localMarkdown, preview.body);
  const reliabilityScore = sourceReliability(skill);
  const score = Number((nameScore * 0.4 + metadataScore * 0.25 + bodyScore * 0.25 + reliabilityScore * 0.1).toFixed(4));
  const reasons = [
    `name ${Math.round(nameScore * 100).toString()}%`,
    `metadata ${Math.round(metadataScore * 100).toString()}%`,
    `SKILL.md ${Math.round(bodyScore * 100).toString()}%`,
    `source ${Math.round(reliabilityScore * 100).toString()}%`,
  ];
  if (preview.source === "metadata") {
    reasons.push("remote preview unavailable; metadata-only comparison");
  }
  return { skill, score, confidence: confidence(score), reasons, preview };
}

async function previewCandidate(skill: SkillSearchResult, previewBuilder: SourcePreviewBuilder): Promise<SkillContentPreview> {
  try {
    return await previewBuilder(skill);
  } catch (error) {
    const fallback = buildMetadataPreview(skill);
    return {
      ...fallback,
      limitation: `${fallback.limitation ?? "Remote preview unavailable."} Preview error: ${getErrorMessage(error)}`,
    };
  }
}

export function manualSourceSkillFromUrl(item: InventoryItem, sourceUrl: string): SkillSearchResult {
  const trimmed = sourceUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("Manual source URL cannot be empty.");
  }

  const skillsShSource = parseSkillsShReference(trimmed);
  if (skillsShSource) {
    const reference = sourceReferenceFromSkillsShSource(skillsShSource);
    return {
      id: reference.sourceId,
      name: skillsShSource.skill,
      author: skillsShSource.owner,
      description: `Manually linked skills.sh source ${reference.label}.`,
      popularity: 0,
      provider: "skills-sh",
      sourceUrl: reference.sourceUrl,
      sourceOwner: reference.owner,
      sourceRepository: reference.repository,
      sourcePath: reference.path,
      installReference: reference.sourceId,
    };
  }

  const githubSource = parseGithubSourceUrl(trimmed);
  if (githubSource) {
    const canonicalUrl = canonicalGithubUrl(githubSource);
    const reference = sourceReferenceFromGithubSource(githubSource, "github");
    return {
      id: canonicalUrl,
      name: item.name,
      author: githubSource.owner,
      description: `Manually linked GitHub source ${reference.label}.`,
      popularity: 0,
      provider: "github",
      sourceUrl: canonicalUrl,
      githubUrl: canonicalUrl,
      sourceOwner: reference.owner,
      sourceRepository: reference.repository,
      sourcePath: reference.path,
      installReference: canonicalUrl,
    };
  }

  throw new Error("Manual source URL must be a skills.sh source (owner/repo@skill or https://skills.sh/owner/repo/skill) or a GitHub source URL (https://github.com/owner/repo[/tree/branch/path]).");
}

export async function buildManualSourceMatch(
  item: InventoryItem,
  sourceUrl: string,
  previewBuilder: SourcePreviewBuilder,
): Promise<SourceDiscoveryMatch> {
  if (item.rootType !== "local" || item.classification === "missing") {
    throw new Error("Manual source binding only supports existing local skills.");
  }

  const skill = manualSourceSkillFromUrl(item, sourceUrl);
  const preview = await previewCandidate(skill, previewBuilder);
  const enrichedSkill = preview.metadata.weeklyInstalls === undefined ? skill : { ...skill, popularity: preview.metadata.weeklyInstalls };
  return {
    skill: enrichedSkill,
    score: 1,
    confidence: "high",
    reasons: ["manual user-provided source", "operator verified URL before binding"],
    preview,
  };
}

export async function discoverSourceMatches(
  item: InventoryItem,
  config: SkillHubConfig,
  runner: CommandRunner,
  options: SourceDiscoveryOptions = {},
): Promise<SourceDiscoveryReport> {
  if (item.rootType !== "local" || item.classification === "missing") {
    throw new Error("Source discovery only supports existing local skills.");
  }

  const query = buildDiscoveryQuery(item);
  const result = await searchAllProviders(
    query,
    chooseSearchMode(query),
    createProviders(config, runner),
    Math.max(1, config.maxSearchResults),
  );
  const localMarkdown = localSkillMarkdown(item);
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const previewBuilder = options.previewBuilder ?? ((skill) => buildRemotePreview(skill, createPreviewHttpClient(config.apiKeys.github)));
  const matches = await Promise.all(
    result.skills.slice(0, maxCandidates).map(async (skill) => scoreMatch(item, localMarkdown, skill, await previewCandidate(skill, previewBuilder))),
  );

  return {
    item,
    query,
    sources: result.sources,
    matches: matches
      .filter((match) => match.score >= MIN_RESULT_SCORE)
      .sort((left, right) => right.score - left.score || right.skill.popularity - left.skill.popularity),
  };
}

export interface SourceDiscoveryBinding {
  item: InventoryItem;
  match: SourceDiscoveryMatch;
}

export interface SourceDiscoverySkipped {
  item: InventoryItem;
  reason: string;
  bestMatch?: SourceDiscoveryMatch | undefined;
}

export interface BulkSourceDiscoveryReport {
  checkedCount: number;
  bindings: SourceDiscoveryBinding[];
  skipped: SourceDiscoverySkipped[];
}

export interface BulkSourceDiscoveryOptions extends SourceDiscoveryOptions {
  minScore?: number | undefined;
  concurrency?: number | undefined;
}

const DEFAULT_BULK_CONCURRENCY = 3;
export const MIN_AUTO_BIND_SOURCE_SCORE = 0.72;

function hasProviderSource(item: InventoryItem): boolean {
  return Boolean(item.manifestEntry?.provider && item.manifestEntry.sourceId);
}

function canDiscoverBulkSource(item: InventoryItem): boolean {
  return item.rootType === "local" && item.classification !== "missing" && !hasProviderSource(item);
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await task(item);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function discoverBulkSourceForItem(
  item: InventoryItem,
  config: SkillHubConfig,
  runner: CommandRunner,
  options: BulkSourceDiscoveryOptions,
): Promise<SourceDiscoveryBinding | SourceDiscoverySkipped> {
  try {
    const report = await discoverSourceMatches(item, config, runner, options);
    const bestMatch = report.matches[0];
    const minScore = options.minScore ?? MIN_AUTO_BIND_SOURCE_SCORE;
    if (!bestMatch) {
      return { item, reason: "No provider source candidates matched the local skill metadata." };
    }
    if (bestMatch.score < minScore) {
      return {
        item,
        bestMatch,
        reason: `Best match ${bestMatch.skill.provider}:${sourceReferenceLabel(bestMatch.skill)} scored ${Math.round(bestMatch.score * 100).toString()}%, below the ${Math.round(minScore * 100).toString()}% auto-bind threshold.`,
      };
    }
    return { item, match: bestMatch };
  } catch (error) {
    return { item, reason: `Source discovery failed: ${getErrorMessage(error)}` };
  }
}

export async function discoverBulkSourceBindings(
  items: readonly InventoryItem[],
  config: SkillHubConfig,
  runner: CommandRunner,
  options: BulkSourceDiscoveryOptions = {},
): Promise<BulkSourceDiscoveryReport> {
  const eligibleItems = items.filter(canDiscoverBulkSource);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_BULK_CONCURRENCY);
  const results = await mapWithConcurrency(
    eligibleItems,
    concurrency,
    async (item) => discoverBulkSourceForItem(item, config, runner, options),
  );

  const bindings: SourceDiscoveryBinding[] = [];
  const skipped: SourceDiscoverySkipped[] = [];
  for (const result of results) {
    if ("match" in result) {
      bindings.push(result);
    } else {
      skipped.push(result);
    }
  }

  return {
    checkedCount: eligibleItems.length,
    bindings,
    skipped,
  };
}
