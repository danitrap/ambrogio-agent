import { describe, expect, test } from "bun:test";
import { Logger } from "../src/logging/audit";
import { CodexAcpBridge } from "../src/model/codex-acp-bridge";

describe("CodexAcpBridge", () => {
  test("parses JSON response when stdout contains log lines", async () => {
    const command = "sh";
    const args = [
      "-lc",
      "cat >/dev/null; printf 'info line\\n{\"text\":\"ok\",\"toolCalls\":[]}\\n'",
    ];

    const bridge = new CodexAcpBridge(command, args, new Logger("error"));
    const response = await bridge.respond({ message: "hello", skills: [] });

    expect(response.text).toBe("ok");
    expect(response.toolCalls).toEqual([]);
  });

  test("does not return raw stdout logs to user when ACP output is invalid", async () => {
    const command = "sh";
    const args = ["-lc", "cat >/dev/null; printf 'just logs\\nnot json\\n'"];

    const bridge = new CodexAcpBridge(command, args, new Logger("error"));
    const response = await bridge.respond({ message: "hello", skills: [] });

    expect(response.text).toBe("Model backend returned an invalid response.");
    expect(response.toolCalls).toEqual([]);
  });
});
