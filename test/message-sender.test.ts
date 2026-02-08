import { describe, expect, test } from "bun:test";
import { sendTelegramTextReply } from "../src/runtime/message-sender";

class FakeTelegram {
  public calls: Array<{ chatId: number; text: string }> = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.calls.push({ chatId, text });
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

    expect(telegram.calls).toEqual([{ chatId: 3, text: "ciao" }]);
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
});
