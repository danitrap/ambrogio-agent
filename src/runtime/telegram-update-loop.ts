import type { TelegramAdapter, TelegramMessage } from "../telegram/adapter";

export async function startTelegramUpdateLoop(params: {
  telegram: TelegramAdapter;
  pollTimeoutSeconds: number;
  getOffset: () => number;
  setOffset: (offset: number) => void;
  processUpdate: (update: TelegramMessage) => Promise<void>;
  onPollError: (error: unknown) => Promise<void>;
}): Promise<never> {
  while (true) {
    try {
      const updates = await params.telegram.getUpdates(params.getOffset(), params.pollTimeoutSeconds);
      for (const update of updates) {
        params.setOffset(Math.max(params.getOffset(), update.updateId + 1));
        await params.processUpdate(update);
      }
    } catch (error) {
      await params.onPollError(error);
    }
  }
}

