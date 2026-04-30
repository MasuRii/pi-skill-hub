import type { CatalogProviderId, SearchMode, SkillSearchResult } from "../types.js";

export interface SkillProvider {
  readonly id: CatalogProviderId;
  readonly name: string;
  readonly requiresAuth: boolean;
  isAvailable(): boolean;
  search(query: string, mode: SearchMode, limit: number): Promise<SkillSearchResult[]>;
}
