import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import {
  createSkillHubModal,
  createSkillHubModalSelectionState,
  type SkillHubModalSelectionState,
} from "../src/modal/skill-hub-modal.js";
import type { InventorySnapshot } from "../src/types.js";
import type { SkillHubModalAction } from "../src/modal/modal-types.js";
import type { SkillHubConfig } from "../src/config/config.js";

function themeFixture(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function tuiFixture(): TUI {
  return {
    terminal: { columns: 120, rows: 36 },
    requestRender: () => undefined,
  } as unknown as TUI;
}

function configFixture(): SkillHubConfig {
  return {
    debug: false,
    localSkillRoot: "C:/tmp/pi-skill-hub/local",
    externalSkillRoots: [],
    providers: { skillsSh: true, skillsMp: true },
    skillsSh: {
      apiBaseUrl: "https://skills.sh",
      downloadBaseUrl: "https://skills.sh",
      detailBaseUrl: "https://skills.sh",
      transport: "api",
      cliCompatibility: false,
    },
    maxSearchResults: 20,
    requestTimeoutMs: 1000,
    updateStagingRoot: "C:/tmp/pi-skill-hub/staging",
    apiKeys: {},
  };
}

function snapshotFixture(): InventorySnapshot {
  return {
    localRoot: "C:/tmp/pi-skill-hub/local",
    externalRoots: [],
    items: [],
    manifestOnlyMissing: [],
  };
}

function createHarness(
  state: SkillHubModalSelectionState,
  done: (action: SkillHubModalAction | undefined) => void = () => undefined,
): Component & Focusable {
  const component = createSkillHubModal(
    tuiFixture(),
    themeFixture(),
    { config: configFixture() },
    snapshotFixture(),
    done,
    state,
  );
  component.focused = true;
  return component;
}

function sendInput(component: Component & Focusable, data: string): void {
  if (!component.handleInput) {
    throw new Error("Modal component must expose an input handler.");
  }
  component.handleInput(data);
}

test("skill hub modal preserves selected pane and action across workspace reopen", () => {
  const state = createSkillHubModalSelectionState();
  const actions: Array<SkillHubModalAction | undefined> = [];
  const first = createHarness(state, (action) => actions.push(action));

  for (let index = 0; index < 4; index += 1) {
    sendInput(first, "\x1b[C");
  }
  sendInput(first, "\x1b[B");
  sendInput(first, "\x1b[B");
  sendInput(first, "\r");

  assert.equal(actions[0], "manual_bind_source");
  assert.equal(state.selectedPaneId, "sources");
  assert.equal(state.actionIndexesByPaneId.sources, 2);

  const reopened = createHarness(state);
  const rendered = reopened.render(120).join("\n");

  assert.match(rendered, /\[ Sources \]/u);
  assert.match(rendered, /→ Link source manually by URL/u);
  assert.doesNotMatch(rendered, /→ Browse\/search\/install remote skills/u);
});
