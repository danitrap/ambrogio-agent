import { describe, expect, test } from "bun:test";
import { Logger } from "../src/logging/audit";
import { startMacToolsLifecycle } from "../src/runtime/mac-tools-lifecycle";

describe("mac-tools lifecycle", () => {
  test("starts when enabled, runs startup checks and stops", async () => {
    const logger = new Logger("error");
    const calls: string[] = [];
    let closed = false;

    const lifecycle = await startMacToolsLifecycle({
      enabled: true,
      socketPath: "/tmp/mac-tools.sock",
      logger,
      deps: {
        startService: async () => ({
          socketPath: "/tmp/mac-tools.sock",
          tcpEndpoint: { host: "0.0.0.0", port: 39223 },
          close: async () => {
            closed = true;
          },
        }),
        callRpc: async ({ method }) => {
          calls.push(method);
          return {
            jsonrpc: "2.0",
            id: method,
            result: method === "system.ping"
              ? { ok: true, service: "mac-tools-service", version: "1.0.0" }
              : {
                service: "mac-tools-service",
                version: "1.0.0",
                uptimeMs: 1,
                socketPath: "/tmp/mac-tools.sock",
                permissions: { calendar: "authorized", reminders: "authorized" },
              },
          };
        },
      },
    });

    await lifecycle.runStartupHealthcheck();
    expect(calls).toEqual(["system.ping", "system.info"]);

    await lifecycle.stop();
    expect(closed).toBe(true);
  });

  test("is no-op when disabled", async () => {
    const logger = new Logger("error");
    const lifecycle = await startMacToolsLifecycle({
      enabled: false,
      socketPath: "/tmp/unused.sock",
      logger,
    });
    expect(lifecycle.isEnabled()).toBe(false);
    await lifecycle.runStartupHealthcheck();
    await lifecycle.stop();
  });
});
