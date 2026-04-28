import type { Theme } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { sanitizeTerminalText } from "../utils/terminal-text.js";

interface MarkdownCacheEntry {
  text: string;
  width: number;
  lines: string[];
}

function createMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

export class MarkdownPreviewRenderer {
  private readonly markdownTheme: MarkdownTheme;
  private readonly cache = new Map<string, MarkdownCacheEntry>();

  public constructor(theme: Theme) {
    this.markdownTheme = createMarkdownTheme(theme);
  }

  public clear(): void {
    this.cache.clear();
  }

  public delete(key: string): void {
    this.cache.delete(key);
  }

  public renderBody(cacheKey: string, body: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const sanitizedBody = sanitizeTerminalText(body.trim());
    if (sanitizedBody.length === 0) {
      return [];
    }

    const cached = this.cache.get(cacheKey);
    if (cached && cached.text === sanitizedBody && cached.width === safeWidth) {
      return cached.lines;
    }

    const lines = new Markdown(sanitizedBody, 0, 0, this.markdownTheme).render(safeWidth);
    this.cache.set(cacheKey, { text: sanitizedBody, width: safeWidth, lines });
    return lines;
  }
}
