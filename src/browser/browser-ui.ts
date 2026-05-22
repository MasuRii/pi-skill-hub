import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  SelectList,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SkillHubConfig } from "../config/config.js";
import type { CommandRunner, InventorySnapshot, ProviderSearchSummary, SkillContentPreview, SkillSearchResult } from "../types.js";
import { createProviders } from "../providers/index.js";
import { createInstallDescriptor } from "../plans/install-descriptor.js";
import { chooseSearchMode, normalizeQuery, searchAllProviders } from "../search/search.js";
import { formatProviderErrorSummary } from "../ui/rendering.js";
import { getErrorMessage } from "../utils/errors.js";
import { sanitizeTerminalText } from "../utils/terminal-text.js";
import { sourceIdentityKey } from "../utils/source-reference.js";
import {
  browserPageCount,
  clampBrowserPageIndex,
  createBrowserState,
  cycleProviderFilter,
  cycleSortMode,
  pagedBrowserResults,
  type BrowserState,
  visibleBrowserResults,
} from "./browser-model.js";
import { createInstalledSkillIndex, installedSkillStatus, type InstalledSkillIndex, type InstalledSkillStatus } from "./installed-skill-index.js";
import { MarkdownPreviewRenderer } from "./markdown-preview.js";
import { buildMetadataPreview, buildRemotePreview, createPreviewHttpClient, formatPreviewMetadataTags } from "./preview.js";
import { formatBrowserResultColumns, formatBrowserResultHeader } from "./result-layout.js";

export type BrowserAction = { type: "install"; skill: SkillSearchResult; preview?: SkillContentPreview | undefined } | null;

export type SkillPreviewBuilder = (skill: SkillSearchResult) => Promise<SkillContentPreview>;

export interface BrowserServices {
  config: SkillHubConfig;
  runner: CommandRunner;
  previewBuilder?: SkillPreviewBuilder | undefined;
  inventorySnapshot?: InventorySnapshot | undefined;
}

export interface SkillBrowserSessionState {
  state: BrowserState;
  hasSearched: boolean;
  providerSources: ProviderSearchSummary[];
  selectedSkillKey: string;
}

export function createSkillBrowserSessionState(): SkillBrowserSessionState {
  return {
    state: createBrowserState(),
    hasSearched: false,
    providerSources: [],
    selectedSkillKey: "",
  };
}

type StatusTone = "dim" | "warning" | "error";
type BrowserViewMode = "list" | "preview";

interface StatusLine {
  text: string;
  tone: StatusTone;
}

interface BrowserResultEntry {
  key: string;
  skill: SkillSearchResult;
}

interface PreviewCacheEntry {
  status: "loading" | "ready";
  requestId: number;
  preview?: SkillContentPreview | undefined;
}

interface PreviewRows {
  bodyHeight: number;
  bodyLineCount: number;
  rows: string[];
}

interface BrowserListCapacityOptions {
  terminalRows: number;
  resultCount: number;
  maxSearchResults: number;
}

const DEFAULT_TERMINAL_ROWS = 30;
const OVERLAY_HEIGHT_RATIO = 0.85;
const LIST_RESERVED_ROWS = 9;
const PREVIEW_RESERVED_ROWS = 8;

function resultCacheKey(skill: SkillSearchResult): string {
  return sourceIdentityKey(skill);
}

function resultEntryKey(skill: SkillSearchResult, visibleIndex: number): string {
  return `${resultCacheKey(skill)}#${String(visibleIndex)}`;
}

function safeTerminalRows(tui: TUI): number {
  const rows = tui.terminal?.rows;
  return Number.isInteger(rows) && rows > 0 ? rows : DEFAULT_TERMINAL_ROWS;
}

export function calculateBrowserListMaxVisible(options: BrowserListCapacityOptions): number {
  const maxOverlayRows = Math.max(1, Math.floor(options.terminalRows * OVERLAY_HEIGHT_RATIO));
  const availableRows = Math.max(1, maxOverlayRows - LIST_RESERVED_ROWS);
  const cappedResultCount = Math.max(1, Math.min(options.resultCount, options.maxSearchResults));
  let visibleRows = Math.min(cappedResultCount, availableRows);
  if (options.resultCount > visibleRows && visibleRows === availableRows && visibleRows > 1) {
    visibleRows -= 1;
  }
  return Math.max(1, visibleRows);
}

class SkillBrowserModal implements Component, Focusable {
  private readonly state: BrowserState;
  private readonly input = new Input();
  private readonly installedIndex: InstalledSkillIndex;
  private list: SelectList;
  private isSearching = false;
  private hasSearched: boolean;
  private error = "";
  private providerSources: ProviderSearchSummary[];
  private searchGeneration = 0;
  private focusedValue = false;
  private viewMode: BrowserViewMode = "list";
  private selectedSkillKey = "";
  private readonly previewCache = new Map<string, PreviewCacheEntry>();
  private readonly markdownPreviewRenderer: MarkdownPreviewRenderer;
  private previewGeneration = 0;
  private previewScrollOffset = 0;
  private lastInnerWidth = 80;

  public get focused(): boolean {
    return this.focusedValue;
  }

  public set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value && this.viewMode === "list";
  }

  public constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly services: BrowserServices,
    private readonly done: (action: BrowserAction) => void,
    private readonly sessionState: SkillBrowserSessionState = createSkillBrowserSessionState(),
  ) {
    this.state = sessionState.state;
    this.hasSearched = sessionState.hasSearched;
    this.providerSources = [...sessionState.providerSources];
    this.selectedSkillKey = sessionState.selectedSkillKey;
    this.installedIndex = createInstalledSkillIndex(services.inventorySnapshot);
    this.markdownPreviewRenderer = new MarkdownPreviewRenderer(theme);
    this.input.setValue(this.state.query);
    this.input.onSubmit = (value) => {
      void this.search(value);
    };
    this.input.onEscape = () => this.done(null);
    this.list = this.createList(this.currentPageEntries());
    this.persistSession();
  }

  private persistSession(): void {
    this.sessionState.hasSearched = this.hasSearched;
    this.sessionState.providerSources = [...this.providerSources];
    this.sessionState.selectedSkillKey = this.selectedSkillKey;
  }

  private createList(entries: readonly BrowserResultEntry[]): SelectList {
    const maxVisible = Math.max(1, entries.length);
    const items: SelectItem[] = entries.map((entry) => ({
      value: entry.key,
      label: entry.skill.name,
    }));
    const list = new SelectList(
      items,
      maxVisible,
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
      {
        minPrimaryColumnWidth: 1,
        maxPrimaryColumnWidth: 1,
      },
    );
    list.onSelectionChange = (item) => {
      this.selectedSkillKey = item.value;
      this.persistSession();
    };
    list.onSelect = (item) => {
      const entry = this.allVisibleEntries().find((candidate) => candidate.key === item.value);
      if (entry) {
        this.selectedSkillKey = item.value;
        this.persistSession();
        this.enterPreview(entry.skill);
      }
    };
    list.onCancel = () => this.done(null);
    const selectedIndex = entries.findIndex((entry) => entry.key === this.selectedSkillKey);
    if (selectedIndex >= 0) {
      list.setSelectedIndex(selectedIndex);
    } else if (entries.length > 0) {
      this.selectedSkillKey = entries[0]?.key ?? "";
      list.setSelectedIndex(0);
    } else {
      this.selectedSkillKey = "";
    }
    this.persistSession();
    return list;
  }

  private currentPageSize(resultCount = visibleBrowserResults(this.state).length): number {
    return calculateBrowserListMaxVisible({
      terminalRows: safeTerminalRows(this.tui),
      resultCount,
      maxSearchResults: this.services.config.maxSearchResults,
    });
  }

  private allVisibleResults(): SkillSearchResult[] {
    return visibleBrowserResults(this.state);
  }

  private allVisibleEntries(visibleResults = this.allVisibleResults()): BrowserResultEntry[] {
    return visibleResults.map((skill, index) => ({ key: resultEntryKey(skill, index), skill }));
  }

  private currentPageEntries(visibleEntries = this.allVisibleEntries()): BrowserResultEntry[] {
    const pageSize = this.currentPageSize(visibleEntries.length);
    this.state.pageIndex = clampBrowserPageIndex(this.state.pageIndex, visibleEntries.length, pageSize);
    return pagedBrowserResults(visibleEntries, this.state.pageIndex, pageSize);
  }

  private refreshList(): void {
    this.list = this.createList(this.currentPageEntries());
  }

  private resetPage(): void {
    this.state.pageIndex = 0;
  }

  private clearResultsForSearch(query: string): void {
    this.state.query = query;
    this.state.results = [];
    this.resetPage();
    this.providerSources = [];
    this.viewMode = "list";
    this.selectedSkillKey = "";
    this.previewScrollOffset = 0;
    this.markdownPreviewRenderer.clear();
    this.refreshList();
    this.persistSession();
  }

  private async search(value: string): Promise<void> {
    const requestId = this.searchGeneration + 1;
    this.searchGeneration = requestId;
    const query = normalizeQuery(value);
    if (!query) {
      this.isSearching = false;
      this.hasSearched = false;
      this.error = "Enter a search query, then press Enter.";
      this.clearResultsForSearch("");
      this.tui.requestRender();
      return;
    }

    this.input.setValue(query);
    this.clearResultsForSearch(query);
    this.isSearching = true;
    this.hasSearched = true;
    this.error = "";
    this.persistSession();
    this.tui.requestRender();

    try {
      const result = await searchAllProviders(
        query,
        chooseSearchMode(query),
        createProviders(this.services.config, this.services.runner),
        this.services.config.maxSearchResults,
      );
      if (requestId !== this.searchGeneration) {
        return;
      }
      this.state.results = result.skills;
      this.providerSources = result.sources;
      this.refreshList();
      this.persistSession();
    } catch (error) {
      if (requestId !== this.searchGeneration) {
        return;
      }
      this.state.results = [];
      this.providerSources = [];
      this.refreshList();
      this.error = getErrorMessage(error);
      this.persistSession();
    } finally {
      if (requestId === this.searchGeneration) {
        this.isSearching = false;
        this.tui.requestRender();
      }
    }
  }

  private cycleSort(): void {
    this.state.sortMode = cycleSortMode(this.state.sortMode);
    this.resetPage();
    this.refreshList();
    this.tui.requestRender();
  }

  private cycleProvider(): void {
    this.state.providerFilter = cycleProviderFilter(this.state.providerFilter);
    this.resetPage();
    this.refreshList();
    this.tui.requestRender();
  }

  private hasSelectableResults(): boolean {
    return visibleBrowserResults(this.state).length > 0;
  }

  private shouldSelectCurrentResult(): boolean {
    return !this.isSearching && this.hasSelectableResults() && normalizeQuery(this.input.getValue()) === this.state.query;
  }

  private statusLines(visibleResults: readonly SkillSearchResult[]): StatusLine[] {
    if (this.viewMode === "preview") {
      return this.currentPreview()
        ? [{ text: "Review skill details. Press Enter from this preview to continue to install confirmation.", tone: "dim" }]
        : [{ text: "Loading remote SKILL.md preview before install confirmation...", tone: "warning" }];
    }
    if (this.isSearching) {
      return [{ text: `Searching providers for "${this.state.query}"...`, tone: "warning" }];
    }
    if (this.error) {
      return [{ text: this.error, tone: "error" }];
    }
    if (!this.hasSearched) {
      return [{ text: "Type a search query and press Enter to search configured providers.", tone: "dim" }];
    }

    const providerErrors = formatProviderErrorSummary(this.providerSources);
    if (visibleResults.length === 0) {
      if (this.state.results.length > 0) {
        return [
          {
            text: `No ${this.state.providerFilter} results for "${this.state.query}". Change provider filter or search again.`,
            tone: "warning",
          },
        ];
      }
      const noResult = `No skills found for "${this.state.query}".`;
      return [
        {
          text: providerErrors ? `${noResult} Provider errors: ${providerErrors}` : `${noResult} Try a broader query.`,
          tone: providerErrors ? "error" : "warning",
        },
      ];
    }

    const plural = visibleResults.length === 1 ? "result" : "results";
    const pageSize = this.currentPageSize(visibleResults.length);
    const pageCount = browserPageCount(visibleResults.length, pageSize);
    const page = clampBrowserPageIndex(this.state.pageIndex, visibleResults.length, pageSize) + 1;
    const paging = pageCount > 1 ? ` Page ${String(page)}/${String(pageCount)} • PgUp/PgDn browse pages.` : "";
    const lines: StatusLine[] = [{ text: `${String(visibleResults.length)} ${plural} for "${this.state.query}".${paging}`, tone: "dim" }];
    if (visibleResults.some((skill) => this.installedStatus(skill))) {
      lines.push({ text: "Skills with matching installed provenance sources are marked ✓ and [installed:source].", tone: "warning" });
    }
    if (providerErrors) {
      lines.push({ text: `Some providers failed: ${providerErrors}`, tone: "warning" });
    }
    return lines;
  }

  private styleStatus(line: StatusLine): string {
    return this.theme.fg(line.tone, line.text);
  }

  private pad(content: string, width: number): string {
    return this.theme.fg("border", "│") + truncateToWidth(content, Math.max(1, width - 2), "…", true) + this.theme.fg("border", "│");
  }

  private installedStatus(skill: SkillSearchResult): InstalledSkillStatus | undefined {
    return installedSkillStatus(skill, this.installedIndex);
  }

  private installedDescription(skill: SkillSearchResult): string {
    const status = this.installedStatus(skill);
    return status ? `[installed:${status.reason}] ${skill.description}` : skill.description;
  }

  private renderResultRow(entry: BrowserResultEntry, innerWidth: number): string {
    const skill = entry.skill;
    const selected = entry.key === this.selectedSkillKey;
    const installed = Boolean(this.installedStatus(skill));
    const row = formatBrowserResultColumns(
      {
        prefix: selected ? "→ " : installed ? "✓ " : "  ",
        name: skill.name,
        provider: skill.provider,
        downloads: String(skill.popularity),
        description: this.installedDescription(skill),
      },
      innerWidth,
    );
    if (selected) {
      return this.theme.fg("accent", row);
    }
    return installed ? this.theme.fg("warning", row) : row;
  }

  private currentPreviewSkill(): SkillSearchResult | undefined {
    return this.allVisibleEntries().find((entry) => entry.key === this.selectedSkillKey)?.skill;
  }

  private previewBuilder(): SkillPreviewBuilder {
    return this.services.previewBuilder ?? ((skill) => buildRemotePreview(skill, createPreviewHttpClient(this.services.config.apiKeys.github)));
  }

  private previewEntry(skill: SkillSearchResult): PreviewCacheEntry | undefined {
    return this.previewCache.get(resultCacheKey(skill));
  }

  private startPreviewLoad(skill: SkillSearchResult): void {
    const key = resultCacheKey(skill);
    const existing = this.previewCache.get(key);
    if (existing?.status === "ready" || existing?.status === "loading") {
      return;
    }

    const requestId = this.previewGeneration + 1;
    this.previewGeneration = requestId;
    this.previewCache.set(key, { status: "loading", requestId });
    void this.previewBuilder()(skill)
      .then((preview) => {
        this.markdownPreviewRenderer.delete(key);
        this.previewCache.set(key, { status: "ready", requestId, preview });
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        const fallback = buildMetadataPreview(skill);
        this.markdownPreviewRenderer.delete(key);
        this.previewCache.set(key, {
          status: "ready",
          requestId,
          preview: {
            ...fallback,
            limitation: `${fallback.limitation ?? "Remote preview unavailable."} Preview error: ${getErrorMessage(error)}`,
          },
        });
        this.tui.requestRender();
      });
  }

  private enterPreview(skill: SkillSearchResult): void {
    this.viewMode = "preview";
    this.input.focused = false;
    this.previewScrollOffset = 0;
    this.startPreviewLoad(skill);
    this.tui.requestRender();
  }

  private currentPreview(): SkillContentPreview | undefined {
    const skill = this.currentPreviewSkill();
    const entry = skill ? this.previewEntry(skill) : undefined;
    return entry?.status === "ready" ? entry.preview : undefined;
  }

  private clampPreviewScroll(bodyLineCount: number, bodyHeight: number): void {
    const maxOffset = Math.max(0, bodyLineCount - bodyHeight);
    this.previewScrollOffset = Math.min(Math.max(0, this.previewScrollOffset), maxOffset);
  }

  private formatPreviewLine(line: string, innerWidth: number): string {
    return truncateToWidth(` ${sanitizeTerminalText(line)}`, innerWidth, "…", true);
  }

  private previewRows(skill: SkillSearchResult, innerWidth: number): PreviewRows {
    const descriptor = createInstallDescriptor(skill);
    const entry = this.previewEntry(skill);
    const preview = entry?.status === "ready" ? entry.preview : undefined;
    const maxOverlayRows = Math.max(1, Math.floor(safeTerminalRows(this.tui) * OVERLAY_HEIGHT_RATIO));
    const maxRows = Math.max(1, maxOverlayRows - PREVIEW_RESERVED_ROWS);

    const installed = this.installedStatus(skill);
    const installedRows = installed ? [`Installed: yes (${installed.reason} match)`] : [];

    if (!preview) {
      const rows = [
        `Name: ${descriptor.displayName}`,
        `Install reference: ${descriptor.installReference}`,
        ...installedRows,
        "",
        "Loading remote SKILL.md preview and metadata...",
      ];
      return {
        bodyHeight: 0,
        bodyLineCount: 0,
        rows: rows.slice(0, maxRows).map((line) => this.formatPreviewLine(line, innerWidth)),
      };
    }

    const headerRows = [
      `Name: ${descriptor.displayName}`,
      `Install reference: ${descriptor.installReference}`,
      ...installedRows,
      `Source: ${preview.source}`,
      formatPreviewMetadataTags(preview.metadata),
      ...(preview.limitation ? [`Limitation: ${preview.limitation}`] : []),
      "",
    ];
    const bodyWidth = Math.max(1, innerWidth - 1);
    const bodyRows = this.markdownPreviewRenderer.renderBody(resultCacheKey(skill), preview.body, bodyWidth);
    const minimumBodyRows = bodyRows.length > 0 ? 1 : 0;
    const visibleHeaderRows = headerRows.slice(0, Math.max(0, maxRows - minimumBodyRows));
    const bodyHeight = Math.max(0, maxRows - visibleHeaderRows.length);
    this.clampPreviewScroll(bodyRows.length, bodyHeight);
    const bodySlice = bodyRows.slice(this.previewScrollOffset, this.previewScrollOffset + bodyHeight);
    const formattedHeaderRows = visibleHeaderRows.map((line) => this.formatPreviewLine(line, innerWidth));
    const formattedBodyRows = bodySlice.map((line) => truncateToWidth(` ${line}`, innerWidth, "…", true));

    return {
      bodyHeight,
      bodyLineCount: bodyRows.length,
      rows: [...formattedHeaderRows, ...formattedBodyRows],
    };
  }

  private scrollPreview(delta: number): void {
    const skill = this.currentPreviewSkill();
    if (!skill || !this.currentPreview()) {
      return;
    }
    const metrics = this.previewRows(skill, this.lastInnerWidth);
    if (metrics.bodyHeight <= 0 || metrics.bodyLineCount <= metrics.bodyHeight) {
      return;
    }
    const nextOffset = this.previewScrollOffset + delta;
    this.previewScrollOffset = Math.min(Math.max(0, nextOffset), metrics.bodyLineCount - metrics.bodyHeight);
    this.tui.requestRender();
  }

  private scrollPreviewTo(position: "start" | "end"): void {
    const skill = this.currentPreviewSkill();
    if (!skill || !this.currentPreview()) {
      return;
    }
    const metrics = this.previewRows(skill, this.lastInnerWidth);
    const nextOffset = position === "start" ? 0 : Math.max(0, metrics.bodyLineCount - metrics.bodyHeight);
    if (nextOffset === this.previewScrollOffset) {
      return;
    }
    this.previewScrollOffset = nextOffset;
    this.tui.requestRender();
  }

  private changePage(delta: number): void {
    const visibleEntries = this.allVisibleEntries();
    if (visibleEntries.length === 0) {
      return;
    }
    const pageSize = this.currentPageSize(visibleEntries.length);
    const nextPage = clampBrowserPageIndex(this.state.pageIndex + delta, visibleEntries.length, pageSize);
    if (nextPage === this.state.pageIndex) {
      return;
    }
    this.state.pageIndex = nextPage;
    const pageEntries = this.currentPageEntries(visibleEntries);
    this.selectedSkillKey = pageEntries[0]?.key ?? "";
    this.refreshList();
    this.tui.requestRender();
  }

  private returnToList(): void {
    this.viewMode = "list";
    this.input.focused = this.focusedValue;
    this.refreshList();
    this.tui.requestRender();
  }

  public render(width: number): string[] {
    const modalWidth = Math.max(48, width);
    const innerWidth = Math.max(1, modalWidth - 2);
    this.lastInnerWidth = innerWidth;
    const title = " Skill Hub Browser ";
    const leftPad = Math.max(0, Math.floor((innerWidth - title.length) / 2));
    const rightPad = Math.max(0, innerWidth - title.length - leftPad);
    const visibleResults = this.allVisibleResults();
    const pageEntries = this.currentPageEntries(this.allVisibleEntries(visibleResults));
    const lines: string[] = [];
    lines.push(
      this.theme.fg("border", "╭" + "─".repeat(leftPad)) +
        this.theme.fg("accent", this.theme.bold(title)) +
        this.theme.fg("border", "─".repeat(rightPad) + "╮"),
    );
    lines.push(this.pad(` Search: ${this.input.render(Math.max(1, innerWidth - 9))[0] ?? ""}`, modalWidth));
    lines.push(this.pad(` Sort: ${this.state.sortMode}  Provider: ${this.state.providerFilter}`, modalWidth));
    lines.push(this.theme.fg("border", "├" + "─".repeat(innerWidth) + "┤"));
    for (const statusLine of this.statusLines(visibleResults)) {
      lines.push(this.pad(` ${this.styleStatus(statusLine)}`, modalWidth));
    }
    if (this.viewMode === "preview") {
      const skill = this.currentPreviewSkill();
      if (skill) {
        lines.push(this.theme.fg("border", "├" + "─".repeat(innerWidth) + "┤"));
        for (const line of this.previewRows(skill, innerWidth).rows) {
          lines.push(this.pad(line, modalWidth));
        }
      }
    } else if (!this.isSearching && visibleResults.length > 0) {
      this.refreshList();
      lines.push(this.pad(formatBrowserResultHeader(innerWidth), modalWidth));
      for (const entry of pageEntries) {
        lines.push(this.pad(this.renderResultRow(entry, innerWidth), modalWidth));
      }
    }
    lines.push(this.theme.fg("border", "├" + "─".repeat(innerWidth) + "┤"));
    const footer = this.viewMode === "preview"
      ? "↑/↓ scroll • pgup/pgdn page • home/end top/bottom • enter install • esc/back list"
      : "enter search/preview • pgup/pgdn page • ctrl+s sort • ctrl+p provider • esc cancel";
    lines.push(this.pad(` ${this.theme.fg("dim", footer)}`, modalWidth));
    lines.push(this.theme.fg("border", "╰" + "─".repeat(innerWidth) + "╯"));
    return lines;
  }

  public invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  public handleInput(data: string): void {
    if (this.viewMode === "preview") {
      if (matchesKey(data, Key.enter)) {
        const skill = this.currentPreviewSkill();
        const preview = this.currentPreview();
        if (skill && preview) {
          this.done({ type: "install", skill, preview });
        }
        return;
      }
      if (matchesKey(data, Key.escape) || data === "\b" || data === "\x7f") {
        this.returnToList();
        return;
      }
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        this.scrollPreview(matchesKey(data, Key.down) ? 1 : -1);
        return;
      }
      if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
        const skill = this.currentPreviewSkill();
        const metrics = skill ? this.previewRows(skill, this.lastInnerWidth) : undefined;
        this.scrollPreview((matchesKey(data, Key.pageDown) ? 1 : -1) * Math.max(1, metrics?.bodyHeight ?? 1));
        return;
      }
      if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
        this.scrollPreviewTo(matchesKey(data, Key.end) ? "end" : "start");
        return;
      }
      return;
    }

    if (matchesKey(data, Key.ctrl("s"))) {
      this.cycleSort();
      return;
    }
    if (matchesKey(data, Key.ctrl("p"))) {
      this.cycleProvider();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.changePage(matchesKey(data, Key.pageDown) ? 1 : -1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.shouldSelectCurrentResult()) {
        this.list.handleInput(data);
        this.tui.requestRender();
        return;
      }
      void this.search(this.input.getValue());
      return;
    }
    if (
      this.hasSelectableResults() &&
      (matchesKey(data, Key.up) || matchesKey(data, Key.down))
    ) {
      this.list.handleInput(data);
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }
}

export function createSkillBrowserModal(
  tui: TUI,
  theme: Theme,
  services: BrowserServices,
  done: (action: BrowserAction) => void,
  sessionState: SkillBrowserSessionState = createSkillBrowserSessionState(),
): Component & Focusable {
  return new SkillBrowserModal(tui, theme, services, done, sessionState);
}

export async function openSkillBrowser(
  ctx: ExtensionCommandContext,
  services: BrowserServices,
  sessionState: SkillBrowserSessionState = createSkillBrowserSessionState(),
): Promise<BrowserAction> {
  return ctx.ui.custom<BrowserAction>(
    (tui, theme, _keybindings, done) => createSkillBrowserModal(tui, theme, services, done, sessionState),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        minWidth: 58,
        maxHeight: "85%",
      },
    },
  );
}
