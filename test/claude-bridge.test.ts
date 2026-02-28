import { describe, expect, test } from "bun:test";
import {
  extractClaudeAuditActions,
  extractLastClaudeAssistantText,
  extractClaudeToolCallActionsFromEvent,
  splitJsonLines,
} from "../src/model/claude-bridge";

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

describe("extractClaudeToolCallActionsFromEvent", () => {
  test("extracts tool_use actions from assistant events", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "/data/groceries.md" },
          },
          {
            type: "text",
            text: "Let me read that file",
          },
        ],
      },
    };

    const actions = extractClaudeToolCallActionsFromEvent(event);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.toolUseId).toBe("toolu_1");
    expect(actions[0]?.toolName).toBe("Read");
    expect(actions[0]?.detail).toContain("/data/groceries.md");
  });

  test("returns no actions for non-tool events", () => {
    const actions = extractClaudeToolCallActionsFromEvent({
      type: "user",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(actions).toHaveLength(0);
  });
});

describe("extractLastClaudeAssistantText", () => {
  test("returns the last assistant text block", () => {
    const text = extractLastClaudeAssistantText([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First answer" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "TodoWrite", input: { todos: [] } },
            { type: "text", text: "Final user-facing answer" },
          ],
        },
      },
      { type: "result", result: "" },
    ]);

    expect(text).toBe("Final user-facing answer");
  });

  test("returns empty string when assistant text is absent", () => {
    const text = extractLastClaudeAssistantText([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
          ],
        },
      },
      { type: "result", result: "" },
    ]);

    expect(text).toBe("");
  });
});

describe("splitJsonLines", () => {
  test("extracts complete json lines and keeps incomplete tail", () => {
    const chunk = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result"}]}}',
      '{"type":"result","result":"o',
    ].join("\n");

    const parsed = splitJsonLines(chunk);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toContain('"type":"assistant"');
    expect(parsed.lines[1]).toContain('"type":"user"');
    expect(parsed.remaining).toContain('"type":"result"');
  });

  test("handles complete trailing newline", () => {
    const chunk = '{"type":"result","result":"ok"}\n';
    const parsed = splitJsonLines(chunk);
    expect(parsed.lines).toEqual(['{"type":"result","result":"ok"}']);
    expect(parsed.remaining).toBe("");
  });
});
