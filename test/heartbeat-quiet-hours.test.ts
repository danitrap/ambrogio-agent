import { describe, expect, test } from "bun:test";
import { isInQuietHours, parseQuietHours } from "../src/runtime/heartbeat-quiet-hours";

describe("heartbeat quiet hours", () => {
  test("parses overnight window", () => {
    const window = parseQuietHours("22:00-06:00");
    expect(window).not.toBeNull();
    expect(window?.startMinute).toBe(22 * 60);
    expect(window?.endMinute).toBe(6 * 60);
  });

  test("detects time inside overnight quiet hours", () => {
    const window = parseQuietHours("22:00-06:00");
    expect(isInQuietHours(window, new Date("2026-02-08T23:15:00"))).toBe(true);
    expect(isInQuietHours(window, new Date("2026-02-08T05:59:00"))).toBe(true);
  });

  test("detects time outside overnight quiet hours", () => {
    const window = parseQuietHours("22:00-06:00");
    expect(isInQuietHours(window, new Date("2026-02-08T06:00:00"))).toBe(false);
    expect(isInQuietHours(window, new Date("2026-02-08T14:30:00"))).toBe(false);
  });
});

