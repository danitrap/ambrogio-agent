import { describe, expect, test } from "bun:test";
import { shouldDeduplicateHeartbeatMessage } from "../src/runtime/heartbeat-dedup";

describe("shouldDeduplicateHeartbeatMessage", () => {
  test("returns true for same fingerprint within window", () => {
    const nowMs = Date.parse("2026-02-08T12:00:00.000Z");
    const result = shouldDeduplicateHeartbeatMessage({
      lastFingerprint: "abc",
      lastSentAtIso: "2026-02-08T11:30:00.000Z",
      nextFingerprint: "abc",
      nowMs,
      dedupWindowMs: 4 * 60 * 60 * 1000,
    });
    expect(result).toBe(true);
  });

  test("returns false for different fingerprint", () => {
    const nowMs = Date.parse("2026-02-08T12:00:00.000Z");
    const result = shouldDeduplicateHeartbeatMessage({
      lastFingerprint: "abc",
      lastSentAtIso: "2026-02-08T11:30:00.000Z",
      nextFingerprint: "xyz",
      nowMs,
      dedupWindowMs: 4 * 60 * 60 * 1000,
    });
    expect(result).toBe(false);
  });

  test("returns false when previous timestamp is invalid", () => {
    const nowMs = Date.parse("2026-02-08T12:00:00.000Z");
    const result = shouldDeduplicateHeartbeatMessage({
      lastFingerprint: "abc",
      lastSentAtIso: "not-a-date",
      nextFingerprint: "abc",
      nowMs,
      dedupWindowMs: 4 * 60 * 60 * 1000,
    });
    expect(result).toBe(false);
  });

  test("returns false when outside dedup window", () => {
    const nowMs = Date.parse("2026-02-08T12:00:00.000Z");
    const result = shouldDeduplicateHeartbeatMessage({
      lastFingerprint: "abc",
      lastSentAtIso: "2026-02-08T06:00:00.000Z",
      nextFingerprint: "abc",
      nowMs,
      dedupWindowMs: 4 * 60 * 60 * 1000,
    });
    expect(result).toBe(false);
  });
});
