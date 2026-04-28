import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONFIG_PATH,
  DEFAULT_EXTERNAL_SKILL_ROOTS,
  DEFAULT_LOCAL_SKILL_ROOT,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPDATE_STAGING_ROOT,
} from "../constants.js";
import { ConfigValidationError, getErrorMessage } from "../utils/errors.js";

export interface SkillHubConfig {
  debug: boolean;
  localSkillRoot: string;
  externalSkillRoots: string[];
  providers: {
    skillsSh: boolean;
    skillsMp: boolean;
  };
  maxSearchResults: number;
  requestTimeoutMs: number;
  updateStagingRoot: string;
}

export interface ConfigLoadResult {
  config: SkillHubConfig;
  warnings: string[];
}

type RawConfig = Partial<{
  debug: unknown;
  localSkillRoot: unknown;
  externalSkillRoots: unknown;
  providers: unknown;
  maxSearchResults: unknown;
  requestTimeoutMs: unknown;
  updateStagingRoot: unknown;
}>;

const DEFAULT_CONFIG: SkillHubConfig = {
  debug: false,
  localSkillRoot: DEFAULT_LOCAL_SKILL_ROOT,
  externalSkillRoots: DEFAULT_EXTERNAL_SKILL_ROOTS,
  providers: {
    skillsSh: true,
    skillsMp: true,
  },
  maxSearchResults: DEFAULT_MAX_SEARCH_RESULTS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  updateStagingRoot: DEFAULT_UPDATE_STAGING_ROOT,
};

function readJsonConfig(pathValue: string): RawConfig {
  if (!existsSync(pathValue)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(pathValue, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigValidationError("config.json must contain a JSON object.");
    }
    return parsed as RawConfig;
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }
    throw new ConfigValidationError(`Unable to parse config.json: ${getErrorMessage(error)}`);
  }
}

function booleanValue(value: unknown, defaultValue: boolean, key: string, warnings: string[]): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  warnings.push(`${key} must be boolean; defaulting to ${String(defaultValue)}.`);
  return defaultValue;
}

function positiveIntegerValue(value: unknown, defaultValue: number, key: string, warnings: string[]): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  warnings.push(`${key} must be a positive integer; defaulting to ${String(defaultValue)}.`);
  return defaultValue;
}

function stringPathValue(value: unknown, defaultValue: string, key: string, warnings: string[]): string {
  if (value === undefined) {
    return resolve(defaultValue);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return resolve(value);
  }
  warnings.push(`${key} must be a non-empty string; defaulting to ${defaultValue}.`);
  return resolve(defaultValue);
}

function stringPathArrayValue(value: unknown, defaultValue: string[], key: string, warnings: string[]): string[] {
  if (value === undefined) {
    return defaultValue.map((item) => resolve(item));
  }
  if (!Array.isArray(value)) {
    warnings.push(`${key} must be an array of paths; defaulting to configured external roots.`);
    return defaultValue.map((item) => resolve(item));
  }

  const paths = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (paths.length !== value.length) {
    warnings.push(`${key} contained invalid entries that were ignored.`);
  }
  return paths.map((item) => resolve(item));
}

function parseProviders(value: unknown, warnings: string[]): SkillHubConfig["providers"] {
  if (value === undefined) {
    return { ...DEFAULT_CONFIG.providers };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("providers must be an object; default provider settings were used.");
    return { ...DEFAULT_CONFIG.providers };
  }

  const record = value as Record<string, unknown>;
  return {
    skillsSh: booleanValue(record.skillsSh, DEFAULT_CONFIG.providers.skillsSh, "providers.skillsSh", warnings),
    skillsMp: booleanValue(record.skillsMp, DEFAULT_CONFIG.providers.skillsMp, "providers.skillsMp", warnings),
  };
}

export function loadConfig(pathValue = CONFIG_PATH): ConfigLoadResult {
  const warnings: string[] = [];
  const raw = readJsonConfig(pathValue);

  return {
    config: {
      debug: booleanValue(raw.debug, DEFAULT_CONFIG.debug, "debug", warnings),
      localSkillRoot: stringPathValue(raw.localSkillRoot, DEFAULT_CONFIG.localSkillRoot, "localSkillRoot", warnings),
      externalSkillRoots: stringPathArrayValue(
        raw.externalSkillRoots,
        DEFAULT_CONFIG.externalSkillRoots,
        "externalSkillRoots",
        warnings,
      ),
      providers: parseProviders(raw.providers, warnings),
      maxSearchResults: positiveIntegerValue(
        raw.maxSearchResults,
        DEFAULT_CONFIG.maxSearchResults,
        "maxSearchResults",
        warnings,
      ),
      requestTimeoutMs: positiveIntegerValue(
        raw.requestTimeoutMs,
        DEFAULT_CONFIG.requestTimeoutMs,
        "requestTimeoutMs",
        warnings,
      ),
      updateStagingRoot: stringPathValue(
        raw.updateStagingRoot,
        DEFAULT_CONFIG.updateStagingRoot,
        "updateStagingRoot",
        warnings,
      ),
    },
    warnings,
  };
}
