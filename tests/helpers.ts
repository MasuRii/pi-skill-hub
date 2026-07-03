import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { ProvenanceManifest } from "../src/types.js";
import type { SkillHubConfig } from "../src/config/config.js";
import { emptyManifest } from "../src/manifest/manifest-store.js";

export { emptyManifest };

export function createSkill(root: string, name: string, description = "Fixture skill"): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `# ${name}\n\n${description}\n`, "utf-8");
  return path;
}

export interface FixtureRoots {
  root: string;
  localRoot: string;
  externalRoot: string;
}

export function createFixtureRoots(prefix: string): FixtureRoots {
  const root = mkdtempSync(join(tmpdir(), `skill-hub-${prefix}-`));
  return {
    root,
    localRoot: join(root, "local"),
    externalRoot: join(root, "external"),
  };
}

export function fixtureConfig(localRoot: string, externalRoot: string): SkillHubConfig {
  return {
    enabled: true,
    debug: false,
    localSkillRoot: localRoot,
    externalSkillRoots: [externalRoot],
    providers: { skillsSh: true, skillsMp: false },
    skillsSh: {
      apiBaseUrl: "https://skills.sh",
      downloadBaseUrl: "https://skills.sh",
      detailBaseUrl: "https://skills.sh",
      transport: "api",
      cliCompatibility: false,
    },
    maxSearchResults: 10,
    requestTimeoutMs: 1000,
    updateStagingRoot: join(localRoot, "..", "staging"),
    apiKeys: {},
  };
}

export function themeFixture(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

export function sendInput(component: Component & Focusable, data: string, label = "Component"): void {
  if (!component.handleInput) {
    throw new Error(`${label} must expose a keyboard input handler.`);
  }
  component.handleInput(data);
}
