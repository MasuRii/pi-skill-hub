import type { BrowserProviderFilter, BrowserSortMode, SkillSearchResult } from "../types.js";
import { rankSkills } from "../search/search.js";

export interface BrowserState {
  query: string;
  providerFilter: BrowserProviderFilter;
  sortMode: BrowserSortMode;
  pageIndex: number;
  results: SkillSearchResult[];
}

export const BROWSER_SORT_MODES: BrowserSortMode[] = ["relevance", "popularity", "name", "provider"];
export const BROWSER_PROVIDER_FILTERS: BrowserProviderFilter[] = ["all", "skills-sh", "skillsmp"];

export function createBrowserState(): BrowserState {
  return {
    query: "",
    providerFilter: "all",
    sortMode: "relevance",
    pageIndex: 0,
    results: [],
  };
}

function byName(left: SkillSearchResult, right: SkillSearchResult): number {
  const nameDifference = left.name.localeCompare(right.name);
  return nameDifference !== 0 ? nameDifference : left.provider.localeCompare(right.provider);
}

export function filterBrowserResults(results: readonly SkillSearchResult[], providerFilter: BrowserProviderFilter): SkillSearchResult[] {
  if (providerFilter === "all") {
    return [...results];
  }
  return results.filter((skill) => skill.provider === providerFilter);
}

export function sortBrowserResults(
  results: readonly SkillSearchResult[],
  query: string,
  sortMode: BrowserSortMode,
): SkillSearchResult[] {
  if (sortMode === "relevance") {
    return rankSkills(results, query);
  }
  if (sortMode === "popularity") {
    return [...results].sort((left, right) => right.popularity - left.popularity || byName(left, right));
  }
  if (sortMode === "provider") {
    return [...results].sort((left, right) => left.provider.localeCompare(right.provider) || byName(left, right));
  }
  return [...results].sort(byName);
}

export function visibleBrowserResults(state: BrowserState): SkillSearchResult[] {
  return sortBrowserResults(filterBrowserResults(state.results, state.providerFilter), state.query, state.sortMode);
}

export function browserPageCount(resultCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, resultCount) / Math.max(1, pageSize)));
}

export function clampBrowserPageIndex(pageIndex: number, resultCount: number, pageSize: number): number {
  return Math.max(0, Math.min(pageIndex, browserPageCount(resultCount, pageSize) - 1));
}

export function pagedBrowserResults(results: readonly SkillSearchResult[], pageIndex: number, pageSize: number): SkillSearchResult[] {
  const safePageSize = Math.max(1, pageSize);
  const safePageIndex = clampBrowserPageIndex(pageIndex, results.length, safePageSize);
  const start = safePageIndex * safePageSize;
  return results.slice(start, start + safePageSize);
}

export function cycleSortMode(current: BrowserSortMode): BrowserSortMode {
  const index = BROWSER_SORT_MODES.indexOf(current);
  return BROWSER_SORT_MODES[(index + 1) % BROWSER_SORT_MODES.length] ?? "relevance";
}

export function cycleProviderFilter(current: BrowserProviderFilter): BrowserProviderFilter {
  const index = BROWSER_PROVIDER_FILTERS.indexOf(current);
  return BROWSER_PROVIDER_FILTERS[(index + 1) % BROWSER_PROVIDER_FILTERS.length] ?? "all";
}
