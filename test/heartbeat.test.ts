import { describe, expect, test } from "bun:test";
import { buildHeartbeatPrompt, runHeartbeatCycle } from "../src/runtime/heartbeat";

class StubLogger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

describe("heartbeat", () => {
  test("buildHeartbeatPrompt returns fixed prompt", () => {
    const prompt = buildHeartbeatPrompt();
    expect(prompt).toBe("Run a heartbeat check.");
  });

  test("executes heartbeat prompt and completes successfully", async () => {
    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      runHeartbeatPrompt: async () => "Skill executed", // La risposta non importa
      requestId: "test-123",
    });

    expect(result.status).toBe("completed");
    expect(result.requestId).toBe("test-123");
  });

  test("handles execution errors gracefully", async () => {
    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      runHeartbeatPrompt: async () => {
        throw new Error("Test error");
      },
      requestId: "test-456",
    });

    expect(result.status).toBe("error");
    expect(result.requestId).toBe("test-456");
  });

  test("completes even with different response content", async () => {
    // The skill handles everything autonomously, so the response content doesn't matter
    const result = await runHeartbeatCycle({
      logger: new StubLogger(),
      runHeartbeatPrompt: async () => "Some random response",
      requestId: "test-789",
    });

    expect(result.status).toBe("completed");
    expect(result.requestId).toBe("test-789");
  });
});
