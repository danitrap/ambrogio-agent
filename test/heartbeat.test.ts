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
        return "sent";
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
        return "sent";
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
        return "sent";
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
        return "sent";
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
        return "sent";
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("alert_sent");
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]).toContain("MODEL_TIMEOUT");
  });

  test("formats structured heartbeat decision as alert message", async () => {
    const sentAlerts: string[] = [];
    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => null,
      runHeartbeatPrompt: async () =>
        JSON.stringify({
          action: "alert",
          issue: "TODO scaduto",
          impact: "Rischio di dimenticare follow-up",
          nextStep: "Invia reminder oggi",
          todoItems: ["Scrivere a Marco", "Confermare riunione"],
        }),
      getAlertChatId: () => 321,
      sendAlert: async (_chatId, message) => {
        sentAlerts.push(message);
        return "sent";
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("alert_sent");
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]).toContain("Issue: TODO scaduto");
    expect(sentAlerts[0]).toContain("TODO focus:");
  });

  test("sends check-in message when decision action is checkin", async () => {
    const sentAlerts: string[] = [];
    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => null,
      runHeartbeatPrompt: async () =>
        JSON.stringify({
          action: "checkin",
          issue: "Idle oltre soglia",
          impact: "Rischio di perdere un follow-up",
          nextStep: "Invia check-in breve",
          todoItems: [],
        }),
      getAlertChatId: () => 321,
      sendAlert: async (_chatId, message) => {
        sentAlerts.push(message);
        return "sent";
      },
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("checkin_sent");
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0]).toContain("Heartbeat check-in:");
  });

  test("drops heartbeat alert when sender deduplicates", async () => {
    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      readHeartbeatDoc: async () => null,
      runHeartbeatPrompt: async () => "Need attention",
      getAlertChatId: () => 456,
      sendAlert: async () => "dropped",
      requestId: "heartbeat-test",
    });

    expect(result.status).toBe("alert_dropped");
  });
});
