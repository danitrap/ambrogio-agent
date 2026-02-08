import { describe, expect, test } from "bun:test";
import { sendTelegramFormattedMessage, sendTelegramTextReply } from "../src/runtime/message-sender";

class FakeTelegram {
  public calls: Array<{ chatId: number; text: string; parseMode?: "HTML" }> = [];
  public failFirstSend = false;
  public failFirstError: Error | null = null;
  private sendCount = 0;

  async sendMessage(chatId: number, text: string, options?: { parseMode?: "HTML" }): Promise<void> {
    this.sendCount += 1;
    this.calls.push({ chatId, text, parseMode: options?.parseMode });
    if (this.failFirstError && this.sendCount === 1) {
      throw this.failFirstError;
    }
    if (this.failFirstSend && this.sendCount === 1) {
      throw new Error("Telegram sendMessage failed: 400");
    }
  }
}

class FakeLogger {
  public infos: Array<{ message: string; fields: Record<string, unknown> }> = [];

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.infos.push({ message, fields });
  }
}

describe("sendTelegramTextReply", () => {
  test("sends trimmed message to telegram and logs metadata", async () => {
    const telegram = new FakeTelegram();
    const logger = new FakeLogger();

    await sendTelegramTextReply({
      telegram: telegram as never,
      logger: logger as never,
      update: { updateId: 1, userId: 2, chatId: 3 },
      text: "ciao",
      command: "help",
    });

    expect(telegram.calls).toEqual([{ chatId: 3, text: "ciao", parseMode: "HTML" }]);
    expect(logger.infos[0]?.message).toBe("telegram_message_sent");
    expect(logger.infos[0]?.fields.command).toBe("help");
  });

  test("clips messages over telegram limit", async () => {
    const telegram = new FakeTelegram();
    const logger = new FakeLogger();

    await sendTelegramTextReply({
      telegram: telegram as never,
      logger: logger as never,
      update: { updateId: 1, userId: 2, chatId: 3 },
      text: "x".repeat(5000),
    });

    expect(telegram.calls[0]?.text.length).toBe(4000);
  });

  test("calls onSentText callback with outbound text", async () => {
    const telegram = new FakeTelegram();
    const logger = new FakeLogger();
    const sent: string[] = [];

    await sendTelegramTextReply({
      telegram: telegram as never,
      logger: logger as never,
      update: { updateId: 1, userId: 2, chatId: 3 },
      text: "ciao callback",
      onSentText: (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual(["ciao callback"]);
  });

  test("falls back to plain text when html send fails", async () => {
    const telegram = new FakeTelegram();
    telegram.failFirstSend = true;
    const logger = new FakeLogger();

    await sendTelegramTextReply({
      telegram: telegram as never,
      logger: logger as never,
      update: { updateId: 1, userId: 2, chatId: 3 },
      text: "**ciao** <tag>",
    });

    expect(telegram.calls).toHaveLength(2);
    expect(telegram.calls[0]).toEqual({ chatId: 3, text: "<b>ciao</b> &lt;tag&gt;", parseMode: "HTML" });
    expect(telegram.calls[1]).toEqual({ chatId: 3, text: "ciao <tag>", parseMode: undefined });
  });
});

describe("sendTelegramFormattedMessage", () => {
  test("sends html-formatted text and reports html mode", async () => {
    const telegram = new FakeTelegram();

    const result = await sendTelegramFormattedMessage({
      telegram: telegram as never,
      chatId: 3,
      text: "**ciao**",
    });

    expect(telegram.calls).toEqual([{ chatId: 3, text: "<b>ciao</b>", parseMode: "HTML" }]);
    expect(result).toEqual({ sentText: "<b>ciao</b>", formatMode: "html" });
  });

  test("falls back to plain text on telegram 400 parse errors", async () => {
    const telegram = new FakeTelegram();
    telegram.failFirstSend = true;

    const result = await sendTelegramFormattedMessage({
      telegram: telegram as never,
      chatId: 3,
      text: "**ciao** <tag>",
    });

    expect(telegram.calls).toHaveLength(2);
    expect(telegram.calls[0]).toEqual({ chatId: 3, text: "<b>ciao</b> &lt;tag&gt;", parseMode: "HTML" });
    expect(telegram.calls[1]).toEqual({ chatId: 3, text: "ciao <tag>", parseMode: undefined });
    expect(result).toEqual({ sentText: "ciao <tag>", formatMode: "plain_fallback" });
  });

  test("rethrows non-400 telegram errors", async () => {
    const telegram = new FakeTelegram();
    telegram.failFirstError = new Error("Telegram sendMessage failed: 500");

    await expect(
      sendTelegramFormattedMessage({
        telegram: telegram as never,
        chatId: 3,
        text: "ciao",
      }),
    ).rejects.toThrow("Telegram sendMessage failed: 500");
    expect(telegram.calls).toHaveLength(1);
  });
});
