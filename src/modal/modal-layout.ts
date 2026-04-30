import type { TUI } from "@mariozechner/pi-tui";

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export interface ModalDimensions {
  readonly terminal: TerminalDimensions;
  readonly width: number;
  readonly maxRows: number;
  readonly innerWidth: number;
  readonly bodyRows: number;
}

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 36;
const MIN_MODAL_WIDTH = 64;
const MAX_MODAL_WIDTH = 132;
const MIN_MODAL_ROWS = 18;
const WIDTH_RATIO = 0.92;
const HEIGHT_RATIO = 0.90;
const NON_BODY_ROWS = 10;

function safePositiveInteger(value: number | undefined, defaultValue: number): number {
  if (typeof value !== "number") {
    return defaultValue;
  }
  return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

export function terminalDimensions(tui: TUI): TerminalDimensions {
  return {
    columns: safePositiveInteger(tui.terminal?.columns, DEFAULT_COLUMNS),
    rows: safePositiveInteger(tui.terminal?.rows, DEFAULT_ROWS),
  };
}

export function calculateSkillHubModalDimensions(tui: TUI): ModalDimensions {
  const terminal = terminalDimensions(tui);
  const availableWidth = Math.max(1, terminal.columns - 4);
  const preferredWidth = Math.floor(terminal.columns * WIDTH_RATIO);
  const width = Math.max(1, Math.min(MAX_MODAL_WIDTH, availableWidth, Math.max(MIN_MODAL_WIDTH, preferredWidth)));
  const availableRows = Math.max(1, terminal.rows - 2);
  const preferredRows = Math.max(MIN_MODAL_ROWS, Math.floor(terminal.rows * HEIGHT_RATIO));
  const maxRows = Math.max(1, Math.min(availableRows, preferredRows));
  const innerWidth = Math.max(1, width - 2);
  const bodyRows = Math.max(1, maxRows - NON_BODY_ROWS);
  return { terminal, width, maxRows, innerWidth, bodyRows };
}

export function distributeTitle(innerWidth: number, title: string): { left: number; right: number } {
  const remaining = Math.max(0, innerWidth - title.length);
  const left = Math.floor(remaining / 2);
  return { left, right: remaining - left };
}
