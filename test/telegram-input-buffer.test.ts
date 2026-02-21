import { describe, expect, test } from "bun:test";
import { createTelegramInputBuffer } from "../src/runtime/telegram-input-buffer";
import type { TelegramMessage } from "../src/telegram/adapter";

function update(overrides: Partial<TelegramMessage>): TelegramMessage {
  return {
    updateId: 1,
    chatId: 10,
    userId: 20,
    text: null,
    voiceFileId: null,
    voiceMimeType: null,
    attachments: [],
    ...overrides,
  };
}

describe("createTelegramInputBuffer", () => {
  test("coalesces consecutive messages into a single flush", async () => {
    const flushed: Array<{ firstUpdateId: number; lastUpdateId: number; textSegments: string[] }> = [];
    const buffer = createTelegramInputBuffer({
      idleMs: 30,
      enabled: true,
      onFlush: async (input) => {
        flushed.push({
          firstUpdateId: input.firstUpdateId,
          lastUpdateId: input.lastUpdateId,
          textSegments: input.textSegments,
        });
      },
    });

    buffer.enqueue(update({ updateId: 1, text: "ciao" }));
    await Bun.sleep(10);
    buffer.enqueue(update({ updateId: 2, text: "come va" }));

    await Bun.sleep(60);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual({
      firstUpdateId: 1,
      lastUpdateId: 2,
      textSegments: ["ciao", "come va"],
    });

    buffer.dispose();
  });

  test("keeps buffers isolated by chat/user key", async () => {
    const flushed: string[] = [];
    const buffer = createTelegramInputBuffer({
      idleMs: 20,
      enabled: true,
      onFlush: async (input) => {
        flushed.push(`${input.chatId}:${input.userId}:${input.lastUpdateId}`);
      },
    });

    buffer.enqueue(update({ updateId: 10, chatId: 1, userId: 1, text: "a" }));
    buffer.enqueue(update({ updateId: 20, chatId: 2, userId: 1, text: "b" }));

    await Bun.sleep(50);

    expect(flushed.sort()).toEqual(["1:1:10", "2:1:20"]);

    buffer.dispose();
  });

  test("aggregates attachments and voice items", async () => {
    const flushed: Array<{ attachments: number; voiceIds: string[]; textSegments: string[] }> = [];
    const buffer = createTelegramInputBuffer({
      idleMs: 20,
      enabled: true,
      onFlush: async (input) => {
        flushed.push({
          attachments: input.attachments.length,
          voiceIds: input.voiceItems.map((item) => item.fileId),
          textSegments: input.textSegments,
        });
      },
    });

    buffer.enqueue(update({
      updateId: 1,
      attachments: [{ kind: "photo", fileId: "ph-1", fileName: null, mimeType: null, fileSize: 123 }],
    }));
    buffer.enqueue(update({
      updateId: 2,
      voiceFileId: "voice-1",
      voiceMimeType: "audio/ogg",
      text: "contesto",
    }));

    await Bun.sleep(50);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual({
      attachments: 1,
      voiceIds: ["voice-1"],
      textSegments: ["contesto"],
    });

    buffer.dispose();
  });
});
