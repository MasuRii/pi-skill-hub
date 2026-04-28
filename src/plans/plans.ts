import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillHubConfig } from "../config/config.js";
import { findInventoryItem, type collectInventory } from "../inventory/inventory.js";
import type { InventoryItem, InventorySnapshot, SafetyPlan, SkillSearchResult, UpdateStatusReport } from "../types.js";
import { isPathInside, resolveSafeLocalSkillPath } from "../utils/path-utils.js";
import { createInstallDescriptor, skillNameFromInstallId } from "./install-descriptor.js";

export type Snapshot = ReturnType<typeof collectInventory> | InventorySnapshot;

function safePlan(action: SafetyPlan["action"], title: string): SafetyPlan {
  return {
    action,
    title,
    previewOnly: true,
    requiresConfirmation: true,
    canApply: false,
    operations: [],
    blocked: [],
    warnings: [],
  };
}

function isMutableManagedItem(item: InventoryItem): boolean {
  return item.rootType === "local" && item.classification === "managed" && item.driftStatus === "clean";
}

export function buildAdoptPlan(snapshot: Snapshot, target: string): SafetyPlan {
  const plan = safePlan("adopt", `Adopt ${target}`);
  const item = findInventoryItem(snapshot, target);
  plan.confirmationToken = target;

  if (!item) {
    plan.blocked.push({ kind: "skip", target, description: "Skill was not found in local inventory.", protected: true });
    return plan;
  }
  plan.confirmationToken = item.name;

  if (item.rootType !== "local") {
    plan.blocked.push({ kind: "skip", target: item.path, description: "External skills are protected from adoption by this local manifest.", protected: true });
    return plan;
  }
  if (item.classification === "managed" || item.classification === "adopted") {
    plan.operations.push({ kind: "skip", target: item.path, description: "Skill already has provenance metadata.", protected: false });
    return plan;
  }
  if (!item.fingerprint) {
    plan.blocked.push({ kind: "skip", target: item.path, description: "Skill fingerprint could not be computed.", protected: true });
    return plan;
  }

  plan.operations.push({ kind: "write_manifest", target: item.path, description: "Record current local fingerprint as adopted provenance.", protected: false });
  plan.canApply = true;
  return plan;
}

export function buildInstallPreviewPlan(config: SkillHubConfig, skill: SkillSearchResult | string): SafetyPlan {
  const descriptor = createInstallDescriptor(skill);
  const plan = safePlan("install", `Install preview for ${descriptor.displayName}`);
  plan.confirmationToken = descriptor.installReference;

  const target = resolveSafeLocalSkillPath(config.localSkillRoot, descriptor.localSkillName);
  if (!target.ok) {
    plan.blocked.push({
      kind: "skip",
      target: resolve(config.localSkillRoot),
      description: `Install identifier derives an unsafe local skill name. ${target.reason}`,
      protected: true,
    });
    return plan;
  }

  if (existsSync(target.value.targetPath)) {
    plan.blocked.push({
      kind: "skip",
      target: target.value.targetPath,
      description: "A local directory with the target skill name already exists; existing skills are never overwritten by install previews.",
      protected: true,
    });
    return plan;
  }

  plan.operations.push({
    kind: "run_command",
    target: descriptor.installReference,
    description: "Would run the provider installer only after explicit confirmation.",
    protected: false,
  });
  plan.operations.push({
    kind: "write_manifest",
    target: target.value.targetPath,
    description: "Would record installed provenance and initial fingerprint after installation.",
    protected: false,
  });
  plan.canApply = true;
  return plan;
}

export function buildUpdatePreviewPlan(snapshot: Snapshot, target?: string): SafetyPlan {
  const label = target && target.trim().length > 0 ? target.trim() : "all managed skills";
  const plan = safePlan("update", `Update eligibility preview for ${label}`);
  plan.confirmationToken = target?.trim() || undefined;

  const candidates = target && target.trim().length > 0
    ? [findInventoryItem(snapshot, target)].filter((item): item is InventoryItem => Boolean(item))
    : snapshot.items.filter((item) => item.rootType === "local");

  if (candidates.length === 0) {
    plan.blocked.push({ kind: "skip", target: label, description: "No local skills matched the update target.", protected: true });
    return plan;
  }

  for (const item of candidates) {
    if (!isMutableManagedItem(item)) {
      plan.blocked.push({
        kind: "skip",
        target: item.path,
        description: `Protected from update because classification=${item.classification}, root=${item.rootType}, drift=${item.driftStatus}.`,
        protected: true,
      });
      continue;
    }
    if (!item.manifestEntry?.provider || !item.manifestEntry.sourceId) {
      plan.blocked.push({
        kind: "skip",
        target: item.path,
        description: "Upstream status unknown because manifest provenance lacks reliable provider/source metadata.",
        protected: true,
      });
      continue;
    }
    plan.operations.push({ kind: "stage_content", target: item.path, description: "Eligible for provider-resolved staging before any update apply.", protected: false });
  }

  return plan;
}

export function buildUpdateApplyPlan(report: UpdateStatusReport, target: string): SafetyPlan {
  const plan = safePlan("update", `Apply staged update for ${target}`);
  plan.confirmationToken = target;
  const result = report.results.find((entry) => entry.item.name === target || entry.item.metadata.name === target || entry.item.path === target);
  if (!result) {
    plan.blocked.push({ kind: "skip", target, description: "No update status result matched the requested target.", protected: true });
    return plan;
  }
  plan.confirmationToken = result.item.name;
  if (result.status !== "available" || !result.applicable) {
    plan.blocked.push({ kind: "skip", target: result.item.path, description: result.reason, protected: true });
    return plan;
  }
  plan.operations.push({ kind: "stage_content", target: result.item.path, description: "Stage provider-resolved upstream content in the configured staging root.", protected: false });
  plan.operations.push({ kind: "replace_directory", target: result.item.path, description: "Replace clean managed local skill with staged content after confirmation.", protected: false });
  plan.operations.push({ kind: "write_manifest", target: result.item.name, description: "Record updated fingerprint and timestamp after successful replacement.", protected: false });
  plan.canApply = true;
  return plan;
}

export function buildRemovePreviewPlan(snapshot: Snapshot, target: string): SafetyPlan {
  const plan = safePlan("remove", `Remove preview for ${target}`);
  const item = findInventoryItem(snapshot, target);
  plan.confirmationToken = target;

  if (!item) {
    plan.blocked.push({ kind: "skip", target, description: "Skill was not found in inventory.", protected: true });
    return plan;
  }
  plan.confirmationToken = item.name;

  if (!isMutableManagedItem(item)) {
    plan.blocked.push({
      kind: "skip",
      target: item.path,
      description: `Protected from removal because classification=${item.classification}, root=${item.rootType}, drift=${item.driftStatus}.`,
      protected: true,
    });
    return plan;
  }

  plan.operations.push({ kind: "delete_directory", target: item.path, description: "Delete managed local skill directory after explicit confirmation.", protected: false });
  plan.operations.push({ kind: "write_manifest", target: item.name, description: "Remove provenance entry after directory deletion succeeds.", protected: false });
  plan.canApply = true;
  return plan;
}

export function buildRefreshPlan(snapshot: Snapshot): SafetyPlan {
  const plan = safePlan("refresh", "Refresh inventory and drift status");
  plan.requiresConfirmation = false;
  plan.confirmationToken = undefined;
  plan.operations.push({ kind: "scan_inventory", target: snapshot.localRoot, description: `Scanned ${String(snapshot.items.length)} local/external/manifest skills.`, protected: false });

  for (const item of snapshot.items) {
    if (item.rootType === "external" || item.classification === "unknown") {
      plan.blocked.push({ kind: "skip", target: item.path, description: `${item.classification} skill is protected from mutation by default.`, protected: true });
    }
    if (item.driftStatus === "drifted") {
      plan.warnings.push(`${item.name} has drifted from its recorded fingerprint.`);
    }
  }

  return plan;
}

export function assertPlanPathIsLocal(config: SkillHubConfig, targetPath: string): void {
  if (!isPathInside(targetPath, config.localSkillRoot)) {
    throw new Error(`Refusing to mutate path outside local skill root: ${targetPath}`);
  }
}

export function displayNameForInstallId(skillId: string): string {
  const target = resolveSafeLocalSkillPath(".", skillNameFromInstallId(skillId));
  if (!target.ok) {
    throw new Error(`Invalid install skill name derived from '${skillId}': ${target.reason}`);
  }
  return target.value.skillName;
}
