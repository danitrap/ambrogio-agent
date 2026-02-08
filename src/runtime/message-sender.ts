import type { Logger } from "../logging/audit";
import { correlationFields } from "../logging/correlation";
import { formatTelegramHtml, stripMarkdown } from "../telegram/formatting";
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
  const { sentText, formatMode } = await sendTelegramFormattedMessage({
    telegram: params.telegram,
    chatId: params.update.chatId,
    text: params.text,
  });

  await params.onSentText?.(sentText);
  params.logger.info("telegram_message_sent", {
    ...correlationFields({
      updateId: params.update.updateId,
      userId: params.update.userId,
      chatId: params.update.chatId,
      command: params.command,
    }),
    textLength: sentText.length,
    textPreview: previewText(sentText),
    formatMode,
    ...(params.extraLogFields ?? {}),
  });
}

export async function sendTelegramFormattedMessage(params: {
  telegram: TelegramAdapter;
  chatId: number;
  text: string;
}): Promise<{ sentText: string; formatMode: "html" | "plain_fallback" }> {
  const outbound = params.text.slice(0, TELEGRAM_MESSAGE_LIMIT);
  const htmlOutbound = formatTelegramHtml(outbound);
  const plainOutbound = stripMarkdown(outbound);

  try {
    await params.telegram.sendMessage(params.chatId, htmlOutbound, { parseMode: "HTML" });
    return { sentText: htmlOutbound, formatMode: "html" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("Telegram sendMessage failed: 400")) {
      throw error;
    }
    await params.telegram.sendMessage(params.chatId, plainOutbound);
    return { sentText: plainOutbound, formatMode: "plain_fallback" };
  }
}
