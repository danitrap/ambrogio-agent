import { afterEach, describe, expect, test } from "bun:test";
import { TelegramAdapter } from "../src/telegram/adapter";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TelegramAdapter", () => {
  test("parses voice messages from updates", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      result: [
        {
          update_id: 11,
          message: {
            from: { id: 42 },
            chat: { id: 77 },
            voice: {
              file_id: "voice-file-id",
              duration: 5,
              mime_type: "audio/ogg",
            },
          },
        },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const adapter = new TelegramAdapter("token");
    const updates = await adapter.getUpdates(0, 10);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      updateId: 11,
      chatId: 77,
      userId: 42,
      text: null,
      voiceFileId: "voice-file-id",
      voiceMimeType: "audio/ogg",
      attachments: [],
    });
  });

  test("parses document and photo attachments from updates", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      result: [
        {
          update_id: 21,
          message: {
            from: { id: 1 },
            chat: { id: 2 },
            text: "guarda allegato",
            document: {
              file_id: "doc-1",
              file_name: "readme.md",
              mime_type: "text/markdown",
              file_size: 42,
            },
          },
        },
        {
          update_id: 22,
          message: {
            from: { id: 1 },
            chat: { id: 2 },
            photo: [
              { file_id: "small", file_size: 10, width: 100, height: 100 },
              { file_id: "large", file_size: 100, width: 1000, height: 1000 },
            ],
          },
        },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const adapter = new TelegramAdapter("token");
    const updates = await adapter.getUpdates(0, 10);

    expect(updates).toHaveLength(2);
    expect(updates[0]?.attachments).toEqual([
      {
        kind: "document",
        fileId: "doc-1",
        fileName: "readme.md",
        mimeType: "text/markdown",
        fileSize: 42,
      },
    ]);
    expect(updates[1]?.attachments).toEqual([
      {
        kind: "photo",
        fileId: "large",
        fileName: null,
        mimeType: null,
        fileSize: 100,
      },
    ]);
  });

  test("downloads telegram file by file id", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: String(init?.body ?? ""),
      });

      if (String(input).includes("/getFile")) {
        return new Response(JSON.stringify({
          ok: true,
          result: { file_path: "voice/file.oga" },
        }), { status: 200 });
      }

      return new Response("audio", {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;

    const adapter = new TelegramAdapter("token");
    const result = await adapter.downloadFileById("voice-file-id");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/getFile");
    expect(calls[0]?.body).toContain('"file_id":"voice-file-id"');
    expect(calls[1]?.url).toContain("/file/bottoken/voice/file.oga");
    expect(result.mimeType).toBe("audio/ogg");
    expect(result.fileName).toBe("file.oga");
    expect(result.fileBlob.size).toBe(5);
  });

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

  test("sends audio with multipart form data", async () => {
    let requestBody: unknown;
    let requestUrl = "";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = init?.body;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new TelegramAdapter("token");
    await adapter.sendAudio(999, new Blob(["mp3"], { type: "audio/mpeg" }), "milano_oggi.mp3", "Meteo Milano");

    expect(requestUrl).toContain("/sendAudio");
    expect(requestBody instanceof FormData).toBe(true);
    const form = requestBody as FormData;
    expect(form.get("chat_id")).toBe("999");
    expect(form.get("caption")).toBe("Meteo Milano");
    const audio = form.get("audio");
    expect(audio instanceof File).toBe(true);
    expect((audio as File).name).toBe("milano_oggi.mp3");
  });

  test("throws when sending audio fails", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const adapter = new TelegramAdapter("token");
    await expect(adapter.sendAudio(1, new Blob(["a"]), "a.mp3")).rejects.toThrow("Telegram sendAudio failed: 500");
  });

  test("sends document with multipart form data", async () => {
    let requestBody: unknown;
    let requestUrl = "";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = init?.body;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new TelegramAdapter("token");
    await adapter.sendDocument(999, new Blob(["pdf"], { type: "application/pdf" }), "giftcard_scannerizzato.pdf", "File pronto");

    expect(requestUrl).toContain("/sendDocument");
    expect(requestBody instanceof FormData).toBe(true);
    const form = requestBody as FormData;
    expect(form.get("chat_id")).toBe("999");
    expect(form.get("caption")).toBe("File pronto");
    const document = form.get("document");
    expect(document instanceof File).toBe(true);
    expect((document as File).name).toBe("giftcard_scannerizzato.pdf");
  });

  test("throws when sending document fails", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const adapter = new TelegramAdapter("token");
    await expect(adapter.sendDocument(1, new Blob(["a"]), "a.pdf")).rejects.toThrow("Telegram sendDocument failed: 500");
  });
});
