import { appendFileSync, mkdirSync } from "node:fs";
import { DEBUG_DIR, DEBUG_LOG_PATH, EXTENSION_NAME } from "../constants.js";
import type { SkillHubConfig } from "../config/config.js";

export interface DebugLogger {
  readonly enabled: boolean;
  log(message: string, details?: Record<string, unknown>): void;
}

function serializeDetails(details: Record<string, unknown> | undefined): string {
  if (!details) {
    return "";
  }

  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return " {\"serialization\":\"failed\"}";
  }
}

export function createDebugLogger(config: Pick<SkillHubConfig, "debug">): DebugLogger {
  if (!config.debug) {
    return {
      enabled: false,
      log: () => undefined,
    };
  }

  return {
    enabled: true,
    log(message: string, details?: Record<string, unknown>): void {
      mkdirSync(DEBUG_DIR, { recursive: true });
      const timestamp = new Date().toISOString();
      appendFileSync(DEBUG_LOG_PATH, `${timestamp} [${EXTENSION_NAME}] ${message}${serializeDetails(details)}\n`, "utf-8");
    },
  };
}
