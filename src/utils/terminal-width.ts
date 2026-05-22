import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.js";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TAB_WIDTH = 3;

function normalizePlainTerminalText(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(/\t/gu, " ".repeat(TAB_WIDTH));
}

function slicePlainToWidth(value: string, maxWidth: number): { text: string; width: number } {
  if (maxWidth <= 0) {
    return { text: "", width: 0 };
  }

  let text = "";
  let width = 0;
  for (const { segment } of SEGMENTER.segment(value)) {
    const segmentWidth = visibleWidth(segment);
    if (width + segmentWidth > maxWidth) {
      break;
    }
    text += segment;
    width += segmentWidth;
  }
  return { text, width };
}

export function truncatePlainToWidth(value: string, maxWidth: number, ellipsis = "…", pad = false): string {
  if (maxWidth <= 0) {
    return "";
  }

  const text = normalizePlainTerminalText(value);
  const textWidth = visibleWidth(text);
  if (textWidth <= maxWidth) {
    return pad ? text + " ".repeat(maxWidth - textWidth) : text;
  }

  const normalizedEllipsis = normalizePlainTerminalText(ellipsis);
  const ellipsisWidth = visibleWidth(normalizedEllipsis);
  if (ellipsisWidth >= maxWidth) {
    const clippedEllipsis = slicePlainToWidth(normalizedEllipsis, maxWidth);
    return pad
      ? clippedEllipsis.text + " ".repeat(maxWidth - clippedEllipsis.width)
      : clippedEllipsis.text;
  }

  const prefix = slicePlainToWidth(text, maxWidth - ellipsisWidth);
  const truncated = `${prefix.text}${normalizedEllipsis}`;
  const truncatedWidth = prefix.width + ellipsisWidth;
  return pad ? truncated + " ".repeat(maxWidth - truncatedWidth) : truncated;
}
