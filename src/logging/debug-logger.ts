import { appendFile, mkdir } from "node:fs/promises";
import { DEBUG_DIR, DEBUG_LOG_PATH, EXTENSION_NAME } from "../constants.js";
import type { SkillHubConfig } from "../config/config.js";

export interface DebugLogger {
  readonly enabled: boolean;
  log(message: string, details?: Record<string, unknown>): void;
  flush(): Promise<void>;
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
      flush: () => Promise.resolve(),
    };
  }

  let writeQueue: Promise<void> = Promise.resolve();

  return {
    enabled: true,
    log(message: string, details?: Record<string, unknown>): void {
      const timestamp = new Date().toISOString();
      const line = `${timestamp} [${EXTENSION_NAME}] ${message}${serializeDetails(details)}\n`;
      writeQueue = writeQueue.then(
        async () => {
          await mkdir(DEBUG_DIR, { recursive: true });
          await appendFile(DEBUG_LOG_PATH, line, "utf-8");
        },
        async () => {
          await mkdir(DEBUG_DIR, { recursive: true });
          await appendFile(DEBUG_LOG_PATH, line, "utf-8");
        },
      );
      void writeQueue.catch(() => {
        // Debug logging must never affect skill-hub behavior or terminal output.
      });
    },
    flush(): Promise<void> {
      return writeQueue.catch(() => undefined);
    },
  };
}
