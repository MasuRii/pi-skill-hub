import type { AggregatedSearchResult, ProviderSearchSummary, SearchMode, SkillSearchResult } from "../types.js";
import type { SkillProvider } from "../providers/index.js";
import { getErrorMessage } from "../utils/errors.js";
import { sourceIdentityKey } from "../utils/source-reference.js";

const STOPWORDS = new Set(["a", "an", "and", "for", "in", "of", "the", "to", "with"]);

export function normalizeQuery(query: string): string {
  return query.trim().replace(/^[:\-–—\s]+/, "").replace(/[?.!]+$/, "").trim();
}

export function tokenizeSearchText(value: string): string[] {
  return normalizeQuery(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function chooseSearchMode(query: string): SearchMode {
  return tokenizeSearchText(query).length >= 4 ? "ai" : "keyword";
}

export function buildSearchCandidates(query: string): string[] {
  const tokens = tokenizeSearchText(query);
  const candidates: string[] = [];
  const add = (value: string): void => {
    const normalized = normalizeQuery(value.toLowerCase());
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  add(query);
  if (tokens.length > 0) {
    add(tokens.join(" "));
  }
  if (tokens.length > 1) {
    add(tokens.slice(0, 2).join(" "));
  }
  const singular = tokens.map((token) => (token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token));
  if (singular.join(" ") !== tokens.join(" ")) {
    add(singular.join(" "));
  }

  return candidates;
}

function dedupeKeys(skill: SkillSearchResult): string[] {
  return [
    sourceIdentityKey(skill),
    `name:${skill.name.toLowerCase()}::${skill.author.toLowerCase()}`,
  ];
}

function qualityScore(skill: SkillSearchResult): number {
  return skill.popularity + (skill.sourceUrl ? 10 : 0) + (skill.description.length > 60 ? 5 : 0);
}

export function deduplicateSkills(skills: readonly SkillSearchResult[]): SkillSearchResult[] {
  const seen = new Map<string, SkillSearchResult>();
  for (const skill of skills) {
    const keys = dedupeKeys(skill);
    const existing = keys.map((key) => seen.get(key)).find((candidate): candidate is SkillSearchResult => Boolean(candidate));
    if (!existing || qualityScore(skill) > qualityScore(existing)) {
      if (existing) {
        for (const [key, value] of seen.entries()) {
          if (value === existing) {
            seen.set(key, skill);
          }
        }
      }
      for (const key of keys) {
        seen.set(key, skill);
      }
    }
  }
  return [...new Set(seen.values())];
}

function queryMatchScore(skill: SkillSearchResult, query: string): number {
  const queryTokens = tokenizeSearchText(query);
  if (queryTokens.length === 0) {
    return 0;
  }
  const haystack = `${skill.name} ${skill.author} ${skill.description}`.toLowerCase();
  return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export function rankSkills(skills: readonly SkillSearchResult[], query: string): SkillSearchResult[] {
  return [...skills].sort((left, right) => {
    const matchDifference = queryMatchScore(right, query) - queryMatchScore(left, query);
    if (matchDifference !== 0) {
      return matchDifference;
    }
    const popularityDifference = right.popularity - left.popularity;
    if (popularityDifference !== 0) {
      return popularityDifference;
    }
    return left.name.localeCompare(right.name);
  });
}

export async function searchAllProviders(
  query: string,
  requestedMode: SearchMode,
  providers: readonly SkillProvider[],
  limit: number,
): Promise<AggregatedSearchResult> {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    throw new Error("Search query cannot be empty.");
  }

  const availableProviders = providers.filter((provider) => provider.isAvailable());
  if (availableProviders.length === 0) {
    throw new Error("No configured skill providers are available.");
  }

  const candidates = buildSearchCandidates(normalized);
  const providerResults = await Promise.all(
    availableProviders.map(async (provider) => {
      try {
        const candidateResults = await Promise.allSettled(
          candidates.map((candidate) => provider.search(candidate, requestedMode, limit)),
        );
        const skills = candidateResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
        if (skills.length === 0 && candidateResults.every((result) => result.status === "rejected")) {
          const firstError = candidateResults.find((result) => result.status === "rejected");
          throw new Error(firstError && firstError.status === "rejected" ? getErrorMessage(firstError.reason) : "Provider search failed.");
        }
        return { provider: provider.id, skills: deduplicateSkills(skills) };
      } catch (error) {
        return { provider: provider.id, skills: [], error: getErrorMessage(error) };
      }
    }),
  );

  const skills: SkillSearchResult[] = [];
  const sources: ProviderSearchSummary[] = [];
  for (const result of providerResults) {
    skills.push(...result.skills);
    sources.push({ provider: result.provider, count: result.skills.length, error: result.error });
  }

  return {
    query: normalized,
    mode: requestedMode,
    skills: rankSkills(deduplicateSkills(skills), normalized).slice(0, limit),
    sources,
  };
}
