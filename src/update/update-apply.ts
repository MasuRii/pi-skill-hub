import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SkillHubConfig } from "../config/config.js";
import { computeSkillFingerprint, fingerprintsEqual } from "../inventory/fingerprint.js";
import { findInventoryItem } from "../inventory/inventory.js";
import { loadManifest, saveManifest, upsertManifestEntry } from "../manifest/manifest-store.js";
import type { InventoryItem, InventorySnapshot, SafetyPlan } from "../types.js";
import { SkillHubError } from "../utils/errors.js";
import { isPathInside } from "../utils/path-utils.js";
import { assertConfirmed, assertPlanPathIsLocal } from "../plans/plans.js";
import type { ApplyOptions } from "../plans/apply.js";
import { preflightUpdateCandidate, type StageProviderContent } from "./update-checker.js";
import { hasDiff } from "./file-diff.js";
import { stageProviderContent } from "./provider-content.js";

function assertCleanManagedUpdateTarget(item: InventoryItem): void {
  const preflight = preflightUpdateCandidate(item);
  if (preflight) {
    throw new SkillHubError(preflight.reason);
  }
  if (!item.manifestEntry || !item.fingerprint) {
    throw new SkillHubError("Update target no longer has manifest provenance and a local fingerprint.");
  }
  const currentFingerprint = computeSkillFingerprint(item.path);
  if (!fingerprintsEqual(currentFingerprint, item.manifestEntry.fingerprint)) {
    throw new SkillHubError("Local skill changed after preview; refusing to overwrite drifted content.");
  }
}

function replaceDirectoryAtomically(config: SkillHubConfig, targetPath: string, stagedPath: string): void {
  assertPlanPathIsLocal(config, targetPath);
  if (!existsSync(targetPath)) {
    throw new SkillHubError(`Update target no longer exists: ${targetPath}`);
  }

  const parent = dirname(targetPath);
  const base = basename(targetPath);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const nextPath = join(parent, `.${base}.skillhub-next-${stamp}`);
  const backupPath = join(parent, `.${base}.skillhub-backup-${stamp}`);
  if (!isPathInside(nextPath, config.localSkillRoot) || !isPathInside(backupPath, config.localSkillRoot)) {
    throw new SkillHubError("Computed update swap paths are outside the local skill root.");
  }

  mkdirSync(parent, { recursive: true });
  cpSync(stagedPath, nextPath, { recursive: true, errorOnExist: true });
  renameSync(targetPath, backupPath);
  try {
    renameSync(nextPath, targetPath);
    rmSync(backupPath, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(targetPath) && existsSync(backupPath)) {
      renameSync(backupPath, targetPath);
    }
    rmSync(nextPath, { recursive: true, force: true });
    throw error;
  }
}

export async function applyUpdatePlan(
  plan: SafetyPlan,
  snapshot: InventorySnapshot,
  config: SkillHubConfig,
  options: ApplyOptions,
  stageContent: StageProviderContent = stageProviderContent,
): Promise<void> {
  assertConfirmed(plan, options.confirmToken);
  const targetName = plan.confirmationToken;
  if (!targetName) {
    throw new SkillHubError("Update plan did not include a confirmation token.");
  }
  const item = findInventoryItem(snapshot, targetName);
  if (!item) {
    throw new SkillHubError(`Update target was not found: ${targetName}`);
  }
  assertCleanManagedUpdateTarget(item);

  const staged = await stageContent(item, config);
  try {
    if (!hasDiff(staged.diff) || fingerprintsEqual(item.fingerprint, staged.fingerprint)) {
      throw new SkillHubError("Upstream content matches local content; no update is available.");
    }

    replaceDirectoryAtomically(config, item.path, staged.stagingPath);
    const nextFingerprint = computeSkillFingerprint(item.path);
    const manifestEntry = item.manifestEntry;
    if (!manifestEntry) {
      throw new SkillHubError("Manifest entry disappeared before update manifest write.");
    }
    const manifest = loadManifest(options.manifestPath);
    saveManifest(
      upsertManifestEntry(manifest, {
        ...manifestEntry,
        localPath: item.path,
        updatedAt: new Date().toISOString(),
        fingerprint: nextFingerprint,
      }),
      options.manifestPath,
    );
  } finally {
    rmSync(staged.stagingPath, { recursive: true, force: true });
  }
}
