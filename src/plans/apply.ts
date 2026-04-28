import { existsSync, rmSync } from "node:fs";
import type { SkillHubConfig } from "../config/config.js";
import { computeSkillFingerprint } from "../inventory/fingerprint.js";
import { findInventoryItem } from "../inventory/inventory.js";
import { loadManifest, removeManifestEntry, saveManifest, upsertManifestEntry } from "../manifest/manifest-store.js";
import type { CommandRunner, InventorySnapshot, ProvenanceEntry, SafetyPlan, SkillSearchResult } from "../types.js";
import { buildSkillsAddCommand } from "../commands/skills-command.js";
import { resolveSafeLocalSkillPath } from "../utils/path-utils.js";
import { SkillHubError } from "../utils/errors.js";
import { createInstallDescriptor } from "./install-descriptor.js";
import { assertPlanPathIsLocal } from "./plans.js";

export interface ApplyOptions {
  confirmToken: string;
  manifestPath?: string;
  sourceSkill?: SkillSearchResult | undefined;
}

function assertConfirmed(plan: SafetyPlan, options: ApplyOptions): void {
  if (!plan.canApply) {
    throw new SkillHubError("This plan cannot be applied safely.");
  }
  if (!plan.confirmationToken || options.confirmToken !== plan.confirmationToken) {
    throw new SkillHubError(`Confirmation token mismatch. Expected '${plan.confirmationToken ?? ""}'.`);
  }
}

export function applyAdoptPlan(plan: SafetyPlan, snapshot: InventorySnapshot, options: ApplyOptions): void {
  assertConfirmed(plan, options);
  const target = plan.operations.find((operation) => operation.kind === "write_manifest")?.target;
  if (!target) {
    throw new SkillHubError("Adopt plan did not include a manifest write operation.");
  }
  const item = findInventoryItem(snapshot, target);
  if (!item || !item.fingerprint) {
    throw new SkillHubError("Adopt target no longer exists or cannot be fingerprinted.");
  }

  const timestamp = new Date().toISOString();
  const manifest = loadManifest(options.manifestPath);
  const entry: ProvenanceEntry = {
    name: item.name,
    localPath: item.path,
    provenance: "adopted",
    installedAt: timestamp,
    updatedAt: timestamp,
    fingerprint: item.fingerprint,
  };
  saveManifest(upsertManifestEntry(manifest, entry), options.manifestPath);
}

function providerFromInstall(skillId: string, sourceSkill: SkillSearchResult | undefined): ProvenanceEntry["provider"] {
  if (sourceSkill) {
    return sourceSkill.provider;
  }
  return skillId.includes("@") ? "skills-sh" : undefined;
}

function sourceUrlFromInstall(skillId: string, sourceSkill: SkillSearchResult | undefined): string | undefined {
  if (sourceSkill?.sourceUrl) {
    return sourceSkill.sourceUrl;
  }
  if (!skillId.includes("@")) {
    return undefined;
  }
  const [repo, skill] = skillId.split("@");
  return repo && skill ? `https://skills.sh/${repo}/${skill}` : undefined;
}

export async function applyInstallPlan(
  plan: SafetyPlan,
  config: SkillHubConfig,
  runner: CommandRunner,
  options: ApplyOptions,
): Promise<void> {
  assertConfirmed(plan, options);
  const installReference = plan.confirmationToken;
  if (!installReference) {
    throw new SkillHubError("Install plan did not include an install reference confirmation token.");
  }

  const descriptor = createInstallDescriptor(options.sourceSkill ?? installReference);
  if (descriptor.installReference !== installReference) {
    throw new SkillHubError("Install plan confirmation token does not match the validated install descriptor.");
  }

  const target = resolveSafeLocalSkillPath(config.localSkillRoot, descriptor.localSkillName);
  if (!target.ok) {
    throw new SkillHubError(`Install descriptor local skill name is unsafe: ${target.reason}`);
  }

  const expectedName = target.value.skillName;
  const expectedPath = target.value.targetPath;
  if (existsSync(expectedPath)) {
    throw new SkillHubError(`Refusing to install over existing skill directory: ${expectedPath}`);
  }

  const command = buildSkillsAddCommand(descriptor.installReference);
  const result = await runner.run(command.command, command.args, { timeoutMs: config.requestTimeoutMs * 6 });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `skills add exited with code ${String(result.code)}.`;
    throw new SkillHubError(message);
  }
  if (!existsSync(expectedPath)) {
    throw new SkillHubError(`Installer completed but expected skill directory was not found: ${expectedPath}`);
  }

  const timestamp = new Date().toISOString();
  const manifest = loadManifest(options.manifestPath);
  const provider = providerFromInstall(descriptor.sourceId, options.sourceSkill);
  const sourceUrl = descriptor.sourceUrl ?? sourceUrlFromInstall(descriptor.sourceId, options.sourceSkill);
  const entry: ProvenanceEntry = {
    name: expectedName,
    localPath: expectedPath,
    provenance: "installed",
    provider,
    sourceId: descriptor.sourceId,
    sourceUrl,
    installedAt: timestamp,
    updatedAt: timestamp,
    fingerprint: computeSkillFingerprint(expectedPath),
  };
  saveManifest(upsertManifestEntry(manifest, entry), options.manifestPath);
}

export function applyRemovePlan(plan: SafetyPlan, config: SkillHubConfig, options: ApplyOptions): void {
  assertConfirmed(plan, options);
  const deleteTarget = plan.operations.find((operation) => operation.kind === "delete_directory")?.target;
  const manifestTarget = plan.operations.find((operation) => operation.kind === "write_manifest")?.target;
  if (!deleteTarget || !manifestTarget) {
    throw new SkillHubError("Remove plan did not include both directory deletion and manifest update operations.");
  }
  assertPlanPathIsLocal(config, deleteTarget);
  rmSync(deleteTarget, { recursive: true, force: false });
  const manifest = loadManifest(options.manifestPath);
  saveManifest(removeManifestEntry(manifest, manifestTarget), options.manifestPath);
}
