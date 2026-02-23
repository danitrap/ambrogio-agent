import { describe, expect, test } from "bun:test";
import { MacToolsError } from "../src/mac-tools/types";
import { mapEkctlExecutionError } from "../src/mac-tools/providers/ekctl";

describe("mapEkctlExecutionError", () => {
  test("maps killed SIGTERM process (exec timeout shape) to timeout", () => {
    const timeoutMs = 2500;
    const error = {
      code: null,
      killed: true,
      signal: "SIGTERM",
      message: "Command failed: ekctl list calendars",
    };

    expect(() => mapEkctlExecutionError(error, timeoutMs)).toThrowError(
      new MacToolsError("timeout", `ekctl command timed out after ${timeoutMs}ms.`),
    );
  });

  test("maps ETIMEDOUT to timeout", () => {
    const timeoutMs = 1000;
    expect(() => mapEkctlExecutionError({ code: "ETIMEDOUT" }, timeoutMs)).toThrowError(
      new MacToolsError("timeout", `ekctl command timed out after ${timeoutMs}ms.`),
    );
  });
});
