import { visibleWidth } from "@mariozechner/pi-tui";
import { truncatePlainToWidth } from "../utils/terminal-width.js";

export interface BrowserResultColumns {
  prefix: string;
  name: string;
  provider: string;
  downloads: string;
  description: string;
}

const PREFIX_WIDTH = 2;
const NAME_COLUMN_WIDTH = 30;
const PROVIDER_COLUMN_WIDTH = 10;
const DOWNLOAD_COLUMN_WIDTH = 9;
const COLUMN_GAP = 1;

function normalizePrefix(prefix: string): string {
  return truncatePlainToWidth(prefix, PREFIX_WIDTH, "", true);
}

function paddedColumn(text: string, width: number): string {
  return truncatePlainToWidth(text, width, "…", true);
}

function rightAlignedColumn(text: string, width: number): string {
  const truncated = truncatePlainToWidth(text, width, "…", false);
  return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

export function formatBrowserResultColumns(columns: BrowserResultColumns, width: number): string {
  const minimumDescriptionWidth = 1;
  const fixedWidth = PREFIX_WIDTH + NAME_COLUMN_WIDTH + PROVIDER_COLUMN_WIDTH + DOWNLOAD_COLUMN_WIDTH + COLUMN_GAP * 3;
  const descriptionWidth = Math.max(minimumDescriptionWidth, width - fixedWidth);
  const row = [
    normalizePrefix(columns.prefix),
    paddedColumn(columns.name, NAME_COLUMN_WIDTH),
    paddedColumn(columns.provider, PROVIDER_COLUMN_WIDTH),
    rightAlignedColumn(columns.downloads, DOWNLOAD_COLUMN_WIDTH),
    truncatePlainToWidth(columns.description, descriptionWidth, "…", true),
  ].join(" ");
  return truncatePlainToWidth(row, width, "…", true);
}

export function formatBrowserResultHeader(width: number): string {
  return formatBrowserResultColumns(
    {
      prefix: "  ",
      name: "Name",
      provider: "Provider",
      downloads: "Downloads",
      description: "Description",
    },
    width,
  );
}
