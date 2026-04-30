import type { InventoryItem, InventorySnapshot, SkillSearchResult } from "../types.js";
import { provenanceSourceIdentityKey, sourceIdentityKey } from "../utils/source-reference.js";

export interface InstalledSkillIndex {
  readonly sourceKeys: ReadonlySet<string>;
}

export interface InstalledSkillStatus {
  readonly installed: true;
  readonly reason: "source";
}

function installedItems(snapshot: InventorySnapshot | undefined): InventoryItem[] {
  return snapshot?.items.filter((item) => item.classification !== "missing") ?? [];
}

export function createInstalledSkillIndex(snapshot: InventorySnapshot | undefined): InstalledSkillIndex {
  const sourceKeys = new Set<string>();

  for (const item of installedItems(snapshot)) {
    if (item.manifestEntry) {
      const sourceKey = provenanceSourceIdentityKey(item.manifestEntry);
      if (sourceKey) {
        sourceKeys.add(sourceKey);
      }
    }
  }

  return { sourceKeys };
}

export function installedSkillStatus(skill: SkillSearchResult, index: InstalledSkillIndex): InstalledSkillStatus | undefined {
  return index.sourceKeys.has(sourceIdentityKey(skill)) ? { installed: true, reason: "source" } : undefined;
}
