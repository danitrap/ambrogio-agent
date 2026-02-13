import type { Logger } from "../logging/audit";
import { CodexBridge } from "./codex-bridge";
import { ClaudeBridge } from "./claude-bridge";
import type { ModelBridge } from "./types";

export type BridgeConfig = {
  codexCommand: string;
  codexArgs: string[];
  claudeCommand: string;
  claudeArgs: string[];
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  };
};

export function createModelBridge(
  backend: "codex" | "claude",
  config: BridgeConfig,
  logger: Logger,
): ModelBridge {
  switch (backend) {
    case "codex":
      return new CodexBridge(
        config.codexCommand,
        config.codexArgs,
        logger,
        config.options,
      );
    case "claude":
      return new ClaudeBridge(
        config.claudeCommand,
        config.claudeArgs,
        logger,
        config.options,
      );
    default:
      // TypeScript exhaustiveness check
      const _exhaustive: never = backend;
      throw new Error(`Unknown backend: ${_exhaustive}`);
  }
}
