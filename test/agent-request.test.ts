import { describe, expect, test } from "bun:test";
import { runAgentRequestWithTimeout } from "../src/runtime/agent-request";

class FakeLogger {
  public errors: Array<{ message: string; fields: Record<string, unknown> }> = [];

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.errors.push({ message, fields });
  }
}

describe("runAgentRequestWithTimeout", () => {
  test("returns successful reply", async () => {
    const logger = new FakeLogger();
    const result = await runAgentRequestWithTimeout({
      logger: logger as never,
      update: { updateId: 1, userId: 7, chatId: 10 },
      timeoutMs: 1000,
      operation: async () => "ok",
    });

    expect(result).toEqual({ reply: "ok", ok: true });
    expect(logger.errors).toHaveLength(0);
  });

  test("maps timeout to fallback reply and logs timeout", async () => {
    const logger = new FakeLogger();
    const result = await runAgentRequestWithTimeout({
      logger: logger as never,
      update: { updateId: 2, userId: 8, chatId: 11 },
      timeoutMs: 1000,
      operation: async () => {
        throw new Error("MODEL_TIMEOUT");
      },
      command: "retry",
    });

    expect(result.ok).toBe(false);
    expect(result.reply).toContain("Model backend unavailable right now");
    expect(logger.errors[0]?.message).toBe("request_timed_out");
  });

  test("maps generic errors to Error reply and logs failure", async () => {
    const logger = new FakeLogger();
    const result = await runAgentRequestWithTimeout({
      logger: logger as never,
      update: { updateId: 3, userId: 9, chatId: 12 },
      timeoutMs: 1000,
      operation: async () => {
        throw new Error("boom");
      },
    });

    expect(result).toEqual({ reply: "Error: boom", ok: false });
    expect(logger.errors[0]?.message).toBe("message_processing_failed");
  });
});
