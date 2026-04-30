import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillHubConfig } from "../src/config/config.js";

export function createSkill(root: string, name: string, description = "Fixture skill"): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `# ${name}\n\n${description}\n`, "utf-8");
  return path;
}

export function fixtureConfig(localRoot: string, externalRoot: string): SkillHubConfig {
  return {
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
