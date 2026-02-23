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
        return "Skill executed";
      },
      quietHours: parseQuietHours("00:00-00:00"),
    });

    const result = await runner.runScheduledHeartbeat("timer");

    expect(result.status).toBe("skipped_quiet_hours");
    expect(promptCalls).toBe(0);
    expect(runner.getHeartbeatState().heartbeatLastResult).toBe("skipped_quiet_hours");
  });

  test("executes heartbeat successfully when not in quiet hours", async () => {
    let promptCalls = 0;
    const runner = createHeartbeatRunner({
      logger: createLoggerStub(),
      stateStore: createStateStoreStub(),
      runHeartbeatPromptWithTimeout: async () => {
        promptCalls += 1;
        return "Skill executed";
      },
      quietHours: null,
    });

    const result = await runner.runScheduledHeartbeat("timer");

    expect(result.status).toBe("completed");
    expect(promptCalls).toBe(1);
    expect(runner.getHeartbeatState().heartbeatLastResult).toBe("completed");
  });

  test("allows manual trigger to bypass quiet hours", async () => {
    let promptCalls = 0;
    const runner = createHeartbeatRunner({
      logger: createLoggerStub(),
      stateStore: createStateStoreStub(),
      runHeartbeatPromptWithTimeout: async () => {
        promptCalls += 1;
        return "Skill executed";
      },
      quietHours: parseQuietHours("00:00-00:00"), // Always in quiet hours
    });

    const result = await runner.runScheduledHeartbeat("manual");

    expect(result.status).toBe("completed");
    expect(promptCalls).toBe(1);
  });

  test("prevents concurrent executions", async () => {
    const runner = createHeartbeatRunner({
      logger: createLoggerStub(),
      stateStore: createStateStoreStub(),
      runHeartbeatPromptWithTimeout: async () => {
        // Simulate slow execution
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "Skill executed";
      },
      quietHours: null,
    });

    const [result1, result2] = await Promise.all([
      runner.runScheduledHeartbeat("manual"),
      runner.runScheduledHeartbeat("manual"),
    ]);

    // One should complete, one should be skipped
    const statuses = [result1.status, result2.status].sort();
    expect(statuses).toContain("completed");
    expect(statuses).toContain("skipped_inflight");
  });

  test("handles execution errors gracefully", async () => {
    const runner = createHeartbeatRunner({
      logger: createLoggerStub(),
      stateStore: createStateStoreStub(),
      runHeartbeatPromptWithTimeout: async () => {
        throw new Error("Test error");
      },
      quietHours: null,
    });

    const result = await runner.runScheduledHeartbeat("manual");

    expect(result.status).toBe("error");
    expect(runner.getHeartbeatState().heartbeatLastResult).toBe("error");
  });

  test("suppresses tool call updates during heartbeat execution", async () => {
    let suppressToolCallUpdates: boolean | null = null;
    const runner = createHeartbeatRunner({
      logger: createLoggerStub(),
      stateStore: createStateStoreStub(),
      runHeartbeatPromptWithTimeout: async (_prompt, _requestId, suppress) => {
        suppressToolCallUpdates = suppress;
        return "Skill executed";
      },
      quietHours: null,
    });

    const result = await runner.runScheduledHeartbeat("manual");

    expect(result.status).toBe("completed");
    expect(suppressToolCallUpdates === true).toBe(true);
  });
});
