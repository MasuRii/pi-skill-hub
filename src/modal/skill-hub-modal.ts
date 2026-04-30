import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";
import type { SkillHubConfig } from "../config/config.js";
import type { InventorySnapshot } from "../types.js";
import { sanitizeTerminalText } from "../utils/terminal-text.js";
import { calculateSkillHubModalDimensions, distributeTitle } from "./modal-layout.js";
import { createSkillHubPanes } from "./panes.js";
import type { ModalActionItem, ModalPane, SkillHubModalAction, SkillHubModalContext } from "./modal-types.js";

interface SkillHubModalServices {
  readonly config: SkillHubConfig;
}

const EMPTY_ACTION_INDEX = 0;

export interface SkillHubModalSelectionState {
  selectedPaneId: string;
  actionIndexesByPaneId: Record<string, number>;
}

export function createSkillHubModalSelectionState(): SkillHubModalSelectionState {
  return { selectedPaneId: "browse", actionIndexesByPaneId: {} };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return EMPTY_ACTION_INDEX;
  }
  return Math.min(Math.max(0, index), length - 1);
}

function actionCount(pane: ModalPane): number {
  return pane.actions.length;
}

class SkillHubModal implements Component, Focusable {
  private readonly panes: readonly ModalPane[];
  private focusedValue = false;
  private paneIndex = 0;
  private actionIndexes: number[];

  public get focused(): boolean {
    return this.focusedValue;
  }

  public set focused(value: boolean) {
    this.focusedValue = value;
  }

  public constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    modal: SkillHubModalContext,
    private readonly done: (action: SkillHubModalAction | undefined) => void,
    private readonly selectionState: SkillHubModalSelectionState = createSkillHubModalSelectionState(),
  ) {
    this.panes = createSkillHubPanes(modal);
    const restoredPaneIndex = this.panes.findIndex((pane) => pane.id === this.selectionState.selectedPaneId);
    this.paneIndex = restoredPaneIndex >= 0 ? restoredPaneIndex : 0;
    this.actionIndexes = this.panes.map((pane) => clampIndex(this.selectionState.actionIndexesByPaneId[pane.id] ?? EMPTY_ACTION_INDEX, pane.actions.length));
    this.persistSelection();
  }

  private persistSelection(): void {
    const pane = this.panes[this.paneIndex];
    if (!pane) {
      return;
    }
    this.selectionState.selectedPaneId = pane.id;
    for (const [index, candidatePane] of this.panes.entries()) {
      this.selectionState.actionIndexesByPaneId[candidatePane.id] = clampIndex(
        this.actionIndexes[index] ?? EMPTY_ACTION_INDEX,
        candidatePane.actions.length,
      );
    }
  }

  private currentPane(): ModalPane {
    const pane = this.panes[this.paneIndex];
    if (!pane) {
      throw new Error("Skill Hub modal has no panes to render.");
    }
    return pane;
  }

  private currentAction(): ModalActionItem | undefined {
    const pane = this.currentPane();
    const index = clampIndex(this.actionIndexes[this.paneIndex] ?? EMPTY_ACTION_INDEX, actionCount(pane));
    this.actionIndexes[this.paneIndex] = index;
    return pane.actions[index];
  }

  private movePane(delta: number): void {
    this.paneIndex = (this.paneIndex + delta + this.panes.length) % this.panes.length;
    this.persistSelection();
    this.tui.requestRender();
  }

  private moveAction(delta: number): void {
    const pane = this.currentPane();
    if (pane.actions.length === 0) {
      return;
    }
    const current = this.actionIndexes[this.paneIndex] ?? EMPTY_ACTION_INDEX;
    this.actionIndexes[this.paneIndex] = (current + delta + pane.actions.length) % pane.actions.length;
    this.persistSelection();
    this.tui.requestRender();
  }

  private selectAction(): void {
    const action = this.currentAction();
    if (action) {
      this.persistSelection();
      this.done(action.action);
    }
  }

  private styleTab(pane: ModalPane, selected: boolean): string {
    const label = ` ${pane.title} `;
    return selected ? this.theme.fg("accent", this.theme.bold(`[${label}]`)) : this.theme.fg("dim", ` ${label} `);
  }

  private border(content: string, width: number): string {
    return this.theme.fg("border", content.slice(0, width));
  }

  private pad(content: string, width: number): string {
    const innerWidth = Math.max(1, width - 2);
    return this.theme.fg("border", "│") + truncateToWidth(content, innerWidth, "…", true) + this.theme.fg("border", "│");
  }

  private empty(width: number): string {
    return this.pad("", width);
  }

  private renderWrappedText(prefix: string, text: string, width: number, maxRows: number): string[] {
    const normalized = sanitizeTerminalText(text);
    const innerWidth = Math.max(1, width - 2);
    const available = Math.max(1, innerWidth - prefix.length);
    const words = normalized.split(/\s+/u).filter(Boolean);
    const rows: string[] = [];
    let line = prefix;
    for (const word of words) {
      const separator = line === prefix ? "" : " ";
      if ((line + separator + word).length > prefix.length + available && line !== prefix) {
        rows.push(line);
        line = `${" ".repeat(prefix.length)}${word}`;
      } else {
        line += `${separator}${word}`;
      }
    }
    if (line.trim().length > 0) {
      rows.push(line);
    }
    return rows.slice(0, maxRows).map((row) => this.pad(row, width));
  }

  private renderTabs(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const tabs = this.panes.map((pane, index) => this.styleTab(pane, index === this.paneIndex)).join(" ");
    return [this.pad(truncateToWidth(tabs, innerWidth, "…", true), width)];
  }

  private renderPaneBody(pane: ModalPane, width: number, bodyRows: number): string[] {
    const lines: string[] = [];
    lines.push(...this.renderWrappedText(" ", pane.summary, width, 2));
    lines.push(this.empty(width));

    const detailBudget = Math.max(2, Math.floor(bodyRows * 0.45));
    for (const detail of pane.details.slice(0, detailBudget)) {
      lines.push(this.pad(`  ${sanitizeTerminalText(detail)}`, width));
    }
    lines.push(this.empty(width));
    lines.push(this.pad(this.theme.fg("accent", " Actions"), width));

    const selectedActionIndex = this.actionIndexes[this.paneIndex] ?? EMPTY_ACTION_INDEX;
    const remainingRows = Math.max(0, bodyRows - lines.length);
    const visibleActions = pane.actions.slice(0, remainingRows);
    for (const [index, action] of visibleActions.entries()) {
      const selected = index === selectedActionIndex;
      const marker = selected ? "→" : " ";
      const label = `${marker} ${action.label}`;
      lines.push(this.pad(selected ? this.theme.fg("accent", label) : label, width));
      if (lines.length < bodyRows) {
        lines.push(this.pad(`    ${this.theme.fg("dim", sanitizeTerminalText(action.description))}`, width));
      }
      if (lines.length < bodyRows) {
        lines.push(this.pad(`    Safety: ${this.theme.fg("warning", sanitizeTerminalText(action.safety))}`, width));
      }
    }

    while (lines.length < bodyRows) {
      lines.push(this.empty(width));
    }
    return lines.slice(0, bodyRows);
  }

  public render(width: number): string[] {
    const dimensions = calculateSkillHubModalDimensions(this.tui);
    const modalWidth = Math.max(1, Math.min(Math.max(1, width), dimensions.width));
    const innerWidth = Math.max(1, modalWidth - 2);
    const pane = this.currentPane();
    const title = " Skill Hub ";
    const titlePad = distributeTitle(innerWidth, title);
    const lines: string[] = [];

    lines.push(
      this.theme.fg("border", `╭${"─".repeat(titlePad.left)}`) +
        this.theme.fg("accent", this.theme.bold(title)) +
        this.theme.fg("border", `${"─".repeat(titlePad.right)}╮`),
    );
    lines.push(...this.renderTabs(modalWidth));
    lines.push(this.border(`├${"─".repeat(innerWidth)}┤`, modalWidth));
    lines.push(...this.renderPaneBody(pane, modalWidth, dimensions.bodyRows));
    lines.push(this.border(`├${"─".repeat(innerWidth)}┤`, modalWidth));
    lines.push(this.pad(` ${this.theme.fg("dim", "←/→ tabs • ↑/↓ actions • enter run • esc close")}`, modalWidth));
    lines.push(this.pad(` ${this.theme.fg("dim", `Terminal ${String(dimensions.terminal.columns)}×${String(dimensions.terminal.rows)} • workspace ${String(modalWidth)}×${String(lines.length + 2)}`)}`, modalWidth));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  public invalidate(): void {
    this.actionIndexes = this.panes.map((pane, index) => clampIndex(this.actionIndexes[index] ?? EMPTY_ACTION_INDEX, pane.actions.length));
    this.persistSelection();
  }

  public handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done("close");
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
      this.movePane(-1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.movePane(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveAction(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveAction(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectAction();
    }
  }
}

export function createSkillHubModal(
  tui: TUI,
  theme: Theme,
  services: SkillHubModalServices,
  snapshot: InventorySnapshot,
  done: (action: SkillHubModalAction | undefined) => void,
  selectionState: SkillHubModalSelectionState = createSkillHubModalSelectionState(),
): Component & Focusable {
  return new SkillHubModal(tui, theme, { config: services.config, snapshot }, done, selectionState);
}

export async function openSkillHubModal(
  ctx: ExtensionCommandContext,
  services: SkillHubModalServices,
  snapshot: InventorySnapshot,
  selectionState: SkillHubModalSelectionState = createSkillHubModalSelectionState(),
): Promise<SkillHubModalAction | undefined> {
  let overlayTui: TUI | undefined;
  return ctx.ui.custom<SkillHubModalAction | undefined>(
    (tui, theme, _keybindings, done) => {
      overlayTui = tui;
      return createSkillHubModal(tui, theme, services, snapshot, done, selectionState);
    },
    {
      overlay: true,
      overlayOptions: () => {
        const dimensions = overlayTui ? calculateSkillHubModalDimensions(overlayTui) : undefined;
        return {
          anchor: "center",
          width: dimensions?.width ?? 40,
          maxHeight: dimensions?.maxRows ?? "90%",
          margin: 1,
        };
      },
    },
  );
}
