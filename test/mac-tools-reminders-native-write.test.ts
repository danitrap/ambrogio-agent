import { describe, expect, test } from "bun:test";
import { buildAppleScriptDateBlock, normalizeReminderId } from "../src/mac-tools/providers/reminders-native-write";

describe("RemindersNativeWrite", () => {
  test("builds locale-safe AppleScript date assignments from ISO input", () => {
    const block = buildAppleScriptDateBlock("targetDueDate", "2026-03-01T09:00:00+01:00");
    expect(block).toContain("set targetDueDate to (current date)");
    expect(block).toContain("set year of targetDueDate to 2026");
    expect(block).toContain("set month of targetDueDate to March");
    expect(block).toContain("set day of targetDueDate to 1");
    expect(block).toContain("set time of targetDueDate to 32400");
  });

  test("normalizes x-apple reminder ids to bare UUIDs", () => {
    expect(normalizeReminderId("x-apple-reminder://ABC-123")).toBe("ABC-123");
    expect(normalizeReminderId("ABC-123")).toBe("ABC-123");
  });
});
