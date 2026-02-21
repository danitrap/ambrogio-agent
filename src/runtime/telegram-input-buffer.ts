import type { TelegramAttachment, TelegramMessage } from "../telegram/adapter";

export type BufferedVoiceItem = {
  fileId: string;
  mimeType: string | null;
  updateId: number;
};

export type BufferedTelegramInput = {
  chatId: number;
  userId: number;
  firstUpdateId: number;
  lastUpdateId: number;
  textSegments: string[];
  attachments: TelegramAttachment[];
  voiceItems: BufferedVoiceItem[];
  updates: TelegramMessage[];
};

type BufferEntry = {
  updates: TelegramMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
};

function bufferKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function toBufferedInput(updates: TelegramMessage[]): BufferedTelegramInput {
  const first = updates[0];
  const last = updates[updates.length - 1];
  if (!first || !last) {
    throw new Error("Cannot build buffered input from empty updates");
  }

  const textSegments = updates
    .map((update) => (update.text ?? "").trim())
    .filter((segment) => segment.length > 0);

  const attachments = updates.flatMap((update) => update.attachments);
  const voiceItems = updates
    .filter((update) => typeof update.voiceFileId === "string")
    .map((update) => ({
      fileId: update.voiceFileId as string,
      mimeType: update.voiceMimeType,
      updateId: update.updateId,
    }));

  return {
    chatId: first.chatId,
    userId: first.userId,
    firstUpdateId: first.updateId,
    lastUpdateId: last.updateId,
    textSegments,
    attachments,
    voiceItems,
    updates,
  };
}

export type TelegramInputBuffer = {
  enqueue: (update: TelegramMessage) => void;
  clear: () => void;
  dispose: () => void;
};

export function createTelegramInputBuffer(params: {
  idleMs: number;
  enabled: boolean;
  onFlush: (input: BufferedTelegramInput) => Promise<void>;
  onFlushError?: (error: unknown, input: BufferedTelegramInput) => Promise<void>;
}): TelegramInputBuffer {
  const entries = new Map<string, BufferEntry>();

  const clearEntryIfIdle = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    if (!entry.flushing && entry.timer === null && entry.updates.length === 0) {
      entries.delete(key);
    }
  };

  const runFlushForKey = async (key: string): Promise<void> => {
    const entry = entries.get(key);
    if (!entry || entry.flushing || entry.updates.length === 0) {
      return;
    }

    entry.flushing = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    const batch = entry.updates.splice(0, entry.updates.length);
    const buffered = toBufferedInput(batch);

    try {
      await params.onFlush(buffered);
    } catch (error) {
      if (params.onFlushError) {
        await params.onFlushError(error, buffered);
      }
    } finally {
      entry.flushing = false;
      if (entry.updates.length > 0) {
        if (params.enabled) {
          entry.timer = setTimeout(() => {
            void runFlushForKey(key);
          }, params.idleMs);
        } else {
          void runFlushForKey(key);
        }
      } else {
        clearEntryIfIdle(key);
      }
    }
  };

  const scheduleFlush = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (!params.enabled) {
      void runFlushForKey(key);
      return;
    }

    entry.timer = setTimeout(() => {
      void runFlushForKey(key);
    }, params.idleMs);
  };

  const enqueue = (update: TelegramMessage): void => {
    const key = bufferKey(update.chatId, update.userId);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        updates: [],
        timer: null,
        flushing: false,
      };
      entries.set(key, entry);
    }

    entry.updates.push(update);
    scheduleFlush(key);
  };

  const clear = (): void => {
    for (const entry of entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    entries.clear();
  };

  const dispose = (): void => {
    clear();
  };

  return {
    enqueue,
    clear,
    dispose,
  };
}
