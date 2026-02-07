import { afterEach, describe, expect, test } from "bun:test";
import { TelegramAdapter } from "../src/telegram/adapter";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TelegramAdapter", () => {
  test("sends typing chat action", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new TelegramAdapter("token");
    await adapter.sendTyping(123);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/sendChatAction");
    expect(calls[0]?.body).toContain('"chat_id":123');
    expect(calls[0]?.body).toContain('"action":"typing"');
  });

  test("throws when typing chat action request fails", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const adapter = new TelegramAdapter("token");
    await expect(adapter.sendTyping(1)).rejects.toThrow("Telegram sendChatAction failed: 500");
  });
});
