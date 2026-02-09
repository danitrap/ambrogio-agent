import { describe, expect, test } from "bun:test";
import { parseQuietHours } from "../src/runtime/heartbeat-quiet-hours";
import { createHeartbeatRunner } from "../src/runtime/heartbeat-runner";

function createStateStoreStub() {
  const values = new Map<string, string>();
  return {
    getRuntimeValue: (key: string) => values.get(key) ?? null,
    setRuntimeValue: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function createLoggerStub() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe("createHeartbeatRunner", () => {
  test("skips timer heartbeat during quiet hours without running heartbeat prompt", async () => {
    let promptCalls = 0;
    const runner = createHeartbeatRunner({
      logger: createLoggerStub(),
      stateStore: createStateStoreStub(),
      runHeartbeatPromptWithTimeout: async () => {
        promptCalls += 1;
        return "HEARTBEAT_OK";
      },
      getAlertChatId: () => 123,
      sendAlertMessage: async () => {},
      recordRecentTelegramEntry: async () => {},
      previewText: (value) => value,
      dedupWindowMs: 1_000,
      quietHours: parseQuietHours("00:00-00:00"),
      fallbackAlertChatId: 123,
    });

    const result = await runner.runScheduledHeartbeat("timer");

    expect(result.status).toBe("skipped_quiet_hours");
    expect(promptCalls).toBe(0);
    expect(runner.getHeartbeatState().heartbeatLastResult).toBe("skipped_quiet_hours");
  });

  test("uses fallback alert chat id when no last authorized chat is available", async () => {
    const sentToChatIds: number[] = [];
    const runner = createHeartbeatRunner({
      logger: createLoggerStub(),
      stateStore: createStateStoreStub(),
      runHeartbeatPromptWithTimeout: async () =>
        "{\"action\":\"checkin\",\"issue\":\"idle\",\"impact\":\"none\",\"nextStep\":\"ping\",\"todoItems\":[]}",
      getAlertChatId: () => null,
      sendAlertMessage: async (chatId) => {
        sentToChatIds.push(chatId);
      },
      recordRecentTelegramEntry: async () => {},
      previewText: (value) => value,
      dedupWindowMs: 1_000,
      quietHours: null,
      fallbackAlertChatId: 999,
    });

    const result = await runner.runScheduledHeartbeat("manual");

    expect(result.status).toBe("checkin_sent");
    expect(sentToChatIds).toEqual([999]);
  });
});
