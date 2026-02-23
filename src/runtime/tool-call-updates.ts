import type { Logger } from "../logging/audit";
import type { ModelToolCallEvent } from "../model/types";
import { sendTelegramFormattedMessage } from "./message-sender";
import type { TelegramAdapter } from "../telegram/adapter";

function compactDetail(value: string, max = 260): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

export function formatToolCallUpdateMessage(event: ModelToolCallEvent): string {
  const suffix = event.phase === "final_summary" ? " (summary)" : "";
  if (event.type === "claude_tool_call") {
    const toolName = event.toolName?.trim() || "tool";
    return `🔧 tool[${event.backend}] ${toolName}: ${compactDetail(event.detail)}${suffix}`;
  }
  return `🔧 tool[${event.backend}] ${event.type}: ${compactDetail(event.detail)}${suffix}`;
}

export function createToolCallTelegramNotifier(params: {
  enabled: boolean;
  chatId: number;
  telegram: TelegramAdapter;
  logger: Logger;
  onSentText?: (text: string) => Promise<void> | void;
}): (event: ModelToolCallEvent) => Promise<void> {
  return async (event: ModelToolCallEvent): Promise<void> => {
    if (!params.enabled) {
      return;
    }

    const text = formatToolCallUpdateMessage(event);
    try {
      const result = await sendTelegramFormattedMessage({
        telegram: params.telegram,
        chatId: params.chatId,
        text,
      });
      await params.onSentText?.(result.sentText);
      params.logger.info("tool_call_update_emitted", {
        backend: event.backend,
        type: event.type,
        phase: event.phase,
        chatId: params.chatId,
        textLength: result.sentText.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger.warn("tool_call_update_send_failed", {
        backend: event.backend,
        type: event.type,
        phase: event.phase,
        chatId: params.chatId,
        message,
      });
    }
  };
}
