import { describe, expect, test } from "bun:test";
import { TelegramAllowlist } from "../src/auth/allowlist";

describe("TelegramAllowlist", () => {
  test("allows only configured user", () => {
    const allowlist = new TelegramAllowlist(42);
    expect(allowlist.isAllowed(42)).toBe(true);
    expect(allowlist.isAllowed(7)).toBe(false);
  });
});
