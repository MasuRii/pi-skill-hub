import type { InventoryItem, InventorySnapshot } from "../types.js";
import type { ModalPane, SkillHubModalContext } from "./modal-types.js";

function plural(count: number, singular: string, pluralName = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralName}`;
}

function localItems(snapshot: InventorySnapshot): InventoryItem[] {
  return snapshot.items.filter((item) => item.rootType === "local");
}

function managedCleanItems(snapshot: InventorySnapshot): InventoryItem[] {
  return localItems(snapshot).filter((item) => item.classification === "managed" && item.driftStatus === "clean");
}

function unmanagedItems(snapshot: InventorySnapshot): InventoryItem[] {
  return localItems(snapshot).filter((item) => item.classification === "unknown");
}

function unlinkedSourceCandidates(snapshot: InventorySnapshot): InventoryItem[] {
  return localItems(snapshot).filter((item) => (
    item.classification !== "missing" && !(item.classification === "managed" && Boolean(item.manifestEntry?.provider && item.manifestEntry.sourceId))
  ));
}

function driftedItems(snapshot: InventorySnapshot): InventoryItem[] {
  return localItems(snapshot).filter((item) => item.driftStatus === "drifted" || item.driftStatus === "missing");
}

function inventorySummary(snapshot: InventorySnapshot): string {
  const local = localItems(snapshot);
  const managed = local.filter((item) => item.classification === "managed");
  const adopted = local.filter((item) => item.classification === "adopted");
  const unknown = unmanagedItems(snapshot);
  return `${plural(local.length, "local skill")} • ${plural(managed.length, "managed", "managed")} • ${plural(adopted.length, "adopted", "adopted")} • ${plural(unknown.length, "unmanaged", "unmanaged")}`;
}

function previewSkillLines(snapshot: InventorySnapshot, limit: number): string[] {
  const items = localItems(snapshot).slice(0, limit);
  if (items.length === 0) {
    return [`Local root: ${snapshot.localRoot}`, "No local skills were discovered in the configured roots."];
  }
  return [
    `Local root: ${snapshot.localRoot}`,
    ...items.map((item) => `• ${item.name} [${item.classification}/${item.driftStatus}]`),
    ...(localItems(snapshot).length > items.length ? [`• ${String(localItems(snapshot).length - items.length)} more not shown`] : []),
  ];
}

export function createSkillHubPanes(context: SkillHubModalContext): readonly ModalPane[] {
  const snapshot = context.snapshot;
  const managedClean = managedCleanItems(snapshot);
  const unmanaged = unmanagedItems(snapshot);
  const unlinked = unlinkedSourceCandidates(snapshot);
  const drifted = driftedItems(snapshot);

  return [
    {
      id: "browse",
      title: "Browse",
      summary: "Search provider catalogs, preview remote SKILL.md content, then confirm installs.",
      details: [
        "Use the existing provider search and markdown preview engine inside the Skill Hub workspace.",
        "Search results are sorted and filtered before the install plan is built.",
      ],
      actions: [
        {
          action: "browse",
          label: "Browse/search/install remote skills",
          description: "Open searchable provider results with remote preview before install confirmation.",
          safety: "Install remains preview-first and requires explicit confirmation.",
        },
      ],
    },
    {
      id: "inventory",
      title: "Inventory",
      summary: inventorySummary(snapshot),
      details: previewSkillLines(snapshot, 8),
      actions: [
        {
          action: "inventory",
          label: "Inspect local inventory",
          description: "Select any discovered skill and inspect classification, drift, root, and provenance.",
          safety: "Read-only inventory inspection.",
        },
        {
          action: "adopt",
          label: `Adopt unmanaged local skill (${String(unmanaged.length)} available)`,
          description: "Record provenance for a selected unmanaged local skill without changing its files.",
          safety: "Adoption writes manifest metadata only after plan confirmation.",
        },
      ],
    },
    {
      id: "install",
      title: "Install",
      summary: "Install directly from a skill ID, skills.sh URL, GitHub URL, or provider reference.",
      details: [
        "The install descriptor is validated against the local skill root before any command runs.",
        "Existing local directories are protected from overwrite.",
      ],
      actions: [
        {
          action: "install",
          label: "Install by reference",
          description: "Enter an install reference and review the generated plan.",
          safety: "Installer execution requires confirmation token matching the resolved reference.",
        },
      ],
    },
    {
      id: "update",
      title: "Update",
      summary: `${plural(managedClean.length, "clean managed skill")} eligible for update checks; ${plural(drifted.length, "drifted/missing skill")} protected.`,
      details: [
        "Update checks resolve provider content into staging before any local replacement.",
        "Batch apply revalidates each selected update independently and reports failures.",
      ],
      actions: [
        {
          action: "update",
          label: "Check/apply updates",
          description: "Check all local skills or one selected skill, then preview available update plans.",
          safety: "Updates replace only clean managed local skills after confirmation.",
        },
        {
          action: "refresh",
          label: "Refresh inventory and drift status",
          description: "Scan inventory and prune stale manifest entries for missing directories when applicable.",
          safety: "Refresh previews stale provenance pruning before writing the manifest.",
        },
      ],
    },
    {
      id: "sources",
      title: "Sources",
      summary: `${plural(unlinked.length, "local skill")} can be evaluated for provider-source binding.`,
      details: [
        "Source discovery compares provider results against local skill metadata and SKILL.md content.",
        "Auto-bind includes only high-confidence matches and skips the rest.",
      ],
      actions: [
        {
          action: "discover_source",
          label: "Discover and bind provider source",
          description: "Find likely upstream provider sources for a selected local skill.",
          safety: "Binding updates provenance metadata only after preview and confirmation.",
        },
        {
          action: "auto_bind_sources",
          label: "Auto-bind high-confidence sources",
          description: "Scan all unlinked local skills and stage high-confidence source bindings.",
          safety: "Bulk binding requires confirmation and excludes low-confidence matches.",
        },
        {
          action: "manual_bind_source",
          label: "Link source manually by URL",
          description: "Provide a skills.sh or GitHub source URL for a selected local skill.",
          safety: "Manual binding writes provenance metadata only after preview and confirmation.",
        },
      ],
    },
    {
      id: "remove",
      title: "Remove",
      summary: `${plural(managedClean.length, "clean managed skill")} can be removed by Skill Hub.`,
      details: [
        "Removal is limited to clean managed local skills with provenance metadata.",
        "External, unknown, drifted, and missing skills are protected from deletion.",
      ],
      actions: [
        {
          action: "remove",
          label: "Remove managed skill",
          description: "Select a clean managed local skill and review the removal plan.",
          safety: "Directory deletion and manifest update require explicit confirmation.",
        },
      ],
    },
  ];
}
