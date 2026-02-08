import { mkdir, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { AttachmentService, type ProcessedAttachment } from "./attachments/attachment-service";
import { TelegramAllowlist } from "./auth/allowlist";
import { AgentService } from "./app/agent-service";
import { loadConfig } from "./config/env";
import { Logger } from "./logging/audit";
import { ExecBridge } from "./model/exec-bridge";
import { ElevenLabsTts } from "./model/elevenlabs-tts";
import { OpenAiTranscriber } from "./model/openai-transcriber";
import { runAgentRequestWithTimeout } from "./runtime/agent-request";
import { handleTelegramCommand } from "./runtime/command-handlers";
import { HEARTBEAT_FILE_NAME, HEARTBEAT_INTERVAL_MS, runHeartbeatCycle } from "./runtime/heartbeat";
import {
  clearRecentTelegramMessages,
  MAX_RECENT_TELEGRAM_MESSAGES,
  loadRecentTelegramMessages,
  saveRecentTelegramMessages,
} from "./runtime/recent-telegram-history";
import { sendTelegramTextReply } from "./runtime/message-sender";
import { bootstrapProjectSkills } from "./skills/bootstrap";
import { SkillDiscovery } from "./skills/discovery";
import { TelegramAdapter } from "./telegram/adapter";
import { parseTelegramCommand } from "./telegram/commands";
import { parseTelegramResponse } from "./telegram/response-mode";

const TYPING_INTERVAL_MS = 4_000;
const MODEL_TIMEOUT_MS = 180_000;
const MAX_TELEGRAM_AUDIO_BYTES = 49_000_000;
const MAX_TELEGRAM_DOCUMENT_BYTES = 49_000_000;
const MAX_INLINE_ATTACHMENT_TEXT_BYTES = 64 * 1024;
const GENERATED_SCANNED_PDFS_RELATIVE_DIR = "generated/scanned-pdfs";

function previewText(value: string, max = 160): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function buildLastLogMessage(summary: ReturnType<ExecBridge["getLastExecutionSummary"]>): string {
  if (!summary) {
    return "Nessuna esecuzione codex disponibile ancora.";
  }

  const lines = [
    `Command: ${summary.command}`,
    `Request ID: ${summary.requestId ?? "n/a"}`,
    `Status: ${summary.status}`,
    `Started: ${summary.startedAt}`,
    `Prompt chars: ${summary.promptLength}`,
  ];

  if (typeof summary.durationMs === "number") {
    lines.push(`Duration: ${formatDuration(summary.durationMs)}`);
  }
  if (typeof summary.exitCode === "number") {
    lines.push(`Exit code: ${summary.exitCode}`);
  }
  if (typeof summary.stdoutLength === "number") {
    lines.push(`Stdout chars: ${summary.stdoutLength}`);
  }
  if (typeof summary.stderrLength === "number") {
    lines.push(`Stderr chars: ${summary.stderrLength}`);
  }
  if (typeof summary.outputLength === "number") {
    lines.push(`Output chars: ${summary.outputLength}`);
  }
  if (summary.stdoutPreview) {
    lines.push(`Stdout preview: ${summary.stdoutPreview}`);
  }
  if (summary.stderrPreview) {
    lines.push(`Stderr preview: ${summary.stderrPreview}`);
  }
  if (summary.outputPreview) {
    lines.push(`Output preview: ${summary.outputPreview}`);
  }
  if (summary.errorMessage) {
    lines.push(`Error: ${summary.errorMessage}`);
  }

  return lines.join("\n");
}

function ensurePathWithinRoot(rootRealPath: string, targetRealPath: string): void {
  const normalizedRoot = rootRealPath.endsWith(path.sep) ? rootRealPath : `${rootRealPath}${path.sep}`;
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes root: ${targetRealPath}`);
  }
}

type ResolvedUploadPath = { realPath: string; relativePath: string };

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

async function resolveAudioPathForUpload(rootRealPath: string, inputPath: string): Promise<ResolvedUploadPath> {
  return resolveFilePathForUpload(rootRealPath, inputPath, {
    emptyPathError: "Usage: /sendaudio <relative-path-under-data-root>",
    maxBytes: MAX_TELEGRAM_AUDIO_BYTES,
    tooLargeErrorPrefix: "File too large for Telegram audio upload",
  });
}

async function resolveDocumentPathForUpload(rootRealPath: string, inputPath: string): Promise<ResolvedUploadPath> {
  return resolveFilePathForUpload(rootRealPath, inputPath, {
    emptyPathError: "Document path is empty",
    maxBytes: MAX_TELEGRAM_DOCUMENT_BYTES,
    tooLargeErrorPrefix: "File too large for Telegram document upload",
  });
}

async function relocateGeneratedDocumentIfNeeded(rootRealPath: string, resolvedPath: ResolvedUploadPath): Promise<ResolvedUploadPath> {
  if (!resolvedPath.relativePath.startsWith("attachments/") || !path.basename(resolvedPath.relativePath).includes("scannerizzato")) {
    return resolvedPath;
  }

  const now = new Date();
  const dateFolder = path.join(
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  );
  const generatedFolder = path.join(rootRealPath, GENERATED_SCANNED_PDFS_RELATIVE_DIR, dateFolder);
  await mkdir(generatedFolder, { recursive: true });
  const targetPath = path.join(generatedFolder, path.basename(resolvedPath.relativePath));
  await rename(resolvedPath.realPath, targetPath);
  const realPath = await realpath(targetPath);
  return {
    realPath,
    relativePath: path.relative(rootRealPath, realPath),
  };
}

async function sendTaggedDocuments(
  telegram: TelegramAdapter,
  logger: Logger,
  rootRealPath: string,
  update: { updateId: number; userId: number; chatId: number },
  documentPaths: string[],
): Promise<string[]> {
  if (documentPaths.length === 0) {
    return [];
  }

  const warnings: string[] = [];
  for (const documentPath of documentPaths) {
    try {
      const resolvedPath = await resolveDocumentPathForUpload(rootRealPath, documentPath);
      const uploadPath = await relocateGeneratedDocumentIfNeeded(rootRealPath, resolvedPath);
      const documentBlob = Bun.file(uploadPath.realPath);
      await telegram.sendDocument(update.chatId, documentBlob, path.basename(uploadPath.relativePath), `File: ${uploadPath.relativePath}`);
      logger.info("telegram_document_sent", {
        updateId: update.updateId,
        userId: update.userId,
        chatId: update.chatId,
        filePath: uploadPath.relativePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("telegram_document_send_failed", {
        updateId: update.updateId,
        userId: update.userId,
        chatId: update.chatId,
        message,
        documentPath,
      });
      warnings.push(`Documento non inviato (${message}).`);
    }
  }

  return warnings;
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort);
  });
}

async function startTypingLoop(
  telegram: TelegramAdapter,
  logger: Logger,
  chatId: number,
  updateId: number,
  userId: number,
  signal: AbortSignal,
): Promise<void> {
  logger.info("typing_started", { updateId, userId, chatId });

  while (!signal.aborted) {
    try {
      await telegram.sendTyping(chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("typing_heartbeat_failed", { updateId, userId, chatId, message });
    }

    await waitOrAbort(TYPING_INTERVAL_MS, signal);
  }

  logger.info("typing_stopped", { updateId, userId, chatId });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new Error("MODEL_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runWithTypingAndTimeout<T>(params: {
  telegram: TelegramAdapter;
  logger: Logger;
  chatId: number;
  updateId: number;
  userId: number;
  timeoutMs: number;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const typingLoop = startTypingLoop(
    params.telegram,
    params.logger,
    params.chatId,
    params.updateId,
    params.userId,
    controller.signal,
  );

  try {
    return await withTimeout(params.operation(controller.signal), params.timeoutMs, () => {
      controller.abort();
    });
  } finally {
    controller.abort();
    await typingLoop;
  }
}

async function dispatchAssistantReply(params: {
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
  const warnings = await sendTaggedDocuments(
    params.telegram,
    params.logger,
    params.rootRealPath,
    params.update,
    parsed.documentPaths,
  );
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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const codexHome = Bun.env.CODEX_HOME ?? `${config.dataRoot}/.codex`;
  const homeDir = Bun.env.HOME ?? config.dataRoot;

  await mkdir(homeDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(config.dataRoot, GENERATED_SCANNED_PDFS_RELATIVE_DIR), { recursive: true });

  const telegram = new TelegramAdapter(config.telegramBotToken);
  const allowlist = new TelegramAllowlist(config.telegramAllowedUserId);
  const dataRootRealPath = await realpath(config.dataRoot);

  const projectSkillsRoot = Bun.env.PROJECT_SKILLS_ROOT ?? path.resolve(import.meta.dir, "..", "skills");
  const dataSkillsRoot = `${config.dataRoot}/skills`;
  const bootstrapResult = await bootstrapProjectSkills({
    sourceRoot: projectSkillsRoot,
    destinationRoot: dataSkillsRoot,
  });
  if (bootstrapResult.copied.length > 0 || bootstrapResult.skipped.length > 0) {
    logger.info("skills_bootstrap_completed", {
      sourceRoot: projectSkillsRoot,
      destinationRoot: dataSkillsRoot,
      copiedCount: bootstrapResult.copied.length,
      skippedCount: bootstrapResult.skipped.length,
      copied: bootstrapResult.copied,
      skipped: bootstrapResult.skipped,
    });
  }

  const skills = new SkillDiscovery([
    dataSkillsRoot,
    `${codexHome}/skills`,
  ]);
  const modelBridge = new ExecBridge(config.codexCommand, config.codexArgs, logger, {
    cwd: config.dataRoot,
    env: {
      CODEX_HOME: codexHome,
      HOME: homeDir,
      NO_COLOR: Bun.env.NO_COLOR ?? "1",
    },
  });
  const transcriber = new OpenAiTranscriber(config.openaiApiKey);
  const attachmentService = new AttachmentService(config.dataRoot, MAX_INLINE_ATTACHMENT_TEXT_BYTES);
  const tts = config.elevenLabsApiKey ? new ElevenLabsTts(config.elevenLabsApiKey) : null;

  const agent = new AgentService({
    allowlist,
    modelBridge,
    skills,
    logger,
  });

  logger.info("agent_started", {
    dataRoot: config.dataRoot,
    codexCommand: config.codexCommand,
  });

  let offset = 0;
  const startedAtMs = Date.now();
  let handledMessages = 0;
  let failedMessages = 0;
  let lastAuthorizedChatId: number | null = null;
  let lastTelegramMessageAtMs: number | null = null;
  let lastTelegramMessageSummary = "n/a";
  const recentTelegramMessages = await loadRecentTelegramMessages(config.dataRoot);
  if (recentTelegramMessages.length > 0) {
    const lastEntry = recentTelegramMessages[recentTelegramMessages.length - 1];
    if (lastEntry) {
      const separator = " - ";
      const separatorIndex = lastEntry.indexOf(separator);
      if (separatorIndex > 0) {
        const timestamp = lastEntry.slice(0, separatorIndex);
        const parsed = Date.parse(timestamp);
        if (Number.isFinite(parsed)) {
          lastTelegramMessageAtMs = parsed;
        }
        lastTelegramMessageSummary = lastEntry.slice(separatorIndex + separator.length) || "n/a";
      } else {
        lastTelegramMessageSummary = lastEntry;
      }
    }
  }
  const lastPromptByUser = new Map<number, string>();
  let heartbeatInFlight = false;
  let heartbeatLastRunAt: string | null = null;
  let heartbeatLastResult: "never" | "ok" | "ok_notice_sent" | "alert_sent" | "alert_dropped" | "skipped_inflight" = "never";

  const readHeartbeatDoc = async (): Promise<string | null> => {
    const heartbeatPath = `${config.dataRoot}/${HEARTBEAT_FILE_NAME}`;
    try {
      return await readFile(heartbeatPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("heartbeat_doc_read_failed", { heartbeatPath, message });
      return null;
    }
  };

  const pushRecentTelegramMessage = (summary: string): void => {
    recentTelegramMessages.push(summary);
    const maxEntries = MAX_RECENT_TELEGRAM_MESSAGES;
    if (recentTelegramMessages.length > maxEntries) {
      recentTelegramMessages.splice(0, recentTelegramMessages.length - maxEntries);
    }
  };

  const persistRecentTelegramHistory = async (): Promise<void> => {
    try {
      await saveRecentTelegramMessages(config.dataRoot, recentTelegramMessages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("telegram_history_persist_failed", { message });
    }
  };

  const recordRecentTelegramEntry = async (role: "user" | "assistant", summary: string, atMs?: number): Promise<void> => {
    const timestamp = new Date(atMs ?? Date.now()).toISOString();
    pushRecentTelegramMessage(`${timestamp} - ${role}: ${summary}`);
    await persistRecentTelegramHistory();
  };

  const runHeartbeatPromptWithTimeout = async (prompt: string, requestId: string): Promise<string> => {
    const controller = new AbortController();
    const result = await withTimeout(
      (async () => {
        const discovered = await skills.discover();
        const hydrated = await Promise.all(discovered.map((skill) => skills.hydrate(skill)));
        return modelBridge.respond({
          requestId,
          message: prompt,
          skills: hydrated,
          signal: controller.signal,
        });
      })(),
      MODEL_TIMEOUT_MS,
      () => {
        controller.abort();
      },
    );
    return result.text ?? "";
  };

  const buildHeartbeatRuntimeStatus = (): string => {
    const nowMs = Date.now();
    const summary = modelBridge.getLastExecutionSummary();
    const idle = lastTelegramMessageAtMs === null ? "n/a" : formatDuration(nowMs - lastTelegramMessageAtMs);
    const lastTelegramAt = lastTelegramMessageAtMs === null ? "n/a" : new Date(lastTelegramMessageAtMs).toISOString();
    const codexSummary = summary
      ? `${summary.status} (${summary.startedAt}${typeof summary.durationMs === "number" ? `, ${formatDuration(summary.durationMs)}` : ""})`
      : "n/a";
    const recentMessages = recentTelegramMessages.length === 0
      ? ["none"]
      : recentTelegramMessages.slice(-5).map((entry, index) => `${index + 1}. ${entry}`);

    return [
      "Runtime status:",
      `Now: ${new Date(nowMs).toISOString()}`,
      `Uptime: ${formatDuration(nowMs - startedAtMs)}`,
      `Handled messages: ${handledMessages}`,
      `Failed messages: ${failedMessages}`,
      `Heartbeat in flight: ${heartbeatInFlight ? "yes" : "no"}`,
      `Heartbeat last run: ${heartbeatLastRunAt ?? "n/a"}`,
      `Heartbeat last result: ${heartbeatLastResult}`,
      `Last telegram message at: ${lastTelegramAt}`,
      `Idle since last telegram message: ${idle}`,
      `Last telegram message summary: ${lastTelegramMessageSummary}`,
      "Recent telegram messages (last 5):",
      ...recentMessages,
      `Last codex exec: ${codexSummary}`,
    ].join("\n");
  };

  const runScheduledHeartbeat = async (
    trigger: "timer" | "manual",
  ): Promise<{ status: "ok" | "ok_notice_sent" | "alert_sent" | "alert_dropped" | "skipped_inflight"; requestId?: string }> => {
    if (heartbeatInFlight) {
      logger.warn("heartbeat_skipped_inflight");
      heartbeatLastResult = "skipped_inflight";
      return { status: "skipped_inflight" };
    }

    heartbeatInFlight = true;
    heartbeatLastRunAt = new Date().toISOString();
    const requestId = `heartbeat-${Date.now()}`;
    try {
      const cycleResult = await runHeartbeatCycle({
        logger,
        readHeartbeatDoc,
        runHeartbeatPrompt: async ({ prompt, requestId: cycleRequestId }) =>
          runHeartbeatPromptWithTimeout(`${prompt}\n\n${buildHeartbeatRuntimeStatus()}`, cycleRequestId),
        getAlertChatId: () => lastAuthorizedChatId,
        sendAlert: async (chatId, message) => {
          await telegram.sendMessage(chatId, message);
          await recordRecentTelegramEntry("assistant", `heartbeat alert: ${previewText(message, 120)}`);
        },
        requestId,
      });
      heartbeatLastResult = cycleResult.status;
      logger.info("heartbeat_finished", { trigger, requestId, status: cycleResult.status });
      return { status: cycleResult.status, requestId };
    } finally {
      heartbeatInFlight = false;
    }
  };

  setInterval(() => {
    void runScheduledHeartbeat("timer");
  }, HEARTBEAT_INTERVAL_MS);
  logger.info("heartbeat_loop_started", {
    intervalMs: HEARTBEAT_INTERVAL_MS,
    filePath: `${config.dataRoot}/${HEARTBEAT_FILE_NAME}`,
  });

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset, config.telegramPollTimeoutSeconds);
      for (const update of updates) {
        offset = Math.max(offset, update.updateId + 1);
        if (allowlist.isAllowed(update.userId)) {
          lastAuthorizedChatId = update.chatId;
        }
        lastTelegramMessageAtMs = Date.now();
        if (update.text) {
          lastTelegramMessageSummary = `text: ${previewText(update.text, 120)}`;
        } else if (update.voiceFileId) {
          lastTelegramMessageSummary = "voice message";
        } else if (update.attachments.length > 0) {
          const kinds = [...new Set(update.attachments.map((attachment) => attachment.kind))];
          lastTelegramMessageSummary = `attachments: ${kinds.join(",")} (${update.attachments.length})`;
        } else {
          lastTelegramMessageSummary = "non-text message";
        }
        await recordRecentTelegramEntry("user", lastTelegramMessageSummary, lastTelegramMessageAtMs);
        logger.info("telegram_message_received", {
          updateId: update.updateId,
          userId: update.userId,
          chatId: update.chatId,
          textLength: update.text?.length ?? 0,
          textPreview: update.text ? previewText(update.text) : undefined,
          hasVoice: update.voiceFileId !== null,
          attachmentCount: update.attachments.length,
        });

        const command = update.text ? parseTelegramCommand(update.text) : null;
        const sendCommandReply = async (outbound: string): Promise<void> => {
          await sendTelegramTextReply({
            telegram,
            logger,
            update,
            text: outbound,
            command: command?.name,
            onSentText: async (text) => {
              await recordRecentTelegramEntry("assistant", `text: ${previewText(text, 120)}`);
            },
          });
        };
        const executePrompt = async (prompt: string, commandName: string) => {
          const result = await runAgentRequestWithTimeout({
            logger,
            update,
            timeoutMs: MODEL_TIMEOUT_MS,
            command: commandName,
            operation: () =>
              runWithTypingAndTimeout({
                telegram,
                logger,
                chatId: update.chatId,
                updateId: update.updateId,
                userId: update.userId,
                timeoutMs: MODEL_TIMEOUT_MS,
                operation: (signal) => agent.handleMessage(update.userId, prompt, String(update.updateId), signal),
              }),
          });
          if (result.ok) {
            handledMessages += 1;
          } else {
            failedMessages += 1;
          }
          return result;
        };
        const commandHandled = await handleTelegramCommand({
          command,
          update,
          isAllowed: (userId) => allowlist.isAllowed(userId),
          sendCommandReply,
          getStatusReply: () => {
            const uptime = formatDuration(Date.now() - startedAtMs);
            const idle = lastTelegramMessageAtMs === null ? "n/a" : formatDuration(Date.now() - lastTelegramMessageAtMs);
            const lastTelegramAt = lastTelegramMessageAtMs === null ? "n/a" : new Date(lastTelegramMessageAtMs).toISOString();
            const summary = modelBridge.getLastExecutionSummary();
            const lines = [
              "Agent status:",
              `Uptime: ${uptime}`,
              `Handled messages: ${handledMessages}`,
              `Failed messages: ${failedMessages}`,
              `Backend command: ${config.codexCommand}`,
              `Last codex exec: ${summary ? `${summary.status} (${summary.startedAt})` : "n/a"}`,
              `Heartbeat interval: ${Math.floor(HEARTBEAT_INTERVAL_MS / 60000)}m`,
              `Heartbeat running: ${heartbeatInFlight ? "yes" : "no"}`,
              `Heartbeat last run: ${heartbeatLastRunAt ?? "n/a"}`,
              `Heartbeat last result: ${heartbeatLastResult}`,
              `Last telegram message at: ${lastTelegramAt}`,
              `Idle since last telegram message: ${idle}`,
              `Last telegram message summary: ${lastTelegramMessageSummary}`,
            ];
            return lines.join("\n");
          },
          getLastLogReply: () => buildLastLogMessage(modelBridge.getLastExecutionSummary()),
          getMemoryReply: (userId) => {
            const stats = agent.getConversationStats(userId);
            const lines = [
              "Conversation memory:",
              `Entries: ${stats.entries}`,
              `User turns: ${stats.userTurns}`,
              `Assistant turns: ${stats.assistantTurns}`,
              `Has context: ${stats.hasContext ? "yes" : "no"}`,
            ];
            return lines.join("\n");
          },
          getSkillsReply: async () => {
            const discovered = await skills.discover();
            if (discovered.length === 0) {
              return "Nessuna skill disponibile in /data/skills o /data/.codex/skills.";
            }
            const lines = [
              "Skills disponibili:",
              ...discovered.map((skill, index) => {
                const description = skill.description.replaceAll(/\s+/g, " ").trim();
                return `${index + 1}. ${skill.id} - ${description}`;
              }),
            ];
            return lines.join("\n");
          },
          getLastPrompt: (userId) => lastPromptByUser.get(userId),
          setLastPrompt: (userId, prompt) => {
            lastPromptByUser.set(userId, prompt);
          },
          clearConversation: (userId) => {
            agent.clearConversation(userId);
            logger.info("conversation_cleared", {
              updateId: update.updateId,
              userId,
              chatId: update.chatId,
            });
          },
          clearRuntimeState: async () => {
            recentTelegramMessages.splice(0, recentTelegramMessages.length);
            lastTelegramMessageAtMs = null;
            lastTelegramMessageSummary = "n/a";
            try {
              await clearRecentTelegramMessages(config.dataRoot);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn("telegram_history_clear_failed", { message });
            }
            logger.info("runtime_state_cleared", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
            });
          },
          executePrompt,
          dispatchAssistantReply: async (reply, options) => {
            await dispatchAssistantReply({
              telegram,
              logger,
              tts,
              rootRealPath: dataRootRealPath,
              update,
              rawReply: reply,
              noTtsPrefix: options.noTtsPrefix,
              forceAudio: options.forceAudio,
              logContext: { command: options.command },
              onTextSent: async (text) => {
                await recordRecentTelegramEntry("assistant", text);
              },
            });
          },
          sendAudioFile: async (inputPath: string) => {
            const { realPath, relativePath } = await resolveAudioPathForUpload(dataRootRealPath, inputPath);
            const fileBlob = Bun.file(realPath);
            await telegram.sendAudio(update.chatId, fileBlob, path.basename(relativePath), `File: ${relativePath}`);
            logger.info("telegram_audio_sent", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              filePath: relativePath,
            });
            return relativePath;
          },
          runHeartbeatNow: async () => {
            const outcome = await runScheduledHeartbeat("manual");
            if (outcome.status === "skipped_inflight") {
              return "Heartbeat gia in esecuzione.";
            }
            if (outcome.status === "ok") {
              return "Heartbeat completato: HEARTBEAT_OK (nessun alert).";
            }
            if (outcome.status === "ok_notice_sent") {
              return "Heartbeat completato: HEARTBEAT_OK (messaggio HEARTBEAT.md inviato).";
            }
            if (outcome.status === "alert_sent") {
              return "Heartbeat completato: alert inviato su Telegram.";
            }
            return "Heartbeat completato: alert necessario ma nessuna chat autorizzata disponibile.";
          },
        });
        if (commandHandled) {
          continue;
        }

        let reply: string;
        let promptText = update.text;

        if (!promptText && (update.voiceFileId || update.attachments.length > 0) && !allowlist.isAllowed(update.userId)) {
          await sendTelegramTextReply({
            telegram,
            logger,
            update,
            text: "Unauthorized user.",
            onSentText: async (text) => {
              await recordRecentTelegramEntry("assistant", `text: ${previewText(text, 120)}`);
            },
          });
          continue;
        }

        const result = await runAgentRequestWithTimeout({
          logger,
          update,
          timeoutMs: MODEL_TIMEOUT_MS,
          operation: () =>
            runWithTypingAndTimeout({
              telegram,
              logger,
              chatId: update.chatId,
              updateId: update.updateId,
              userId: update.userId,
              timeoutMs: MODEL_TIMEOUT_MS,
              operation: async (signal) => {
                const processedAttachments: ProcessedAttachment[] = [];
                for (let index = 0; index < update.attachments.length; index += 1) {
                  const attachment = update.attachments[index];
                  if (!attachment) {
                    continue;
                  }
                  try {
                    const download = await telegram.downloadFileById(attachment.fileId);
                    const processed = await attachmentService.processIncoming({
                      attachment,
                      download,
                      updateId: update.updateId,
                      sequence: index,
                    });
                    processedAttachments.push(processed);
                    logger.info("telegram_attachment_saved", {
                      updateId: update.updateId,
                      userId: update.userId,
                      chatId: update.chatId,
                      kind: processed.kind,
                      relativePath: processed.relativePath,
                      sizeBytes: processed.sizeBytes,
                      inlineText: processed.inlineText !== null,
                    });
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn("telegram_attachment_processing_failed", {
                      updateId: update.updateId,
                      userId: update.userId,
                      chatId: update.chatId,
                      attachmentKind: attachment.kind,
                      message,
                    });
                  }
                }

                const attachmentContext = attachmentService.buildPromptContext(processedAttachments);

                if (!promptText && update.voiceFileId) {
                  const audio = await telegram.downloadFileById(update.voiceFileId);
                  promptText = await transcriber.transcribe(audio.fileBlob, audio.fileName, audio.mimeType ?? update.voiceMimeType);
                  logger.info("telegram_voice_transcribed", {
                    updateId: update.updateId,
                    userId: update.userId,
                    chatId: update.chatId,
                    transcriptionLength: promptText.length,
                    transcriptionPreview: previewText(promptText),
                  });
                }

                if (attachmentContext) {
                  const basePrompt = promptText ?? "Analizza gli allegati salvati e proponi i prossimi passi.";
                  promptText = [attachmentContext, "", "User message:", basePrompt].join("\n");
                }

                if (!promptText) {
                  return update.attachments.length > 0
                    ? "Non riesco a processare l'allegato inviato."
                    : "Posso gestire solo messaggi testuali o vocali.";
                }

                const modelReply = await agent.handleMessage(update.userId, promptText, String(update.updateId), signal);
                lastPromptByUser.set(update.userId, promptText);
                return modelReply;
              },
            }),
        });
        if (result.ok) {
          handledMessages += 1;
        } else {
          failedMessages += 1;
        }
        reply = result.reply;

        await dispatchAssistantReply({
          telegram,
          logger,
          tts,
          rootRealPath: dataRootRealPath,
          update,
          rawReply: reply,
          onTextSent: async (text) => {
            await recordRecentTelegramEntry("assistant", text);
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("telegram_poll_failed", { message });
      await Bun.sleep(2000);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
