import { describe, expect, test } from "bun:test";
import { buildHeartbeatPrompt, HEARTBEAT_OK, runHeartbeatCycle } from "../src/runtime/heartbeat";

class StubLogger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

describe("heartbeat", () => {
  test("buildHeartbeatPrompt includes HEARTBEAT.md content when provided", () => {
    const prompt = buildHeartbeatPrompt("- check pending items");
    expect(prompt).toContain("HEARTBEAT.md");
    expect(prompt).toContain("check pending items");
  });

  test("suppresses alert when response is HEARTBEAT_OK", async () => {
    const sentAlerts: Array<{ chatId: number; message: string }> = [];

    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => null,
      runHeartbeatPrompt: async () => HEARTBEAT_OK,
      getAlertChatId: () => 123,
      sendAlert: async (chatId, message) => {
        sentAlerts.push({ chatId, message });
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("ok");
    expect(sentAlerts).toHaveLength(0);
  });

  test("sends deterministic reminder message configured in HEARTBEAT.md when response is HEARTBEAT_OK", async () => {
    const sentAlerts: Array<{ chatId: number; message: string }> = [];

    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => "- Always include the exact message: operational ping",
      runHeartbeatPrompt: async () => HEARTBEAT_OK,
      getAlertChatId: () => 999,
      sendAlert: async (chatId, message) => {
        sentAlerts.push({ chatId, message });
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("ok_notice_sent");
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]?.chatId).toBe(999);
    expect(sentAlerts[0]?.message).toBe("operational ping");
  });

  test("sends alert when response differs from HEARTBEAT_OK", async () => {
    const sentAlerts: Array<{ chatId: number; message: string }> = [];

    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => "",
      runHeartbeatPrompt: async () => "Need attention",
      getAlertChatId: () => 456,
      sendAlert: async (chatId, message) => {
        sentAlerts.push({ chatId, message });
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("alert_sent");
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]?.chatId).toBe(456);
    expect(sentAlerts[0]?.message).toContain("Need attention");
  });

  test("drops alert when no authorized chat is available", async () => {
    let sent = false;

    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => null,
      runHeartbeatPrompt: async () => "Something broke",
      getAlertChatId: () => null,
      sendAlert: async () => {
        sent = true;
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("alert_dropped");
    expect(sent).toBe(false);
  });

  test("sends alert on execution error", async () => {
    const sentAlerts: string[] = [];

    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => null,
      runHeartbeatPrompt: async () => {
        throw new Error("MODEL_TIMEOUT");
      },
      getAlertChatId: () => 321,
      sendAlert: async (_chatId, message) => {
        sentAlerts.push(message);
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("alert_sent");
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]).toContain("MODEL_TIMEOUT");
  });
});
