import { rmSync } from "node:fs";
import type { SkillHubConfig } from "../config/config.js";
import { fingerprintsEqual } from "../inventory/fingerprint.js";
import { findInventoryItem } from "../inventory/inventory.js";
import type { InventoryItem, InventorySnapshot, UpdateStatusReport, UpdateStatusResult } from "../types.js";
import { getErrorMessage } from "../utils/errors.js";
import { hasReliableProviderMetadata, stageProviderContent } from "./provider-content.js";
import { hasDiff } from "./file-diff.js";

export type StageProviderContent = typeof stageProviderContent;

function blocked(item: InventoryItem, reason: string): UpdateStatusResult {
  return { item, status: "blocked", applicable: false, reason, localFingerprint: item.fingerprint };
}

function unknown(item: InventoryItem, reason: string): UpdateStatusResult {
  return { item, status: "unknown", applicable: false, reason, localFingerprint: item.fingerprint };
}

export function preflightUpdateCandidate(item: InventoryItem): UpdateStatusResult | undefined {
  if (item.rootType !== "local") {
    return blocked(item, "Only local extension-managed skills can be updated; external roots are protected.");
  }
  if (item.classification === "missing") {
    return blocked(item, "Manifest entry points to a missing local directory.");
  }
  if (item.classification === "external") {
    return blocked(item, "External skills are protected from update.");
  }
  if (item.classification === "unknown") {
    return unknown(item, "Upstream status unknown: custom/manual skill has no managed provenance.");
  }
  if (item.classification === "adopted") {
    return unknown(item, "Upstream status unknown: adopted provenance is preview-only and cannot be update-applied.");
  }
  if (item.driftStatus !== "clean") {
    return blocked(item, `Local skill is not clean (drift=${item.driftStatus}); update would overwrite local changes.`);
  }
  if (!item.manifestEntry || item.manifestEntry.provenance !== "installed") {
    return unknown(item, "Upstream status unknown: manifest entry is missing installed provenance.");
  }
  if (!hasReliableProviderMetadata(item.manifestEntry)) {
    return unknown(item, "Upstream status unknown: manifest lacks reliable provider/source metadata.");
  }
  return undefined;
}

export async function checkUpdateStatus(
  item: InventoryItem,
  config: SkillHubConfig,
  stageContent: StageProviderContent = stageProviderContent,
): Promise<UpdateStatusResult> {
  const preflight = preflightUpdateCandidate(item);
  if (preflight) {
    return preflight;
  }

  try {
    const staged = await stageContent(item, config);
    try {
      const status = fingerprintsEqual(item.fingerprint, staged.fingerprint) || !hasDiff(staged.diff) ? "current" : "available";
      return {
        item,
        status,
        applicable: status === "available",
        reason: status === "available" ? "Upstream content differs from local clean managed skill." : "Local managed skill matches upstream content.",
        localFingerprint: item.fingerprint,
        upstreamFingerprint: staged.fingerprint,
        diff: staged.diff,
      };
    } finally {
      rmSync(staged.stagingPath, { recursive: true, force: true });
    }
  } catch (error) {
    return unknown(item, `Upstream status unknown: ${getErrorMessage(error)}`);
  }
}

function candidates(snapshot: InventorySnapshot, target?: string): InventoryItem[] {
  const trimmed = target?.trim();
  if (trimmed) {
    const item = findInventoryItem(snapshot, trimmed);
    return item ? [item] : [];
  }
  return snapshot.items.filter((item) => item.rootType === "local");
}

export async function checkUpdateStatuses(
  snapshot: InventorySnapshot,
  config: SkillHubConfig,
  target?: string,
  stageContent: StageProviderContent = stageProviderContent,
): Promise<UpdateStatusReport> {
  const updateCandidates = candidates(snapshot, target);
  const results = await Promise.all(updateCandidates.map((item) => checkUpdateStatus(item, config, stageContent)));
  return {
    target,
    checkedAt: new Date().toISOString(),
    results,
  };
}
