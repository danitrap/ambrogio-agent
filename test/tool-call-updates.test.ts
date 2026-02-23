import { describe, expect, test } from "bun:test";
import type { ModelToolCallEvent } from "../src/model/types";
import { createToolCallTelegramNotifier, formatToolCallUpdateMessage } from "../src/runtime/tool-call-updates";

class FakeTelegram {
  public calls: Array<{ chatId: number; text: string; parseMode?: "HTML" }> = [];
  public fail = false;

  async sendMessage(chatId: number, text: string, options?: { parseMode?: "HTML" }): Promise<void> {
    this.calls.push({ chatId, text, parseMode: options?.parseMode });
    if (this.fail) {
      throw new Error("Telegram sendMessage failed: 500");
    }
  }
}

class FakeLogger {
  public infos: Array<{ message: string; fields: Record<string, unknown> }> = [];
  public warns: Array<{ message: string; fields: Record<string, unknown> }> = [];

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.infos.push({ message, fields });
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.warns.push({ message, fields });
  }
}

const sampleEvent: ModelToolCallEvent = {
  backend: "codex",
  type: "web_search",
  detail: "meteo milano",
  phase: "realtime",
};

describe("createToolCallTelegramNotifier", () => {
  test("does nothing when disabled", async () => {
    const telegram = new FakeTelegram();
    const logger = new FakeLogger();

    const notify = createToolCallTelegramNotifier({
      enabled: false,
      chatId: 99,
      telegram: telegram as never,
      logger: logger as never,
    });

    await notify(sampleEvent);

    expect(telegram.calls).toHaveLength(0);
    expect(logger.infos).toHaveLength(0);
    expect(logger.warns).toHaveLength(0);
  });

  test("sends normalized update to fixed chat id", async () => {
    const telegram = new FakeTelegram();
    const logger = new FakeLogger();
    const recent: string[] = [];

    const notify = createToolCallTelegramNotifier({
      enabled: true,
      chatId: 12345,
      telegram: telegram as never,
      logger: logger as never,
      onSentText: async (text) => {
        recent.push(text);
      },
    });

    await notify(sampleEvent);

    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0]?.chatId).toBe(12345);
    expect(telegram.calls[0]?.text).toContain("tool[codex] web_search");
    expect(telegram.calls[0]?.text).toContain("meteo milano");
    expect(recent).toHaveLength(1);
    expect(logger.infos[0]?.message).toBe("tool_call_update_emitted");
  });

  test("marks summary events explicitly", async () => {
    const telegram = new FakeTelegram();
    const logger = new FakeLogger();
    const notify = createToolCallTelegramNotifier({
      enabled: true,
      chatId: 1,
      telegram: telegram as never,
      logger: logger as never,
    });

    await notify({
      backend: "claude",
      type: "web_fetch",
      detail: "1 fetch",
      phase: "final_summary",
    });

    expect(telegram.calls[0]?.text).toContain("(summary)");
  });

  test("swallows telegram errors and only logs warning", async () => {
    const telegram = new FakeTelegram();
    telegram.fail = true;
    const logger = new FakeLogger();
    const notify = createToolCallTelegramNotifier({
      enabled: true,
      chatId: 1,
      telegram: telegram as never,
      logger: logger as never,
    });

    await expect(notify(sampleEvent)).resolves.toBeUndefined();
    expect(logger.warns[0]?.message).toBe("tool_call_update_send_failed");
  });

  test("formats claude tool call with tool name", () => {
    const text = formatToolCallUpdateMessage({
      backend: "claude",
      type: "claude_tool_call",
      toolName: "Read",
      detail: "/data/groceries.md",
      phase: "realtime",
      source: "tool_use",
    });

    expect(text).toContain("tool[claude] Read:");
    expect(text).toContain("/data/groceries.md");
  });
});
