import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SkillHubConfig } from "../config/config.js";
import type { DebugLogger } from "../logging/debug-logger.js";
import { collectInventory } from "../inventory/inventory.js";
import { loadManifest } from "../manifest/manifest-store.js";
import type { CommandRunner, InventoryItem, InventorySnapshot, SkillSearchResult, UpdateStatusResult } from "../types.js";
import { buildAdoptPlan, buildBindSourcePlan, buildBulkBindSourcePlan, buildInstallPreviewPlan, buildRefreshPlan, buildRemovePreviewPlan, buildUpdateApplyPlan } from "../plans/plans.js";
import { applyAdoptPlan, applyBindSourcePlan, applyBulkBindSourcePlan, applyInstallPlan, applyRefreshPlan, applyRemovePlan } from "../plans/apply.js";
import { applyUpdatePlan } from "../update/update-apply.js";
import { checkUpdateStatuses } from "../update/update-checker.js";
import { getErrorMessage } from "../utils/errors.js";
import { formatInspect, formatInventory, formatPlan, formatProviderErrorSummary, formatUpdateReport } from "../ui/rendering.js";
import { createSkillBrowserSessionState, openSkillBrowser } from "../browser/browser-ui.js";
import { buildRemotePreview, createPreviewHttpClient, formatPreview } from "../browser/preview.js";
import { buildManualSourceMatch, discoverBulkSourceBindings, discoverSourceMatches, MIN_AUTO_BIND_SOURCE_SCORE, type BulkSourceDiscoveryReport, type SourceDiscoveryMatch } from "../discovery/source-discovery.js";
import { createSkillHubModalSelectionState, openSkillHubModal } from "../modal/skill-hub-modal.js";
import type { SkillHubModalAction } from "../modal/modal-types.js";
import { sourceReferenceFromSkill, sourceReferenceLabel } from "../utils/source-reference.js";

interface CommandServices {
  config: SkillHubConfig;
  runner: CommandRunner;
  logger: DebugLogger;
}

interface InventorySelection {
  snapshot: InventorySnapshot;
  item: InventoryItem;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}

function snapshot(services: CommandServices): InventorySnapshot {
  const manifest = loadManifest();
  return collectInventory(services.config, manifest);
}

function menuLabel(item: InventoryItem, index: number): string {
  return `${String(index + 1)}. ${item.name} [${item.classification}/${item.driftStatus}/${item.rootType}]`;
}

function selectableInventoryItems(currentSnapshot: InventorySnapshot): InventoryItem[] {
  return currentSnapshot.items.filter((item) => item.rootType === "local");
}

async function selectInventoryItem(
  ctx: ExtensionCommandContext,
  services: CommandServices,
  title: string,
  filter: (item: InventoryItem) => boolean = () => true,
): Promise<InventorySelection | undefined> {
  const currentSnapshot = snapshot(services);
  const items = selectableInventoryItems(currentSnapshot).filter(filter);
  if (items.length === 0) {
    notify(ctx, "No matching local skills are available for this action.", "warning");
    return undefined;
  }

  const labels = items.map(menuLabel);
  const selected = await ctx.ui.select(title, labels);
  if (!selected) {
    return undefined;
  }

  const index = labels.indexOf(selected);
  const item = index >= 0 ? items[index] : undefined;
  return item ? { snapshot: currentSnapshot, item } : undefined;
}

async function confirmAndApplyPlan(ctx: ExtensionCommandContext, title: string, planText: string, apply: () => Promise<void> | void): Promise<void> {
  const confirmed = await ctx.ui.confirm(title, `${planText}\n\nApply this plan?`);
  if (!confirmed) {
    notify(ctx, "Action cancelled before mutation.", "info");
    return;
  }
  await apply();
}

async function installSkill(skill: SkillSearchResult | string, ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const skillId = typeof skill === "string" ? skill : skill.id;
  const plan = buildInstallPreviewPlan(services.config, skill);
  await applyInstallPlan(plan, services.config, services.runner, {
    confirmToken: plan.confirmationToken ?? "",
    sourceSkill: typeof skill === "string" ? undefined : skill,
  });
  notify(ctx, `Installed ${skillId}. Run /reload to refresh available skills.`, "info");
}

async function handleBrowse(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const browserSession = createSkillBrowserSessionState();
  while (true) {
    const action = await openSkillBrowser(ctx, { ...services, inventorySnapshot: snapshot(services) }, browserSession);
    if (!action) {
      return;
    }

    const preview = action.preview ?? await buildRemotePreview(action.skill, createPreviewHttpClient(services.config.apiKeys.github));
    const confirmed = await ctx.ui.confirm("Install skill from Skill Hub?", `${formatPreview(preview)}\n\nInstall ${action.skill.id}?`);
    if (!confirmed) {
      notify(ctx, "Install cancelled before mutation.", "info");
      continue;
    }

    await installSkill(action.skill, ctx, services);
  }
}

async function handleInventory(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const currentSnapshot = snapshot(services);
  if (currentSnapshot.items.length === 0) {
    notify(ctx, formatInventory(currentSnapshot), "info");
    return;
  }

  const labels = currentSnapshot.items.map(menuLabel);
  const selected = await ctx.ui.select("Skill Hub inventory", labels);
  if (!selected) {
    return;
  }

  const index = labels.indexOf(selected);
  const item = index >= 0 ? currentSnapshot.items[index] : undefined;
  notify(ctx, item ? formatInspect(item) : "Selected skill was not found.", item ? "info" : "warning");
}

async function handleAdopt(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const selection = await selectInventoryItem(
    ctx,
    services,
    "Adopt unmanaged local skill",
    (item) => item.classification === "unknown" && item.rootType === "local",
  );
  if (!selection) {
    return;
  }

  const plan = buildAdoptPlan(selection.snapshot, selection.item.name);
  const planText = formatPlan(plan);
  if (!plan.canApply) {
    notify(ctx, planText, "warning");
    return;
  }

  await confirmAndApplyPlan(ctx, "Adopt skill?", planText, () => {
    applyAdoptPlan(plan, selection.snapshot, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, `Adopted ${plan.confirmationToken ?? selection.item.name}. Run /reload if skill command visibility changed.`, "info");
  });
}

function canBindProviderSource(item: InventoryItem): boolean {
  return item.rootType === "local" && item.classification !== "missing" && !(item.classification === "managed" && Boolean(item.manifestEntry?.provider && item.manifestEntry.sourceId));
}

function sourceMatchLabel(match: SourceDiscoveryMatch, index: number): string {
  return `${String(index + 1)}. ${match.skill.name} [${match.skill.provider} ${sourceReferenceLabel(match.skill)}] ${Math.round(match.score * 100).toString()}% ${match.confidence}`;
}

function formatSourceMatch(match: SourceDiscoveryMatch): string {
  const reference = sourceReferenceFromSkill(match.skill);
  return [
    `Candidate: ${match.skill.name}`,
    `Provider: ${match.skill.provider}`,
    `Owner: ${reference.owner ?? match.skill.author}`,
    `Repository: ${reference.repository ? `${reference.owner ?? match.skill.author}/${reference.repository}` : "unknown"}`,
    ...(reference.path ? [`Source path: ${reference.path}`] : []),
    `Source: ${reference.sourceUrl ?? match.skill.sourceUrl ?? match.skill.githubUrl ?? match.skill.installReference ?? match.skill.id}`,
    `Confidence: ${match.confidence} (${Math.round(match.score * 100).toString()}%)`,
    `Reasons: ${match.reasons.join(", ")}`,
    "",
    formatPreview(match.preview),
  ].join("\n");
}

async function handleDiscoverSource(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const selection = await selectInventoryItem(ctx, services, "Discover provider source", canBindProviderSource);
  if (!selection) {
    return;
  }

  notify(ctx, `Searching providers for likely source of ${selection.item.name}...`, "info");
  const report = await discoverSourceMatches(selection.item, services.config, services.runner);
  if (report.matches.length === 0) {
    const providerErrors = formatProviderErrorSummary(report.sources);
    notify(ctx, providerErrors ? `No source matches found for '${report.query}'. Provider errors: ${providerErrors}` : `No source matches found for '${report.query}'.`, "warning");
    return;
  }

  const labels = ["Preview only", ...report.matches.map(sourceMatchLabel)];
  const selected = await ctx.ui.select("Bind provider source", labels);
  if (!selected || selected === "Preview only") {
    notify(ctx, report.matches.map(formatSourceMatch).join("\n\n---\n\n"), "info");
    return;
  }

  const matchIndex = labels.indexOf(selected) - 1;
  const match = matchIndex >= 0 ? report.matches[matchIndex] : undefined;
  if (!match) {
    notify(ctx, "Selected source match was not found.", "warning");
    return;
  }

  const plan = buildBindSourcePlan(selection.snapshot, selection.item.name, match);
  const planText = `${formatSourceMatch(match)}\n\n${formatPlan(plan)}`;
  if (!plan.canApply) {
    notify(ctx, planText, "warning");
    return;
  }

  await confirmAndApplyPlan(ctx, "Bind provider source?", planText, () => {
    applyBindSourcePlan(plan, selection.snapshot, match, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, `Bound ${selection.item.name} to ${match.skill.provider} source ${sourceReferenceLabel(match.skill)}. Future update checks can use this provenance.`, "info");
  });
}

function formatBulkSourceDiscoverySummary(report: BulkSourceDiscoveryReport): string {
  const lines = [
    `Checked ${String(report.checkedCount)} unlinked local skill${report.checkedCount === 1 ? "" : "s"}.`,
    `High-confidence matches: ${String(report.bindings.length)} at or above ${Math.round(MIN_AUTO_BIND_SOURCE_SCORE * 100).toString()}%.`,
    `Skipped: ${String(report.skipped.length)}.`,
  ];
  if (report.bindings.length > 0) {
    lines.push("", "Bindings:");
    for (const binding of report.bindings) {
      lines.push(`- ${binding.item.name} -> ${binding.match.skill.provider}:${sourceReferenceLabel(binding.match.skill)} (${Math.round(binding.match.score * 100).toString()}%, ${binding.match.confidence})`);
    }
  }
  if (report.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const skipped of report.skipped.slice(0, 12)) {
      const best = skipped.bestMatch ? ` Best: ${skipped.bestMatch.skill.provider}:${sourceReferenceLabel(skipped.bestMatch.skill)} (${Math.round(skipped.bestMatch.score * 100).toString()}%).` : "";
      lines.push(`- ${skipped.item.name}: ${skipped.reason}${best}`);
    }
    if (report.skipped.length > 12) {
      lines.push(`- ${String(report.skipped.length - 12)} additional skipped skills omitted from this summary.`);
    }
  }
  return lines.join("\n");
}

async function handleManualBindSource(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const selection = await selectInventoryItem(ctx, services, "Link provider source manually", canBindProviderSource);
  if (!selection) {
    return;
  }

  const sourceUrl = (await ctx.ui.input("Manual source URL", "skills.sh or GitHub source URL"))?.trim();
  if (!sourceUrl) {
    return;
  }

  let match: SourceDiscoveryMatch;
  try {
    match = await buildManualSourceMatch(
      selection.item,
      sourceUrl,
      (skill) => buildRemotePreview(skill, createPreviewHttpClient(services.config.apiKeys.github)),
    );
  } catch (error) {
    notify(ctx, getErrorMessage(error), "warning");
    return;
  }

  const plan = buildBindSourcePlan(selection.snapshot, selection.item.name, match);
  const planText = `${formatSourceMatch(match)}

${formatPlan(plan)}`;
  if (!plan.canApply) {
    notify(ctx, planText, "warning");
    return;
  }

  await confirmAndApplyPlan(ctx, "Link provider source?", planText, () => {
    applyBindSourcePlan(plan, selection.snapshot, match, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, `Linked ${selection.item.name} to ${match.skill.provider} source ${sourceReferenceLabel(match.skill)}. Future update checks can use this provenance.`, "info");
  });
}

async function handleAutoBindSources(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const currentSnapshot = snapshot(services);
  const candidates = selectableInventoryItems(currentSnapshot).filter(canBindProviderSource);
  if (candidates.length === 0) {
    notify(ctx, "No unlinked local skills are available for provider-source binding.", "info");
    return;
  }

  const startConfirmed = await ctx.ui.confirm(
    "Auto-bind provider sources?",
    `Skill Hub will scan ${String(candidates.length)} unlinked local skill${candidates.length === 1 ? "" : "s"}, compare provider results against local SKILL.md content, and only include matches at or above ${Math.round(MIN_AUTO_BIND_SOURCE_SCORE * 100).toString()}% confidence. Continue?`,
  );
  if (!startConfirmed) {
    notify(ctx, "Auto-bind cancelled before provider discovery.", "info");
    return;
  }

  notify(ctx, `Discovering provider sources for ${String(candidates.length)} unlinked local skill${candidates.length === 1 ? "" : "s"}...`, "info");
  const report = await discoverBulkSourceBindings(candidates, services.config, services.runner);
  const summary = formatBulkSourceDiscoverySummary(report);
  if (report.bindings.length === 0) {
    notify(ctx, summary, "warning");
    return;
  }

  const plan = buildBulkBindSourcePlan(currentSnapshot, report.bindings);
  const planText = `${summary}

${formatPlan(plan)}`;
  if (!plan.canApply) {
    notify(ctx, planText, "warning");
    return;
  }

  await confirmAndApplyPlan(ctx, "Bind all high-confidence sources?", planText, () => {
    applyBulkBindSourcePlan(plan, currentSnapshot, report.bindings, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, `Bound provider-source metadata for ${String(plan.operations.length)} local skill${plan.operations.length === 1 ? "" : "s"}. Skipped ${String(report.skipped.length)} low-confidence or unmatched skill${report.skipped.length === 1 ? "" : "s"}.`, "info");
  });
}

async function handleInstallById(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const skillId = (await ctx.ui.input("Install skill", "skill ID, skills.sh URL, or provider reference"))?.trim();
  if (!skillId) {
    return;
  }

  const plan = buildInstallPreviewPlan(services.config, skillId);
  const planText = formatPlan(plan);
  if (!plan.canApply) {
    notify(ctx, planText, "warning");
    return;
  }

  await confirmAndApplyPlan(ctx, "Install skill?", planText, async () => {
    await applyInstallPlan(plan, services.config, services.runner, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, `Installed ${skillId}. Run /reload to refresh available skills.`, "info");
  });
}

function availableUpdateResults(results: readonly UpdateStatusResult[]): UpdateStatusResult[] {
  return results.filter((result) => result.status === "available" && result.applicable);
}

function formatBatchUpdatePreview(reportText: string, available: readonly UpdateStatusResult[]): string {
  const lines = [
    reportText,
    "",
    `Batch update will apply ${String(available.length)} available skill update${available.length === 1 ? "" : "s"}:`,
  ];
  for (const result of available) {
    lines.push(`- ${result.item.name}: ${result.reason}`);
  }
  lines.push("", "Each skill is revalidated before replacement; independent failures are reported without hiding other results.");
  return lines.join("\n");
}

async function applyBatchUpdates(
  available: readonly UpdateStatusResult[],
  reportText: string,
  ctx: ExtensionCommandContext,
  services: CommandServices,
  currentSnapshot: InventorySnapshot,
): Promise<void> {
  const plans = available.map((result) => ({ result, plan: buildUpdateApplyPlan({
    target: result.item.name,
    checkedAt: new Date().toISOString(),
    results: [result],
  }, result.item.name) }));
  const blocked = plans.filter((entry) => !entry.plan.canApply);
  const applicable = plans.filter((entry) => entry.plan.canApply);
  if (applicable.length === 0) {
    notify(ctx, `${reportText}\n\nNo available updates produced an apply-ready plan.`, "warning");
    return;
  }

  const blockedText = blocked.length > 0
    ? `\n\nSkipped before apply: ${blocked.map((entry) => entry.result.item.name).join(", ")}`
    : "";
  const previewText = `${formatBatchUpdatePreview(reportText, applicable.map((entry) => entry.result))}${blockedText}`;
  await confirmAndApplyPlan(ctx, "Apply all available updates?", previewText, async () => {
    const successes: string[] = [];
    const failures: string[] = [];
    for (const { result, plan } of applicable) {
      try {
        await applyUpdatePlan(plan, currentSnapshot, services.config, { confirmToken: plan.confirmationToken ?? "" });
        successes.push(result.item.name);
      } catch (error) {
        failures.push(`${result.item.name}: ${getErrorMessage(error)}`);
      }
    }

    const summary = [
      `Batch update complete. Updated ${String(successes.length)} of ${String(applicable.length)} skill${applicable.length === 1 ? "" : "s"}.`,
    ];
    if (successes.length > 0) {
      summary.push(`Updated: ${successes.join(", ")}. Run /reload to refresh available skills.`);
    }
    if (failures.length > 0) {
      summary.push("Failures:", ...failures.map((failure) => `- ${failure}`));
    }
    notify(ctx, summary.join("\n"), failures.length > 0 ? "warning" : "info");
  });
}

async function handleUpdate(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const currentSnapshot = snapshot(services);
  const localItems = selectableInventoryItems(currentSnapshot);
  if (localItems.length === 0) {
    notify(ctx, "No local skills are available for update checks.", "warning");
    return;
  }

  const allLabel = "All local skills";
  const itemLabels = localItems.map(menuLabel);
  const selected = await ctx.ui.select("Check skill updates", [allLabel, ...itemLabels]);
  if (!selected) {
    return;
  }

  const selectedIndex = itemLabels.indexOf(selected);
  const selectedItem = selectedIndex >= 0 ? localItems[selectedIndex] : undefined;
  const report = await checkUpdateStatuses(currentSnapshot, services.config, selectedItem?.name);
  const reportText = formatUpdateReport(report);
  const available = availableUpdateResults(report.results);
  if (available.length === 0) {
    notify(ctx, reportText, "info");
    return;
  }

  const applyAllLabel = `Apply all ${String(available.length)} available updates`;
  const updateLabels = ["Preview only", applyAllLabel, ...available.map((result, index) => menuLabel(result.item, index))];
  const updateSelection = await ctx.ui.select("Apply available update", updateLabels);
  if (!updateSelection || updateSelection === "Preview only") {
    notify(ctx, reportText, "info");
    return;
  }
  if (updateSelection === applyAllLabel) {
    await applyBatchUpdates(available, reportText, ctx, services, currentSnapshot);
    return;
  }

  const updateIndex = updateLabels.indexOf(updateSelection) - 2;
  const result = updateIndex >= 0 ? available[updateIndex] : undefined;
  if (!result) {
    notify(ctx, reportText, "warning");
    return;
  }

  const plan = buildUpdateApplyPlan(report, result.item.name);
  const planText = `${reportText}\n\n${formatPlan(plan)}`;
  if (!plan.canApply) {
    notify(ctx, planText, "warning");
    return;
  }

  await confirmAndApplyPlan(ctx, "Apply skill update?", planText, async () => {
    await applyUpdatePlan(plan, currentSnapshot, services.config, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, `Updated ${plan.confirmationToken ?? result.item.name}. Run /reload to refresh available skills.`, "info");
  });
}

async function handleRemove(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const selection = await selectInventoryItem(
    ctx,
    services,
    "Remove managed local skill",
    (item) => item.classification === "managed" && item.driftStatus === "clean",
  );
  if (!selection) {
    return;
  }

  const plan = buildRemovePreviewPlan(selection.snapshot, selection.item.name);
  const planText = formatPlan(plan);
  if (!plan.canApply) {
    notify(ctx, planText, "warning");
    return;
  }

  await confirmAndApplyPlan(ctx, "Remove skill?", planText, () => {
    applyRemovePlan(plan, services.config, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, `Removed ${plan.confirmationToken ?? selection.item.name}. Run /reload to refresh available skills.`, "info");
  });
}

async function handleRefresh(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const plan = buildRefreshPlan(snapshot(services));
  const planText = formatPlan(plan);
  if (!plan.canApply) {
    notify(ctx, planText, "info");
    return;
  }

  await confirmAndApplyPlan(ctx, "Prune stale provenance?", planText, () => {
    applyRefreshPlan(plan, { confirmToken: plan.confirmationToken ?? "" });
    notify(ctx, "Pruned stale provenance entries for missing skill directories.", "info");
  });
}

async function handleModalAction(action: SkillHubModalAction, ctx: ExtensionCommandContext, services: CommandServices): Promise<boolean> {
  switch (action) {
    case "browse":
      await handleBrowse(ctx, services);
      return true;
    case "inventory":
      await handleInventory(ctx, services);
      return true;
    case "adopt":
      await handleAdopt(ctx, services);
      return true;
    case "discover_source":
      await handleDiscoverSource(ctx, services);
      return true;
    case "auto_bind_sources":
      await handleAutoBindSources(ctx, services);
      return true;
    case "manual_bind_source":
      await handleManualBindSource(ctx, services);
      return true;
    case "install":
      await handleInstallById(ctx, services);
      return true;
    case "update":
      await handleUpdate(ctx, services);
      return true;
    case "remove":
      await handleRemove(ctx, services);
      return true;
    case "refresh":
      await handleRefresh(ctx, services);
      return true;
    case "close":
      return false;
  }
}

async function openSkillHubWorkspace(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const modalSelectionState = createSkillHubModalSelectionState();
  while (true) {
    const action = await openSkillHubModal(ctx, services, snapshot(services), modalSelectionState);
    if (!action) {
      return;
    }

    const shouldContinue = await handleModalAction(action, ctx, services);
    if (!shouldContinue) {
      return;
    }
  }
}

export function registerSkillHubCommand(pi: ExtensionAPI, services: CommandServices): void {
  pi.registerCommand("skill-hub", {
    description: "Open the Skill Hub modal for skill search, inventory, and preview-first management.",
    handler: async (args, ctx) => {
      services.logger.log("command", { modal: true, args: args.trim().length > 0 });
      try {
        if (!ctx.hasUI) {
          notify(ctx, "/skill-hub requires interactive TUI mode because subcommands are managed inside the modal.", "warning");
          return;
        }
        if (args.trim().length > 0) {
          notify(ctx, "Skill Hub subcommands moved into the /skill-hub modal. Opening the modal instead.", "info");
        }
        await openSkillHubWorkspace(ctx, services);
      } catch (error) {
        const message = getErrorMessage(error);
        services.logger.log("command error", { modal: true, message });
        notify(ctx, message, "error");
      }
    },
  });
}
