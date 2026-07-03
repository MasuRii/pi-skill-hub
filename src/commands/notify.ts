import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Sends a TUI notification at the given level. Shared by the command entry
 * points (commands.ts and register.ts) to avoid duplicating the thin wrapper
 * around `ctx.ui.notify`.
 */
export function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}
