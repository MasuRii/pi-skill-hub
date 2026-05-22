import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandRunner, CommandRunnerResult } from "../types.js";

export function createPiCommandRunner(pi: ExtensionAPI): CommandRunner {
  return {
    async run(command: string, args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandRunnerResult> {
      const execOptions: { timeout?: number; signal?: AbortSignal; env: NodeJS.ProcessEnv } = {
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      };
      if (options?.timeoutMs !== undefined) {
        execOptions.timeout = options.timeoutMs;
      }
      if (options?.signal !== undefined) {
        execOptions.signal = options.signal;
      }
      const result = await pi.exec(command, [...args], execOptions);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.code ?? 1,
      };
    },
  };
}
