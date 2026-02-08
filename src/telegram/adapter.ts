export type TelegramAttachment = {
  kind: "document" | "photo";
  fileId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
};

export type TelegramMessage = {
  updateId: number;
  chatId: number;
  userId: number;
  text: string | null;
  voiceFileId: string | null;
  voiceMimeType: string | null;
  attachments: TelegramAttachment[];
};

export type TelegramDownload = {
  fileBlob: Blob;
  fileName: string;
  mimeType: string | null;
};

export class TelegramAdapter {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${botToken}`;
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
          voice?: {
            file_id?: string;
            mime_type?: string;
          };
          document?: {
            file_id?: string;
            file_name?: string;
            mime_type?: string;
            file_size?: number;
          };
          photo?: Array<{
            file_id?: string;
            file_size?: number;
            width?: number;
            height?: number;
          }>;
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
        const voiceFileId = item.message?.voice?.file_id;
        const voiceMimeType = item.message?.voice?.mime_type;
        const document = item.message?.document;
        const photos = item.message?.photo;
        const userId = item.message?.from?.id;
        const chatId = item.message?.chat?.id;
        const hasText = typeof text === "string";
        const hasVoice = typeof voiceFileId === "string";
        const attachments: TelegramAttachment[] = [];
        if (typeof document?.file_id === "string") {
          attachments.push({
            kind: "document",
            fileId: document.file_id,
            fileName: typeof document.file_name === "string" ? document.file_name : null,
            mimeType: typeof document.mime_type === "string" ? document.mime_type : null,
            fileSize: typeof document.file_size === "number" ? document.file_size : null,
          });
        }
        if (Array.isArray(photos) && photos.length > 0) {
          const bestPhoto = photos[photos.length - 1];
          if (bestPhoto && typeof bestPhoto.file_id === "string") {
            attachments.push({
              kind: "photo",
              fileId: bestPhoto.file_id,
              fileName: null,
              mimeType: null,
              fileSize: typeof bestPhoto.file_size === "number" ? bestPhoto.file_size : null,
            });
          }
        }

        if ((!hasText && !hasVoice && attachments.length === 0) || typeof userId !== "number" || typeof chatId !== "number") {
          return null;
        }

        return {
          updateId: item.update_id,
          chatId,
          userId,
          text: hasText ? text : null,
          voiceFileId: hasVoice ? voiceFileId : null,
          voiceMimeType: typeof voiceMimeType === "string" ? voiceMimeType : null,
          attachments,
        } satisfies TelegramMessage;
      })
      .filter((message): message is TelegramMessage => message !== null);
  }

  async downloadFileById(fileId: string): Promise<TelegramDownload> {
    const getFileResponse = await fetch(`${this.baseUrl}/getFile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        file_id: fileId,
      }),
    });

    if (!getFileResponse.ok) {
      throw new Error(`Telegram getFile failed: ${getFileResponse.status}`);
    }

    const payload = (await getFileResponse.json()) as {
      ok: boolean;
      result?: {
        file_path?: string;
      };
    };

    const filePath = payload.result?.file_path;
    if (!payload.ok || typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("Telegram getFile returned invalid file path");
    }

    const fileResponse = await fetch(`${this.fileBaseUrl}/${filePath}`);
    if (!fileResponse.ok) {
      throw new Error(`Telegram file download failed: ${fileResponse.status}`);
    }

    const fileBlob = await fileResponse.blob();
    const segments = filePath.split("/");
    const fileName = segments[segments.length - 1] ?? "voice.ogg";
    const mimeType = fileResponse.headers.get("content-type");
    return {
      fileBlob,
      fileName,
      mimeType,
    };
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

  async sendTyping(chatId: number): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendChatAction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        action: "typing",
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendChatAction failed: ${response.status}`);
    }
  }

  async sendAudio(chatId: number, audioBlob: Blob, fileName: string, caption?: string): Promise<void> {
    const body = new FormData();
    body.append("chat_id", String(chatId));
    body.append("audio", new File([audioBlob], fileName, {
      type: audioBlob.type || "application/octet-stream",
    }));
    if (caption) {
      body.append("caption", caption);
    }

    const response = await fetch(`${this.baseUrl}/sendAudio`, {
      method: "POST",
      body,
    });

    if (!response.ok) {
      throw new Error(`Telegram sendAudio failed: ${response.status}`);
    }
  }
}
