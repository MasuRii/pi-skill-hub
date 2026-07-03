import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandServices } from "./commands.js";
import { getErrorMessage } from "../utils/errors.js";
import { notify } from "./notify.js";

export function registerSkillHubCommand(pi: ExtensionAPI, services: CommandServices): void {
  pi.registerCommand("skill-hub", {
    description: "Open the Skill Hub modal for skill search, inventory, and preview-first management.",
    handler: async (args, ctx) => {
      services.logger.log("command", { modal: true, args: args.trim().length > 0 });
      try {
        if (!ctx.hasUI) {
          notify(ctx, "/skill-hub requires interactive TUI mode because subcommands are managed inside the modal.", "warning");
          return;
        }
        if (args.trim().length > 0) {
          notify(ctx, "Skill Hub subcommands moved into the /skill-hub modal. Opening the modal instead.", "info");
        }

        const { openSkillHubWorkspace } = await import("./commands.js");
        await openSkillHubWorkspace(ctx, services);
      } catch (error) {
        const message = getErrorMessage(error);
        services.logger.log("command error", { modal: true, message });
        notify(ctx, message, "error");
      }
    },
  });
}
