export type TelegramMessage = {
  updateId: number;
  chatId: number;
  userId: number;
  text: string;
};

export class TelegramAdapter {
  private readonly baseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramMessage[]> {
    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message"],
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      ok: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          text?: string;
          from?: { id?: number };
          chat?: { id?: number };
        };
      }>;
    };

    if (!payload.ok || !Array.isArray(payload.result)) {
      return [];
    }

    return payload.result
      .map((item) => {
        const text = item.message?.text;
        const userId = item.message?.from?.id;
        const chatId = item.message?.chat?.id;
        if (typeof text !== "string" || typeof userId !== "number" || typeof chatId !== "number") {
          return null;
        }

        return {
          updateId: item.update_id,
          chatId,
          userId,
          text,
        } satisfies TelegramMessage;
      })
      .filter((message): message is TelegramMessage => message !== null);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status}`);
    }
  }
}
