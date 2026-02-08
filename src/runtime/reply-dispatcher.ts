import { mkdir, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/audit";
import type { ElevenLabsTts } from "../model/elevenlabs-tts";
import type { TelegramAdapter } from "../telegram/adapter";
import { parseTelegramResponse } from "../telegram/response-mode";
import { sendTelegramTextReply } from "./message-sender";

export type ResolvedUploadPath = { realPath: string; relativePath: string };

function previewText(value: string, max = 160): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function ensurePathWithinRoot(rootRealPath: string, targetRealPath: string): void {
  const normalizedRoot = rootRealPath.endsWith(path.sep) ? rootRealPath : `${rootRealPath}${path.sep}`;
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes root: ${targetRealPath}`);
  }
}

async function resolveFilePathForUpload(
  rootRealPath: string,
  inputPath: string,
  opts: { emptyPathError: string; maxBytes: number; tooLargeErrorPrefix: string },
): Promise<ResolvedUploadPath> {
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    throw new Error(opts.emptyPathError);
  }

  const absolute = path.resolve(rootRealPath, trimmedPath);
  const real = await realpath(absolute);
  ensurePathWithinRoot(rootRealPath, real);

  const fileStat = await stat(real);
  if (!fileStat.isFile()) {
    throw new Error("Target is not a file");
  }
  if (fileStat.size > opts.maxBytes) {
    throw new Error(`${opts.tooLargeErrorPrefix} (${fileStat.size} bytes)`);
  }

  return {
    realPath: real,
    relativePath: path.relative(rootRealPath, real),
  };
}

export async function resolveAudioPathForUpload(
  rootRealPath: string,
  inputPath: string,
  maxTelegramAudioBytes: number,
): Promise<ResolvedUploadPath> {
  return resolveFilePathForUpload(rootRealPath, inputPath, {
    emptyPathError: "Usage: /sendaudio <relative-path-under-data-root>",
    maxBytes: maxTelegramAudioBytes,
    tooLargeErrorPrefix: "File too large for Telegram audio upload",
  });
}

async function resolveDocumentPathForUpload(
  rootRealPath: string,
  inputPath: string,
  maxTelegramDocumentBytes: number,
): Promise<ResolvedUploadPath> {
  return resolveFilePathForUpload(rootRealPath, inputPath, {
    emptyPathError: "Document path is empty",
    maxBytes: maxTelegramDocumentBytes,
    tooLargeErrorPrefix: "File too large for Telegram document upload",
  });
}

async function relocateGeneratedDocumentIfNeeded(
  rootRealPath: string,
  generatedScannedPdfsRelativeDir: string,
  resolvedPath: ResolvedUploadPath,
): Promise<ResolvedUploadPath> {
  if (!resolvedPath.relativePath.startsWith("attachments/") || !path.basename(resolvedPath.relativePath).includes("scannerizzato")) {
    return resolvedPath;
  }

  const now = new Date();
  const dateFolder = path.join(
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  );
  const generatedFolder = path.join(rootRealPath, generatedScannedPdfsRelativeDir, dateFolder);
  await mkdir(generatedFolder, { recursive: true });
  const targetPath = path.join(generatedFolder, path.basename(resolvedPath.relativePath));
  await rename(resolvedPath.realPath, targetPath);
  const realPath = await realpath(targetPath);
  return {
    realPath,
    relativePath: path.relative(rootRealPath, realPath),
  };
}

async function sendTaggedDocuments(params: {
  telegram: TelegramAdapter;
  logger: Logger;
  rootRealPath: string;
  update: { updateId: number; userId: number; chatId: number };
  documentPaths: string[];
  maxTelegramDocumentBytes: number;
  generatedScannedPdfsRelativeDir: string;
}): Promise<string[]> {
  if (params.documentPaths.length === 0) {
    return [];
  }

  const warnings: string[] = [];
  for (const documentPath of params.documentPaths) {
    try {
      const resolvedPath = await resolveDocumentPathForUpload(
        params.rootRealPath,
        documentPath,
        params.maxTelegramDocumentBytes,
      );
      const uploadPath = await relocateGeneratedDocumentIfNeeded(
        params.rootRealPath,
        params.generatedScannedPdfsRelativeDir,
        resolvedPath,
      );
      const documentBlob = Bun.file(uploadPath.realPath);
      await params.telegram.sendDocument(
        params.update.chatId,
        documentBlob,
        path.basename(uploadPath.relativePath),
        `File: ${uploadPath.relativePath}`,
      );
      params.logger.info("telegram_document_sent", {
        updateId: params.update.updateId,
        userId: params.update.userId,
        chatId: params.update.chatId,
        filePath: uploadPath.relativePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger.warn("telegram_document_send_failed", {
        updateId: params.update.updateId,
        userId: params.update.userId,
        chatId: params.update.chatId,
        message,
        documentPath,
      });
      warnings.push(`Documento non inviato (${message}).`);
    }
  }

  return warnings;
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
  maxTelegramDocumentBytes: number;
  generatedScannedPdfsRelativeDir: string;
}): Promise<void> {
  const parsed = parseTelegramResponse(params.rawReply);
  const warnings = await sendTaggedDocuments({
    telegram: params.telegram,
    logger: params.logger,
    rootRealPath: params.rootRealPath,
    update: params.update,
    documentPaths: parsed.documentPaths,
    maxTelegramDocumentBytes: params.maxTelegramDocumentBytes,
    generatedScannedPdfsRelativeDir: params.generatedScannedPdfsRelativeDir,
  });
  const warningPrefix = warnings.length > 0 ? `${warnings.join("\n")}\n\n` : "";
  const messageText = `${warningPrefix}${parsed.text}`.trim();
  const outbound = messageText.slice(0, 4000);
  const wantsAudio = params.forceAudio || parsed.mode === "audio";

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
        mode: wantsAudio ? "audio" : parsed.mode,
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
        mode: wantsAudio ? "audio" : parsed.mode,
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
    extraLogFields: { mode: parsed.mode },
    onSentText: params.onTextSent,
  });
}

