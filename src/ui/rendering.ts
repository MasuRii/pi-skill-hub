import type {
  AggregatedSearchResult,
  InventoryItem,
  InventorySnapshot,
  ProviderSearchSummary,
  SafetyPlan,
  UpdateDiffSummary,
  UpdateStatusReport,
} from "../types.js";
import { summarizeDiff } from "../update/file-diff.js";
import { sourceReferenceFromProvenanceEntry } from "../utils/source-reference.js";

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

export function formatInventory(snapshot: InventorySnapshot): string {
  if (snapshot.items.length === 0) {
    return `No skills found under ${snapshot.localRoot}.`;
  }

  const lines = ["Skill Hub inventory:"];
  for (const item of snapshot.items) {
    lines.push(
      `- ${item.name} [${item.classification}/${item.driftStatus}/${item.rootType}] ${item.path}`,
    );
  }
  return lines.join("\n");
}

export function formatInspect(item: InventoryItem | undefined): string {
  if (!item) {
    return "Skill not found.";
  }

  const lines = [
    `Skill: ${item.name}`,
    `Path: ${item.path}`,
    `Classification: ${item.classification}`,
    `Root: ${item.rootType}`,
    `Drift: ${item.driftStatus}`,
    `SKILL.md: ${item.metadata.hasSkillFile ? "yes" : "no"}`,
    `Description: ${item.metadata.description}`,
  ];
  if (item.fingerprint) {
    lines.push(`Fingerprint: ${item.fingerprint.algorithm}:${item.fingerprint.digest}`);
  }
  if (item.manifestEntry) {
    lines.push(`Provenance: ${item.manifestEntry.provenance}`);
    if (item.manifestEntry.provider) {
      lines.push(`Provider: ${item.manifestEntry.provider}`);
    }
    if (item.manifestEntry.sourceId) {
      lines.push(`Source: ${item.manifestEntry.sourceId}`);
    }
    if (item.manifestEntry.sourceUrl) {
      lines.push(`Source URL: ${item.manifestEntry.sourceUrl}`);
    }
    const reference = sourceReferenceFromProvenanceEntry(item.manifestEntry);
    if (reference?.owner) {
      lines.push(`Source owner: ${reference.owner}`);
    }
    if (reference?.repository) {
      lines.push(`Source repository: ${reference.owner ? `${reference.owner}/` : ""}${reference.repository}`);
    }
    if (reference?.path) {
      lines.push(`Source path: ${reference.path}`);
    }
  }
  return lines.join("\n");
}

export function formatProviderSourceSummary(sources: readonly ProviderSearchSummary[]): string {
  return sources
    .map((source) => `${source.provider}:${String(source.count)}${source.error ? ` (${source.error})` : ""}`)
    .join(", ");
}

export function formatProviderErrorSummary(sources: readonly ProviderSearchSummary[]): string {
  return sources
    .filter((source) => Boolean(source.error))
    .map((source) => `${source.provider}: ${source.error}`)
    .join("; ");
}

export function formatSearchResults(result: AggregatedSearchResult): string {
  const sourceText = formatProviderSourceSummary(result.sources);
  if (result.skills.length === 0) {
    return `No skills found for '${result.query}'. Sources: ${sourceText}`;
  }

  const lines = [`Found ${String(result.skills.length)} skills for '${result.query}' (${result.mode}). Sources: ${sourceText}`];
  result.skills.forEach((skill, index) => {
    lines.push(
      `${String(index + 1)}. ${skill.name} [${skill.provider}, ${String(skill.popularity)}] ${truncate(skill.description, 120)} (${skill.id})`,
    );
  });
  return lines.join("\n");
}

function formatDiff(diff: UpdateDiffSummary | undefined): string {
  if (!diff) {
    return "no diff";
  }
  const summary = summarizeDiff(diff);
  const samples = [...diff.added.map((path) => `+${path}`), ...diff.changed.map((path) => `~${path}`), ...diff.removed.map((path) => `-${path}`)]
    .slice(0, 6)
    .join(", ");
  return samples ? `${summary} (${samples})` : summary;
}

export function formatUpdateReport(report: UpdateStatusReport): string {
  if (report.results.length === 0) {
    return report.target ? `No skill matched update target '${report.target}'.` : "No local skills were available for update checks.";
  }
  const lines = ["Skill Hub update status:"];
  for (const result of report.results) {
    const marker = result.applicable ? "apply-ready" : "preview-only";
    lines.push(`- ${result.item.name}: ${result.status} (${marker}) - ${result.reason}`);
    if (result.diff) {
      lines.push(`  Diff: ${formatDiff(result.diff)}`);
    }
    if (result.item.manifestEntry?.provider || result.item.manifestEntry?.sourceId) {
      lines.push(`  Provenance: ${result.item.manifestEntry.provider ?? "unknown"} ${result.item.manifestEntry.sourceId ?? "unknown source"}`);
    }
  }
  return lines.join("\n");
}

export function formatPlan(plan: SafetyPlan): string {
  const lines = [plan.title, `Action: ${plan.action}`, `Can apply: ${plan.canApply ? "yes" : "no"}`];
  if (plan.requiresConfirmation && plan.confirmationToken) {
    lines.push(`Confirmation token: ${plan.confirmationToken}`);
  }
  if (plan.operations.length > 0) {
    lines.push("Operations:");
    for (const operation of plan.operations) {
      lines.push(`- ${operation.kind}: ${operation.description} (${operation.target})`);
    }
  }
  if (plan.blocked.length > 0) {
    lines.push("Protected/skipped:");
    for (const operation of plan.blocked) {
      lines.push(`- ${operation.kind}: ${operation.description} (${operation.target})`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  return lines.join("\n");
}
