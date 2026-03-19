import { describe, expect, test } from "bun:test";
import {
  extractCodexExecutionDetails,
  extractCodexToolCallActionsFromEvent,
  extractLastCodexAssistantText,
  splitCodexJsonLines,
} from "../src/model/codex-bridge";

describe("extractCodexToolCallActionsFromEvent", () => {
  test("extracts command execution as generic tool call action", () => {
    const actions = extractCodexToolCallActionsFromEvent({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/zsh -lc \"sed -n '1,120p' package.json\"",
        status: "in_progress",
      },
    });

    expect(actions).toEqual([
      {
        toolCallId: "item_1",
        toolName: "Shell",
        detail: "/bin/zsh -lc \"sed -n '1,120p' package.json\"",
      },
    ]);
  });

  test("extracts web search query as generic tool call action", () => {
    const actions = extractCodexToolCallActionsFromEvent({
      type: "item.completed",
      item: {
        id: "ws_1",
        type: "web_search",
        query: "capital of France",
        action: {
          type: "search",
          query: "capital of France",
        },
      },
    });

    expect(actions).toEqual([
      {
        toolCallId: "ws_1",
        toolName: "WebSearch",
        detail: "query=capital of France",
      },
    ]);
  });
});

describe("extractLastCodexAssistantText", () => {
  test("returns the last agent message from the event stream", () => {
    const text = extractLastCodexAssistantText([
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "First answer" },
      },
      {
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "Final answer" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    expect(text).toBe("Final answer");
  });
});

describe("extractCodexExecutionDetails", () => {
  test("extracts token usage from turn completed events", () => {
    const details = extractCodexExecutionDetails({
      type: "turn.completed",
      usage: {
        input_tokens: 13821,
        cached_input_tokens: 6912,
        output_tokens: 31,
      },
    });

    expect(details).toEqual({
      usage: {
        inputTokens: 13821,
        outputTokens: 31,
        cacheReadTokens: 6912,
      },
    });
  });
});

describe("splitCodexJsonLines", () => {
  test("extracts complete json lines and keeps incomplete tail", () => {
    const chunk = [
      "{\"type\":\"item.started\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\"}}",
      "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_2\",\"type\":\"agent_message\",\"text\":\"ok\"}}",
      "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1",
    ].join("\n");

    const parsed = splitCodexJsonLines(chunk);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toContain("\"item.started\"");
    expect(parsed.lines[1]).toContain("\"agent_message\"");
    expect(parsed.remaining).toContain("\"turn.completed\"");
  });
});
