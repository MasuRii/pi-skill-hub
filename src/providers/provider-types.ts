import type { SearchMode, SkillSearchResult } from "../types.js";

export interface SkillProvider {
  readonly id: SkillSearchResult["provider"];
  readonly name: string;
  readonly requiresAuth: boolean;
  isAvailable(): boolean;
  search(query: string, mode: SearchMode, limit: number): Promise<SkillSearchResult[]>;
}
