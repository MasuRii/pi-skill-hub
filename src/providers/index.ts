import type { CommandRunner } from "../types.js";
import type { SkillHubConfig } from "../config/config.js";
import type { SkillProvider } from "./provider-types.js";
import { createSkillsMpProvider } from "./skillsmp-provider.js";
import { createSkillsShProvider } from "./skills-sh-provider.js";

export function createProviders(config: SkillHubConfig, runner: CommandRunner): SkillProvider[] {
  const providers: SkillProvider[] = [];
  if (config.providers.skillsSh) {
    providers.push(createSkillsShProvider(runner, config.requestTimeoutMs, config.skillsSh));
  }
  if (config.providers.skillsMp) {
    providers.push(createSkillsMpProvider(config.requestTimeoutMs, undefined, config.apiKeys.skillsMp));
  }
  return providers;
}

export type { SkillProvider } from "./provider-types.js";
