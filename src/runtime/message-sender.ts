import type { Logger } from "../logging/audit";
import type { TelegramAdapter } from "../telegram/adapter";

const TELEGRAM_MESSAGE_LIMIT = 4000;

function previewText(value: string, max = 160): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

export async function sendTelegramTextReply(params: {
  telegram: TelegramAdapter;
  logger: Logger;
  update: { updateId: number; userId: number; chatId: number };
  text: string;
  command?: string;
  extraLogFields?: Record<string, unknown>;
  onSentText?: (text: string) => Promise<void> | void;
}): Promise<void> {
  const outbound = params.text.slice(0, TELEGRAM_MESSAGE_LIMIT);
  await params.telegram.sendMessage(params.update.chatId, outbound);
  await params.onSentText?.(outbound);
  params.logger.info("telegram_message_sent", {
    updateId: params.update.updateId,
    userId: params.update.userId,
    chatId: params.update.chatId,
    textLength: outbound.length,
    textPreview: previewText(outbound),
    ...(params.command ? { command: params.command } : {}),
    ...(params.extraLogFields ?? {}),
  });
}
