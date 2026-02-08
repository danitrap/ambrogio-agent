import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/audit";
import type { ElevenLabsTts } from "../model/elevenlabs-tts";
import type { TelegramAdapter } from "../telegram/adapter";
import { parseTelegramResponse } from "../telegram/response-mode";
import { sendTelegramTextReply } from "./message-sender";

function previewText(value: string, max = 160): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

export type ResolvedUploadPath = { realPath: string; relativePath: string };

function ensurePathWithinRoot(rootRealPath: string, targetRealPath: string): void {
  const normalizedRoot = rootRealPath.endsWith(path.sep) ? rootRealPath : `${rootRealPath}${path.sep}`;
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes root: ${targetRealPath}`);
  }
}

export async function resolveAudioPathForUpload(
  rootRealPath: string,
  inputPath: string,
  maxTelegramAudioBytes: number,
): Promise<ResolvedUploadPath> {
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    throw new Error("Usage: /sendaudio <relative-path-under-data-root>");
  }
  const absolute = path.resolve(rootRealPath, trimmedPath);
  const real = await realpath(absolute);
  ensurePathWithinRoot(rootRealPath, real);
  const fileStat = await stat(real);
  if (!fileStat.isFile()) {
    throw new Error("Target is not a file");
  }
  if (fileStat.size > maxTelegramAudioBytes) {
    throw new Error(`File too large for Telegram audio upload (${fileStat.size} bytes)`);
  }

  return {
    realPath: real,
    relativePath: path.relative(rootRealPath, real),
  };
}


export async function dispatchAssistantReply(params: {
  telegram: TelegramAdapter;
  logger: Logger;
  tts: ElevenLabsTts | null;
  rootRealPath: string;
  update: { updateId: number; userId: number; chatId: number };
  rawReply: string;
  noTtsPrefix?: string;
  forceAudio?: boolean;
  logContext?: { command?: string };
  onTextSent?: (text: string) => Promise<void>;
}): Promise<void> {
  const parsed = parseTelegramResponse(params.rawReply);
  const outbound = parsed.text.slice(0, 4000);
  const wantsAudio = params.forceAudio === true;

  if (wantsAudio && params.tts) {
    try {
      const audioBlob = await params.tts.synthesize(outbound);
      await params.telegram.sendAudio(params.update.chatId, audioBlob, `reply-${params.update.updateId}.mp3`);
      await params.onTextSent?.(`audio reply: ${previewText(outbound, 120)}`);
      params.logger.info("telegram_audio_reply_sent", {
        updateId: params.update.updateId,
        userId: params.update.userId,
        chatId: params.update.chatId,
        textLength: outbound.length,
        textPreview: previewText(outbound),
        mode: wantsAudio ? "audio" : "text",
        ...params.logContext,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger.warn("telegram_audio_reply_failed", {
        updateId: params.update.updateId,
        userId: params.update.userId,
        chatId: params.update.chatId,
        message,
        mode: wantsAudio ? "audio" : "text",
        ...params.logContext,
      });
      await sendTelegramTextReply({
        telegram: params.telegram,
        logger: params.logger,
        update: params.update,
        text: outbound,
        command: params.logContext?.command,
        extraLogFields: { mode: "text_fallback" },
        onSentText: params.onTextSent,
      });
      return;
    }
  }

  if (wantsAudio && !params.tts && params.noTtsPrefix) {
    const fallback = `${params.noTtsPrefix}\n\n${outbound}`.slice(0, 4000);
    await sendTelegramTextReply({
      telegram: params.telegram,
      logger: params.logger,
      update: params.update,
      text: fallback,
      command: params.logContext?.command,
      extraLogFields: { mode: "text_fallback_no_tts" },
      onSentText: params.onTextSent,
    });
    return;
  }

  await sendTelegramTextReply({
    telegram: params.telegram,
    logger: params.logger,
    update: params.update,
    text: outbound,
    command: params.logContext?.command,
    extraLogFields: { mode: "text" },
    onSentText: params.onTextSent,
  });
}
