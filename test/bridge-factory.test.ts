import { describe, expect, test } from "bun:test";
import { createModelBridge } from "../src/model/bridge-factory";
import { CodexBridge } from "../src/model/codex-bridge";
import { ClaudeBridge } from "../src/model/claude-bridge";
import { Logger } from "../src/logging/audit";

describe("createModelBridge", () => {
  const logger = new Logger("error");
  const config = {
    codexCommand: "codex",
    codexArgs: ["--test"],
    claudeCommand: "claude",
    claudeArgs: ["-p"],
    options: {
      cwd: "/tmp",
      env: {},
    },
  };

  test("creates CodexBridge when backend is codex", () => {
    const bridge = createModelBridge("codex", config, logger);
    expect(bridge).toBeInstanceOf(CodexBridge);
  });

  test("creates ClaudeBridge when backend is claude", () => {
    const bridge = createModelBridge("claude", config, logger);
    expect(bridge).toBeInstanceOf(ClaudeBridge);
  });
});
