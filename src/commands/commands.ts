import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SkillHubConfig } from "../config/config.js";
import type { DebugLogger } from "../logging/debug-logger.js";
import { collectInventory, findInventoryItem } from "../inventory/inventory.js";
import { loadManifest } from "../manifest/manifest-store.js";
import type { CommandRunner, SkillSearchResult } from "../types.js";
import { createProviders } from "../providers/index.js";
import { searchAllProviders, chooseSearchMode, normalizeQuery } from "../search/search.js";
import { buildAdoptPlan, buildInstallPreviewPlan, buildRefreshPlan, buildRemovePreviewPlan, buildUpdateApplyPlan } from "../plans/plans.js";
import { applyAdoptPlan, applyInstallPlan, applyRemovePlan } from "../plans/apply.js";
import { applyUpdatePlan } from "../update/update-apply.js";
import { checkUpdateStatuses } from "../update/update-checker.js";
import { getErrorMessage } from "../utils/errors.js";
import { formatHelp, formatInspect, formatInventory, formatPlan, formatSearchResults, formatUpdateReport } from "../ui/rendering.js";
import { openSkillBrowser } from "../browser/browser-ui.js";
import { buildRemotePreview, formatPreview } from "../browser/preview.js";

interface CommandServices {
  config: SkillHubConfig;
  runner: CommandRunner;
  logger: DebugLogger;
}

interface ParsedArgs {
  subcommand: string;
  rest: string[];
  apply: boolean;
  confirmToken?: string | undefined;
}

function tokenize(args: string): string[] {
  const matches = args.match(/"([^"]*)"|'([^']*)'|(\S+)/gu) ?? [];
  return matches.map((token) => token.replace(/^"([^"]*)"$/u, "$1").replace(/^'([^']*)'$/u, "$1"));
}

function parseArgs(args: string): ParsedArgs {
  const tokens = tokenize(args);
  const subcommand = tokens.length === 0 ? "browse" : tokens.shift()?.toLowerCase() ?? "browse";
  const rest: string[] = [];
  let apply = false;
  let confirmToken: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--confirm") {
      confirmToken = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token) {
      rest.push(token);
    }
  }

  return { subcommand, rest, apply, confirmToken };
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}

function snapshot(services: CommandServices) {
  const manifest = loadManifest();
  return collectInventory(services.config, manifest);
}

async function handleSearch(parsed: ParsedArgs, ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const query = normalizeQuery(parsed.rest.join(" "));
  if (!query) {
    notify(ctx, "Usage: /skill-hub search <query>", "warning");
    return;
  }

  const result = await searchAllProviders(
    query,
    chooseSearchMode(query),
    createProviders(services.config, services.runner),
    services.config.maxSearchResults,
  );
  notify(ctx, formatSearchResults(result), "info");
}

function handleList(ctx: ExtensionCommandContext, services: CommandServices): void {
  notify(ctx, formatInventory(snapshot(services)), "info");
}

function handleInspect(parsed: ParsedArgs, ctx: ExtensionCommandContext, services: CommandServices): void {
  const target = parsed.rest.join(" ");
  if (!target) {
    notify(ctx, "Usage: /skill-hub inspect <skill>", "warning");
    return;
  }
  const item = findInventoryItem(snapshot(services), target);
  notify(ctx, formatInspect(item), item ? "info" : "warning");
}

async function handleAdopt(parsed: ParsedArgs, ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const target = parsed.rest.join(" ");
  if (!target) {
    notify(ctx, "Usage: /skill-hub adopt <skill> [--apply --confirm <skill>]", "warning");
    return;
  }

  const currentSnapshot = snapshot(services);
  const plan = buildAdoptPlan(currentSnapshot, target);
  if (!parsed.apply) {
    notify(ctx, formatPlan(plan), "info");
    return;
  }

  applyAdoptPlan(plan, currentSnapshot, { confirmToken: parsed.confirmToken ?? "" });
  notify(ctx, `Adopted ${plan.confirmationToken ?? target}. Run /reload if skill command visibility changed.`, "info");
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

async function handleInstall(parsed: ParsedArgs, ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const skillId = parsed.rest.join(" ");
  if (!skillId) {
    notify(ctx, "Usage: /skill-hub install <skill-id> [--apply --confirm <skill-id>]", "warning");
    return;
  }

  const plan = buildInstallPreviewPlan(services.config, skillId);
  if (!parsed.apply) {
    notify(ctx, formatPlan(plan), "info");
    return;
  }

  await applyInstallPlan(plan, services.config, services.runner, { confirmToken: parsed.confirmToken ?? "" });
  notify(ctx, `Installed ${skillId}. Run /reload to refresh available skills.`, "info");
}

async function handleUpdate(parsed: ParsedArgs, ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const target = parsed.rest.join(" ").trim();
  const currentSnapshot = snapshot(services);
  const report = await checkUpdateStatuses(currentSnapshot, services.config, target || undefined);
  if (!parsed.apply) {
    notify(ctx, formatUpdateReport(report), "info");
    return;
  }
  if (!target) {
    notify(ctx, "Usage: /skill-hub update <skill> --apply --confirm <skill>", "warning");
    return;
  }

  const plan = buildUpdateApplyPlan(report, target);
  if (!plan.canApply) {
    notify(ctx, `${formatUpdateReport(report)}\n\n${formatPlan(plan)}`, "warning");
    return;
  }
  await applyUpdatePlan(plan, currentSnapshot, services.config, { confirmToken: parsed.confirmToken ?? "" });
  notify(ctx, `Updated ${plan.confirmationToken ?? target}. Run /reload to refresh available skills.`, "info");
}

function handleRemove(parsed: ParsedArgs, ctx: ExtensionCommandContext, services: CommandServices): void {
  const target = parsed.rest.join(" ");
  if (!target) {
    notify(ctx, "Usage: /skill-hub remove <skill> [--apply --confirm <skill>]", "warning");
    return;
  }

  const plan = buildRemovePreviewPlan(snapshot(services), target);
  if (!parsed.apply) {
    notify(ctx, formatPlan(plan), "info");
    return;
  }

  applyRemovePlan(plan, services.config, { confirmToken: parsed.confirmToken ?? "" });
  notify(ctx, `Removed ${plan.confirmationToken ?? target}. Run /reload to refresh available skills.`, "info");
}

function handleRefresh(ctx: ExtensionCommandContext, services: CommandServices): void {
  notify(ctx, formatPlan(buildRefreshPlan(snapshot(services))), "info");
}

async function handleBrowse(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
  const action = await openSkillBrowser(ctx, services);
  if (!action) {
    return;
  }
  const preview = action.preview ?? await buildRemotePreview(action.skill);
  const confirmed = await ctx.ui.confirm("Install skill from Skill Hub?", `${formatPreview(preview)}\n\nInstall ${action.skill.id}?`);
  if (!confirmed) {
    notify(ctx, "Install cancelled before mutation.", "info");
    return;
  }
  await installSkill(action.skill, ctx, services);
}

export function registerSkillHubCommand(pi: ExtensionAPI, services: CommandServices): void {
  pi.registerCommand("skill-hub", {
    description: "Safe provenance-aware skill search, inventory, and preview-first management.",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      services.logger.log("command", { subcommand: parsed.subcommand, apply: parsed.apply });
      try {
        switch (parsed.subcommand) {
          case "browse":
            await handleBrowse(ctx, services);
            return;
          case "search":
            await handleSearch(parsed, ctx, services);
            return;
          case "list":
            handleList(ctx, services);
            return;
          case "inspect":
            handleInspect(parsed, ctx, services);
            return;
          case "adopt":
            await handleAdopt(parsed, ctx, services);
            return;
          case "install":
            await handleInstall(parsed, ctx, services);
            return;
          case "update":
            await handleUpdate(parsed, ctx, services);
            return;
          case "remove":
            handleRemove(parsed, ctx, services);
            return;
          case "refresh":
            handleRefresh(ctx, services);
            return;
          case "help":
          default:
            notify(ctx, formatHelp(), "info");
        }
      } catch (error) {
        const message = getErrorMessage(error);
        services.logger.log("command error", { subcommand: parsed.subcommand, message });
        notify(ctx, message, "error");
      }
    },
  });
}
