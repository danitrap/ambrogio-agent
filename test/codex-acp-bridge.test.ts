import { describe, expect, test } from "bun:test";
import { Logger } from "../src/logging/audit";
import { CodexAcpBridge } from "../src/model/codex-acp-bridge";

describe("CodexAcpBridge", () => {
  test("runs ACP JSON-RPC flow and returns text from session updates", async () => {
    const command = "sh";
    const args = [
      "-lc",
      "read _; printf 'info line\\n'; printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"authMethods\":[]}}\\n'; read _; printf '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"sessionId\":\"s-1\"}}\\n'; read _; printf '{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"content\":\"ok from model\"}}}\\n'; printf '{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}\\n'",
    ];

    const bridge = new CodexAcpBridge(command, args, new Logger("error"), { timeoutMs: 1000 });
    const response = await bridge.respond({ message: "hello", skills: [] });

    expect(response.text).toContain("ok from model");
    expect(response.toolCalls).toEqual([]);
  });

  test("returns ACP error message when session creation fails", async () => {
    const command = "sh";
    const args = [
      "-lc",
      "read _; printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"authMethods\":[]}}\\n'; read _; printf '{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"message\":\"Invalid params\",\"data\":\"session failed\"}}\\n'",
    ];

    const bridge = new CodexAcpBridge(command, args, new Logger("error"), { timeoutMs: 1000 });
    const response = await bridge.respond({ message: "hello", skills: [] });

    expect(response.text).toContain("ACP session creation failed");
    expect(response.text).toContain("Invalid params");
    expect(response.toolCalls).toEqual([]);
  });
});
