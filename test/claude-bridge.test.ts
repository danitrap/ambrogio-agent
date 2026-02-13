import { describe, expect, test } from "bun:test";
import { extractClaudeAuditActions } from "../src/model/claude-bridge";

describe("extractClaudeAuditActions", () => {
  test("extracts web search and fetch counts", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
      usage: {
        server_tool_use: {
          web_search_requests: 2,
          web_fetch_requests: 1,
        },
      },
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      type: "web_search",
      detail: "2 searches",
    });
    expect(actions[1]).toEqual({
      type: "web_fetch",
      detail: "1 fetch",
    });
  });

  test("handles missing usage data", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(0);
  });

  test("handles zero requests", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
      usage: {
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
      },
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(0);
  });

  test("handles singular counts correctly", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
      usage: {
        server_tool_use: {
          web_search_requests: 1,
          web_fetch_requests: 1,
        },
      },
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(2);
    expect(actions[0]?.detail).toBe("1 search");
    expect(actions[1]?.detail).toBe("1 fetch");
  });
});
