import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config/config.js";
import { createDebugLogger } from "./logging/debug-logger.js";
import { registerSkillHubCommand } from "./commands/commands.js";
import { createPiCommandRunner } from "./commands/runner.js";
import { EXTENSION_NAME } from "./constants.js";

export default function piSkillHubExtension(pi: ExtensionAPI): void {
  const loaded = loadConfig();
  const logger = createDebugLogger(loaded.config);
  const runner = createPiCommandRunner(pi);
  const services = { config: loaded.config, runner, logger };

  registerSkillHubCommand(pi, services);

  pi.on("session_start", async (_event, ctx) => {
    logger.log("session_start", { warnings: loaded.warnings.length });
    for (const warning of loaded.warnings) {
      ctx.ui.notify(`${EXTENSION_NAME}: ${warning}`, "warning");
    }
  });
}
