import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { SkillHubConfig } from "../config/config.js";
import type { InventorySnapshot } from "../types.js";

export type SkillHubModalAction =
  | "browse"
  | "inventory"
  | "adopt"
  | "discover_source"
  | "auto_bind_sources"
  | "manual_bind_source"
  | "install"
  | "update"
  | "remove"
  | "refresh"
  | "close";

export interface ModalActionItem {
  readonly action: SkillHubModalAction;
  readonly label: string;
  readonly description: string;
  readonly safety: string;
}

export interface ModalPane {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly details: readonly string[];
  readonly actions: readonly ModalActionItem[];
}

export interface SkillHubModalContext {
  readonly config: SkillHubConfig;
  readonly snapshot: InventorySnapshot;
}

export interface SkillHubModalRendererContext {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly modal: SkillHubModalContext;
}
