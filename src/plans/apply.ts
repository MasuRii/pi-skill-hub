import { existsSync, rmSync } from "node:fs";
import type { SkillHubConfig } from "../config/config.js";
import { computeSkillFingerprint } from "../inventory/fingerprint.js";
import { findInventoryItem } from "../inventory/inventory.js";
import { loadManifest, removeManifestEntry, saveManifest, upsertManifestEntry } from "../manifest/manifest-store.js";
import type { CommandRunner, InventoryItem, InventorySnapshot, ProvenanceEntry, SafetyPlan, SkillFingerprint, SkillSearchResult } from "../types.js";
import type { SourceDiscoveryBinding, SourceDiscoveryMatch } from "../discovery/source-discovery.js";
import { buildSkillsAddCommand } from "../commands/skills-command.js";
import { installSkillsShSkillDirectory, type SkillsShDownloadHttpClient } from "../providers/skills-sh-download.js";
import { skillsShDetailUrl, parseSkillsShReference } from "../providers/skills-sh-identifiers.js";
import { resolveSafeLocalSkillPath } from "../utils/path-utils.js";
import { sourceReferenceFromSkill, sourceReferenceMetadata } from "../utils/source-reference.js";
import { SkillHubError } from "../utils/errors.js";
import { createInstallDescriptor } from "./install-descriptor.js";
import { assertConfirmed, assertPlanPathIsLocal } from "./plans.js";

export interface ApplyOptions {
  confirmToken: string;
  manifestPath?: string;
  sourceSkill?: SkillSearchResult | undefined;
  skillsShHttpClient?: SkillsShDownloadHttpClient | undefined;
}

function resolveConfirmedManifestTarget(plan: SafetyPlan, options: ApplyOptions, snapshot: InventorySnapshot, planLabel: string, targetLabel: string): { item: InventoryItem; fingerprint: SkillFingerprint } {
  assertConfirmed(plan, options.confirmToken);
  const target = plan.operations.find((operation) => operation.kind === "write_manifest")?.target;
  if (!target) {
    throw new SkillHubError(`${planLabel} did not include a manifest write operation.`);
  }
  const item = findInventoryItem(snapshot, target);
  if (!item || !item.fingerprint) {
    throw new SkillHubError(`${targetLabel} no longer exists or cannot be fingerprinted.`);
  }
  return { item, fingerprint: item.fingerprint };
}

export function applyAdoptPlan(plan: SafetyPlan, snapshot: InventorySnapshot, options: ApplyOptions): void {
  const { item, fingerprint } = resolveConfirmedManifestTarget(plan, options, snapshot, "Adopt plan", "Adopt target");
  const timestamp = new Date().toISOString();
  const manifest = loadManifest(options.manifestPath);
  const entry: ProvenanceEntry = {
    name: item.name,
    localPath: item.path,
    provenance: "adopted",
    installedAt: timestamp,
    updatedAt: timestamp,
    fingerprint,
  };
  saveManifest(upsertManifestEntry(manifest, entry), options.manifestPath);
}

function providerFromInstall(skillId: string, sourceSkill: SkillSearchResult | undefined): ProvenanceEntry["provider"] {
  if (sourceSkill) {
    return sourceSkill.provider;
  }
  return parseSkillsShReference(skillId) ? "skills-sh" : undefined;
}

function sourceUrlFromInstall(skillId: string, sourceSkill: SkillSearchResult | undefined): string | undefined {
  if (sourceSkill?.sourceUrl) {
    return sourceSkill.sourceUrl;
  }
  const source = parseSkillsShReference(skillId);
  return source ? skillsShDetailUrl(source) : undefined;
}

function buildBindSourceEntry(item: InventoryItem, skill: SkillSearchResult, fingerprint: SkillFingerprint, existingInstalledAt?: string | undefined): ProvenanceEntry {
  const descriptor = createInstallDescriptor(skill);
  const sourceMetadata = sourceReferenceMetadata(sourceReferenceFromSkill(skill));
  const skillsShSource = skill.provider === "skills-sh" ? parseSkillsShReference(descriptor.sourceId) : undefined;
  const timestamp = new Date().toISOString();
  return {
    name: item.name,
    localPath: item.path,
    provenance: "installed",
    provider: skill.provider,
    sourceId: descriptor.sourceId,
    sourceUrl: descriptor.sourceUrl ?? skill.sourceUrl ?? skill.githubUrl ?? skill.installReference,
    sourceOwner: skillsShSource?.owner ?? sourceMetadata.sourceOwner,
    sourceRepository: skillsShSource?.repo ?? sourceMetadata.sourceRepository,
    sourcePath: skillsShSource?.skill ?? sourceMetadata.sourcePath,
    sourceType: skill.provider === "skills-sh" ? "skills-sh" : undefined,
    skillPath: skillsShSource?.skill,
    sourceTransport: skill.provider === "skills-sh" ? "api" : undefined,
    installedAt: existingInstalledAt ?? timestamp,
    updatedAt: timestamp,
    fingerprint,
  };
}

export function applyBindSourcePlan(plan: SafetyPlan, snapshot: InventorySnapshot, match: SourceDiscoveryMatch, options: ApplyOptions): void {
  const { item, fingerprint } = resolveConfirmedManifestTarget(plan, options, snapshot, "Bind-source plan", "Bind-source target");
  const expectedToken = `${item.name}:${match.skill.provider}:${match.skill.id}`;
  if (plan.confirmationToken !== expectedToken) {
    throw new SkillHubError("Bind-source plan does not match the selected provider source.");
  }

  const manifest = loadManifest(options.manifestPath);
  const entry = buildBindSourceEntry(item, match.skill, fingerprint, item.manifestEntry?.installedAt);
  saveManifest(upsertManifestEntry(manifest, entry), options.manifestPath);
}

export function applyBulkBindSourcePlan(plan: SafetyPlan, snapshot: InventorySnapshot, bindings: readonly SourceDiscoveryBinding[], options: ApplyOptions): void {
  assertConfirmed(plan, options.confirmToken);
  if (plan.confirmationToken !== `bulk-bind-source:${String(bindings.length)}`) {
    throw new SkillHubError("Bulk bind-source plan does not match the selected source bindings.");
  }

  const operationTargets = new Set(plan.operations.filter((operation) => operation.kind === "write_manifest").map((operation) => operation.target));
  if (operationTargets.size === 0) {
    throw new SkillHubError("Bulk bind-source plan did not include any manifest write operations.");
  }

  let manifest = loadManifest(options.manifestPath);
  let appliedCount = 0;
  for (const binding of bindings) {
    const item = findInventoryItem(snapshot, binding.item.name);
    if (!item || !item.fingerprint) {
      throw new SkillHubError(`Bulk bind-source target no longer exists or cannot be fingerprinted: ${binding.item.name}`);
    }
    if (!operationTargets.has(item.path)) {
      continue;
    }

    const entry = buildBindSourceEntry(item, binding.match.skill, item.fingerprint, item.manifestEntry?.installedAt);
    manifest = upsertManifestEntry(manifest, entry);
    appliedCount += 1;
  }

  if (appliedCount === 0) {
    throw new SkillHubError("Bulk bind-source plan did not match any current local skill targets.");
  }
  saveManifest(manifest, options.manifestPath);
}

export async function applyInstallPlan(
  plan: SafetyPlan,
  config: SkillHubConfig,
  runner: CommandRunner,
  options: ApplyOptions,
): Promise<void> {
  assertConfirmed(plan, options.confirmToken);
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

  const skillsShSource = parseSkillsShReference(descriptor.installReference);
  if (descriptor.provider === "skills-sh" && skillsShSource) {
    await installSkillsShSkillDirectory(skillsShSource, expectedPath, config.requestTimeoutMs * 6, options.skillsShHttpClient, config.skillsSh);
  } else {
    const command = buildSkillsAddCommand(descriptor.installReference);
    const result = await runner.run(command.command, command.args, { timeoutMs: config.requestTimeoutMs * 6 });
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `skills add exited with code ${String(result.code)}.`;
      throw new SkillHubError(message);
    }
    if (!existsSync(expectedPath)) {
      throw new SkillHubError(`Installer completed but expected skill directory was not found: ${expectedPath}`);
    }
  }

  const timestamp = new Date().toISOString();
  const manifest = loadManifest(options.manifestPath);
  const provider = providerFromInstall(descriptor.sourceId, options.sourceSkill);
  const sourceUrl = descriptor.sourceUrl ?? sourceUrlFromInstall(descriptor.sourceId, options.sourceSkill);
  const installSourceMetadata = options.sourceSkill ? sourceReferenceMetadata(sourceReferenceFromSkill(options.sourceSkill)) : {};
  const installedSkillsShSource = provider === "skills-sh" ? parseSkillsShReference(descriptor.sourceId) : undefined;
  const entry: ProvenanceEntry = {
    name: expectedName,
    localPath: expectedPath,
    provenance: "installed",
    provider,
    sourceId: descriptor.sourceId,
    sourceUrl,
    sourceOwner: installedSkillsShSource?.owner ?? installSourceMetadata.sourceOwner,
    sourceRepository: installedSkillsShSource?.repo ?? installSourceMetadata.sourceRepository,
    sourcePath: installedSkillsShSource?.skill ?? installSourceMetadata.sourcePath,
    sourceType: provider === "skills-sh" ? "skills-sh" : undefined,
    skillPath: installedSkillsShSource?.skill,
    sourceTransport: provider === "skills-sh" ? config.skillsSh.transport : undefined,
    installedAt: timestamp,
    updatedAt: timestamp,
    fingerprint: computeSkillFingerprint(expectedPath),
  };
  saveManifest(upsertManifestEntry(manifest, entry), options.manifestPath);
}

export function applyRemovePlan(plan: SafetyPlan, config: SkillHubConfig, options: ApplyOptions): void {
  assertConfirmed(plan, options.confirmToken);
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

export function applyRefreshPlan(plan: SafetyPlan, options: ApplyOptions): void {
  if (plan.action !== "refresh") {
    throw new SkillHubError(`Expected a refresh plan but received '${plan.action}'.`);
  }
  assertConfirmed(plan, options.confirmToken);
  const staleManifestTargets = plan.operations
    .filter((operation) => operation.kind === "write_manifest")
    .map((operation) => operation.target);
  if (staleManifestTargets.length === 0) {
    throw new SkillHubError("Refresh plan did not include stale provenance entries to prune.");
  }

  let manifest = loadManifest(options.manifestPath);
  for (const target of staleManifestTargets) {
    manifest = removeManifestEntry(manifest, target);
  }
  saveManifest(manifest, options.manifestPath);
}
