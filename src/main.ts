import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { AttachmentService, type ProcessedAttachment } from "./attachments/attachment-service";
import { TelegramAllowlist } from "./auth/allowlist";
import { AmbrogioAgentService } from "./app/ambrogio-agent-service";
import { loadConfig } from "./config/env";
import { Logger } from "./logging/audit";
import { correlationFields } from "./logging/correlation";
import { ExecBridge } from "./model/exec-bridge";
import { ElevenLabsTts } from "./model/elevenlabs-tts";
import { OpenAiTranscriber } from "./model/openai-transcriber";
import { handleTelegramCommand } from "./runtime/command-handlers";
import { createHeartbeatRunner } from "./runtime/heartbeat-runner";
import { parseQuietHours } from "./runtime/heartbeat-quiet-hours";
import { HEARTBEAT_FILE_NAME, HEARTBEAT_INTERVAL_MS } from "./runtime/heartbeat";
import { sendTelegramFormattedMessage, sendTelegramTextReply } from "./runtime/message-sender";
import { dispatchAssistantReply, resolveAudioPathForUpload } from "./runtime/reply-dispatcher";
import { StateStore } from "./runtime/state-store";
import { startTaskRpcServer } from "./runtime/task-rpc-server";
import { startTelegramUpdateLoop } from "./runtime/telegram-update-loop";
import { parseOpenTodoItems } from "./runtime/todo-snapshot";
import { bootstrapProjectSkills } from "./skills/bootstrap";
import { SkillDiscovery } from "./skills/discovery";
import { TelegramAdapter } from "./telegram/adapter";
import { parseTelegramCommand } from "./telegram/commands";

const TYPING_INTERVAL_MS = 4_000;
const MODEL_TIMEOUT_MS = 60_000;
const MAX_TELEGRAM_PHOTO_BYTES = 10_000_000;
const MAX_TELEGRAM_AUDIO_BYTES = 49_000_000;
const MAX_TELEGRAM_DOCUMENT_BYTES = 49_000_000;
const MAX_INLINE_ATTACHMENT_TEXT_BYTES = 64 * 1024;
const GENERATED_SCANNED_PDFS_RELATIVE_DIR = "generated/scanned-pdfs";
const MAX_RECENT_TELEGRAM_MESSAGES = 50;
const DELAYED_TASK_POLL_INTERVAL_MS = 10_000;
type PendingBackgroundTask = ReturnType<StateStore["getPendingBackgroundTasks"]>[number];
type ScheduledTask = ReturnType<StateStore["getDueScheduledTasks"]>[number];

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

function startOperationWithTyping<T>(params: {
  telegram: TelegramAdapter;
  logger: Logger;
  chatId: number;
  updateId: number;
  userId: number;
  operation: (signal: AbortSignal) => Promise<T>;
}): {
  operationPromise: Promise<T>;
  stopTyping: () => Promise<void>;
} {
  const typingController = new AbortController();
  const operationController = new AbortController();
  const typingLoop = startTypingLoop(
    params.telegram,
    params.logger,
    params.chatId,
    params.updateId,
    params.userId,
    typingController.signal,
  );
  let typingStopped = false;

  const stopTyping = async (): Promise<void> => {
    if (typingStopped) {
      return;
    }
    typingStopped = true;
    typingController.abort();
    await typingLoop;
  };

  const operationPromise = params.operation(operationController.signal).finally(async () => {
    await stopTyping();
  });

  return {
    operationPromise,
    stopTyping,
  };
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
  const codexSkillsRoot = `${codexHome}/skills`;
  const bootstrapResult = await bootstrapProjectSkills({
    sourceRoot: projectSkillsRoot,
    destinationRoot: codexSkillsRoot,
  });
  if (bootstrapResult.copied.length > 0 || bootstrapResult.updated.length > 0 || bootstrapResult.skipped.length > 0) {
    logger.info("skills_bootstrap_completed", {
      sourceRoot: projectSkillsRoot,
      destinationRoot: codexSkillsRoot,
      copiedCount: bootstrapResult.copied.length,
      updatedCount: bootstrapResult.updated.length,
      skippedCount: bootstrapResult.skipped.length,
      copied: bootstrapResult.copied,
      updated: bootstrapResult.updated,
      skipped: bootstrapResult.skipped,
    });
  }
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
  const stateStore = await StateStore.open(config.dataRoot);
  logger.info("state_store_opened", { dbPath: path.join(config.dataRoot, "runtime", "state.db") });

  const ambrogioAgent = new AmbrogioAgentService({
    allowlist,
    modelBridge,
    logger,
    conversationStore: stateStore,
  });

  logger.info("ambrogio_agent_started", {
    dataRoot: config.dataRoot,
    codexCommand: config.codexCommand,
  });

  let offset = 0;
  const startedAtMs = Date.now();
  let handledMessages = 0;
  let failedMessages = 0;
  let lastTelegramMessageAtMs: number | null = null;
  let lastTelegramMessageSummary = "n/a";
  const recentTelegramMessages = stateStore
    .getRecentMessages(MAX_RECENT_TELEGRAM_MESSAGES)
    .map((entry) => `${entry.createdAt} - ${entry.role}: ${entry.summary}`);
  logger.debug("state_store_recent_messages_loaded", {
    count: recentTelegramMessages.length,
    limit: MAX_RECENT_TELEGRAM_MESSAGES,
  });
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
  const quietHours = parseQuietHours(config.heartbeatQuietHours ?? "22:00-06:00");
  let heartbeatStateResolver = () => ({
    heartbeatInFlight: false,
    heartbeatLastRunAt: stateStore.getRuntimeValue("heartbeat_last_run_at"),
    heartbeatLastResult: stateStore.getRuntimeValue("heartbeat_last_result") ?? "never",
  });

  const pushRecentTelegramMessage = (summary: string): void => {
    recentTelegramMessages.push(summary);
    const maxEntries = MAX_RECENT_TELEGRAM_MESSAGES;
    if (recentTelegramMessages.length > maxEntries) {
      recentTelegramMessages.splice(0, recentTelegramMessages.length - maxEntries);
    }
  };

  const recordRecentTelegramEntry = async (role: "user" | "assistant", summary: string, atMs?: number): Promise<void> => {
    const timestamp = new Date(atMs ?? Date.now()).toISOString();
    const normalized = summary.trim();
    pushRecentTelegramMessage(`${timestamp} - ${role}: ${normalized}`);
    try {
      stateStore.appendRecentMessage(role, normalized, timestamp, MAX_RECENT_TELEGRAM_MESSAGES);
      logger.debug("state_store_recent_message_written", {
        role,
        createdAt: timestamp,
        limit: MAX_RECENT_TELEGRAM_MESSAGES,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("telegram_history_persist_failed", { message });
    }
  };

  const backgroundDeliveryInFlight = new Set<string>();

  const deliverBackgroundTask = async (task: PendingBackgroundTask, trigger: "completion" | "heartbeat"): Promise<boolean> => {
    if (!task.deliveryText) {
      logger.warn("background_task_missing_delivery_text", {
        taskId: task.taskId,
        status: task.status,
        trigger,
      });
      return false;
    }
    if (backgroundDeliveryInFlight.has(task.taskId)) {
      return false;
    }

    backgroundDeliveryInFlight.add(task.taskId);
    try {
      await dispatchAssistantReply({
        telegram,
        logger,
        tts,
        rootRealPath: dataRootRealPath,
        update: {
          updateId: task.updateId,
          userId: task.userId,
          chatId: task.chatId,
        },
        rawReply: task.deliveryText,
        logContext: { command: task.command ?? "background" },
        onTextSent: async (text) => {
          await recordRecentTelegramEntry(
            "assistant",
            `background task ${task.taskId}: ${previewText(text, 120)}`,
          );
        },
      });
      stateStore.markBackgroundTaskDelivered(task.taskId);
      logger.info("background_task_delivered", {
        taskId: task.taskId,
        trigger,
        status: task.status,
        chatId: task.chatId,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("background_task_delivery_failed", {
        taskId: task.taskId,
        trigger,
        status: task.status,
        chatId: task.chatId,
        message,
      });
      return false;
    } finally {
      backgroundDeliveryInFlight.delete(task.taskId);
    }
  };

  const flushPendingBackgroundTasks = async (): Promise<void> => {
    const pending = stateStore.getPendingBackgroundTasks(20);
    if (pending.length === 0) {
      return;
    }
    for (const task of pending) {
      await deliverBackgroundTask(task, "heartbeat");
    }
  };

  const executeScheduledTask = async (task: ScheduledTask): Promise<void> => {
    if (!stateStore.claimScheduledTask(task.taskId)) {
      return;
    }
    const prompt = task.payloadPrompt ?? task.requestPreview;
    try {
      const reply = await ambrogioAgent.handleMessage(task.userId, prompt, `delayed-${task.taskId}`);
      const marked = stateStore.markBackgroundTaskCompleted(task.taskId, reply);
      if (!marked) {
        logger.info("scheduled_task_result_dropped", { taskId: task.taskId, reason: "status_changed" });
        return;
      }
      const refreshed = stateStore.getBackgroundTask(task.taskId);
      if (!refreshed) {
        return;
      }
      await deliverBackgroundTask(refreshed, "completion");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureReply = `Task schedulato fallito (${task.taskId}): ${message}`;
      const marked = stateStore.markBackgroundTaskFailed(task.taskId, message, failureReply);
      if (!marked) {
        logger.info("scheduled_task_failure_dropped", { taskId: task.taskId, reason: "status_changed" });
        return;
      }
      const refreshed = stateStore.getBackgroundTask(task.taskId);
      if (!refreshed) {
        return;
      }
      await deliverBackgroundTask(refreshed, "completion");
    }
  };

  const retryTaskDelivery = async (taskId: string): Promise<string> => {
    const normalized = taskId.trim();
    if (!normalized) {
      return "Task ID mancante.";
    }
    const task = stateStore.getBackgroundTask(normalized);
    if (!task) {
      return `Task non trovato: ${normalized}`;
    }
    if (task.status === "completed_delivered" || task.status === "failed_delivered") {
      return `Task ${normalized} gia consegnato.`;
    }
    if (task.status === "canceled") {
      return `Task ${normalized} e cancellato.`;
    }
    if (task.status === "scheduled") {
      return `Task ${normalized} e schedulato; verra eseguito a ${task.runAt ?? "orario non disponibile"}.`;
    }
    if (task.status === "running") {
      return `Task ${normalized} ancora in esecuzione.`;
    }
    const delivered = await deliverBackgroundTask(task, "completion");
    return delivered
      ? `Task ${normalized} consegnato con successo.`
      : `Task ${normalized} non consegnato; verra ritentato automaticamente all'heartbeat.`;
  };

  const runDueScheduledTasks = async (): Promise<void> => {
    const due = stateStore.getDueScheduledTasks(10);
    for (const task of due) {
      void executeScheduledTask(task);
    }
  };

  const runHeartbeatPromptWithTimeout = async (prompt: string, requestId: string): Promise<string> => {
    const controller = new AbortController();
    const result = await withTimeout(
      (async () => {
        return modelBridge.respond({
          requestId,
          message: prompt,
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

  const readTodoSnapshot = async (): Promise<string[]> => {
    const todoPath = path.join(config.dataRoot, "TODO.md");
    try {
      const content = await readFile(todoPath, "utf8");
      const openItems = parseOpenTodoItems(content, 10);
      return openItems.length > 0
        ? openItems.map((line, index) => `${index + 1}. ${line}`)
        : ["none"];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("todo_snapshot_read_failed", { todoPath, message });
      return ["unavailable"];
    }
  };

  const getRuntimeStatus = async (): Promise<Record<string, unknown>> => {
    const heartbeatState = heartbeatStateResolver();
    const nowMs = Date.now();
    const localNow = new Date(nowMs);
    const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const localDateTime = new Intl.DateTimeFormat("it-IT", {
      timeZone: localTimezone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(localNow);
    const summary = modelBridge.getLastExecutionSummary();
    const idle = lastTelegramMessageAtMs === null ? "n/a" : formatDuration(nowMs - lastTelegramMessageAtMs);
    const lastTelegramAt = lastTelegramMessageAtMs === null ? "n/a" : new Date(lastTelegramMessageAtMs).toISOString();
    const codexSummary = summary
      ? `${summary.status} (${summary.startedAt}${typeof summary.durationMs === "number" ? `, ${formatDuration(summary.durationMs)}` : ""})`
      : "n/a";
    const recentMessages = recentTelegramMessages.length === 0
      ? ["none"]
      : recentTelegramMessages.slice(-5);
    const conversationContextEntries = stateStore
      .getConversation(config.telegramAllowedUserId, 8)
      .map((entry) => `${entry.role}: ${entry.text}`);
    const conversationContext = conversationContextEntries.length > 0 ? conversationContextEntries : ["none"];
    const todoPath = path.join(config.dataRoot, "TODO.md");
    const todoOpenItems = await readTodoSnapshot();

    return {
      now: new Date(nowMs).toISOString(),
      localDateTime,
      localTimezone,
      dataRoot: config.dataRoot,
      todoPath,
      uptime: formatDuration(nowMs - startedAtMs),
      handledMessages,
      failedMessages,
      backgroundTasksPendingDelivery: stateStore.countPendingBackgroundTasks(),
      scheduledTasks: stateStore.countScheduledTasks(),
      heartbeat: {
        inFlight: heartbeatState.heartbeatInFlight,
        lastRunAt: heartbeatState.heartbeatLastRunAt ?? null,
        lastResult: heartbeatState.heartbeatLastResult,
        quietHours: heartbeatRunner.getQuietHoursRaw() ?? "disabled",
        inQuietHours: heartbeatRunner.isInQuietHours(),
      },
      lastTelegramMessage: {
        at: lastTelegramAt,
        idle,
        summary: lastTelegramMessageSummary,
      },
      recentMessages,
      conversationContext,
      todoSnapshot: todoOpenItems,
      lastCodexExec: codexSummary,
    };
  };

  const heartbeatRunner = createHeartbeatRunner({
    logger,
    stateStore,
    runHeartbeatPromptWithTimeout,
    quietHours,
  });
  heartbeatStateResolver = heartbeatRunner.getHeartbeatState;

  const rpcSocketPath = (process.env.AMBROGIO_SOCKET_PATH ?? "").trim() || "/tmp/ambrogio-agent.sock";
  await startTaskRpcServer({
    socketPath: rpcSocketPath,
    stateStore,
    retryTaskDelivery: async (taskId) => {
      return retryTaskDelivery(taskId);
    },
    getStatus: getRuntimeStatus,
    telegram: {
      getAuthorizedChatId: () => config.telegramAllowedUserId,
      sendMessage: async (chatId, text) => {
        await telegram.sendMessage(chatId, text);
      },
      recordMessage: async (role, summary) => {
        await recordRecentTelegramEntry(role, summary);
      },
    },
    media: {
      dataRootRealPath,
      getAuthorizedChatId: () => config.telegramAllowedUserId,
      maxPhotoBytes: MAX_TELEGRAM_PHOTO_BYTES,
      maxAudioBytes: MAX_TELEGRAM_AUDIO_BYTES,
      maxDocumentBytes: MAX_TELEGRAM_DOCUMENT_BYTES,
      sendPhoto: async (chatId, photo, fileName, caption) => await telegram.sendPhoto(chatId, photo, fileName, caption),
      sendAudio: async (chatId, audio, fileName, caption) => await telegram.sendAudio(chatId, audio, fileName, caption),
      sendDocument: async (chatId, document, fileName, caption) => await telegram.sendDocument(chatId, document, fileName, caption),
    },
  });
  logger.info("task_rpc_server_started", { socketPath: rpcSocketPath });

  setInterval(() => {
    void (async () => {
      await flushPendingBackgroundTasks();
      await heartbeatRunner.runScheduledHeartbeat("timer");
    })();
  }, HEARTBEAT_INTERVAL_MS);
  setInterval(() => {
    void runDueScheduledTasks();
  }, DELAYED_TASK_POLL_INTERVAL_MS);
  void flushPendingBackgroundTasks();
  void runDueScheduledTasks();
  logger.info("heartbeat_loop_started", {
    intervalMs: HEARTBEAT_INTERVAL_MS,
    filePath: `${config.dataRoot}/${HEARTBEAT_FILE_NAME}`,
  });

  await startTelegramUpdateLoop({
    telegram,
    pollTimeoutSeconds: config.telegramPollTimeoutSeconds,
    getOffset: () => offset,
    setOffset: (nextOffset) => {
      offset = nextOffset;
    },
    processUpdate: async (update) => {
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
        const runOperationWithSoftTimeout = async (params: {
          commandName?: string;
          requestPreview: string;
          operation: (signal: AbortSignal) => Promise<string>;
        }): Promise<{ reply: string; ok: boolean }> => {
          const tracked = startOperationWithTyping({
            telegram,
            logger,
            chatId: update.chatId,
            updateId: update.updateId,
            userId: update.userId,
            operation: params.operation,
          });

          let timeout: ReturnType<typeof setTimeout> | undefined;
          const settledPromise = tracked.operationPromise
            .then((reply) => ({ kind: "ok" as const, reply }))
            .catch((error) => ({ kind: "error" as const, error }));
          const first = await Promise.race([
            settledPromise,
            new Promise<{ kind: "timeout" }>((resolve) => {
              timeout = setTimeout(() => resolve({ kind: "timeout" }), MODEL_TIMEOUT_MS);
            }),
          ]);

          if (timeout) {
            clearTimeout(timeout);
          }

          if (first.kind === "ok") {
            return { reply: first.reply, ok: true };
          }

          if (first.kind === "error") {
            const message = first.error instanceof Error ? first.error.message : "Unknown error";
            logger.error("message_processing_failed", {
              message,
              ...correlationFields({
                updateId: update.updateId,
                userId: update.userId,
                chatId: update.chatId,
                command: params.commandName,
              }),
            });
            return { reply: `Error: ${message}`, ok: false };
          }

          await tracked.stopTyping();
          const taskId = `bg-${update.updateId}-${Date.now()}`;
          logger.error("request_timed_out", {
            ...correlationFields({
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              command: params.commandName,
            }),
            timeoutMs: MODEL_TIMEOUT_MS,
            taskId,
          });
          stateStore.createBackgroundTask({
            taskId,
            updateId: update.updateId,
            userId: update.userId,
            chatId: update.chatId,
            command: params.commandName,
            requestPreview: previewText(params.requestPreview, 240),
          });

          void tracked.operationPromise
            .then(async (reply) => {
              const marked = stateStore.markBackgroundTaskCompleted(taskId, reply);
              if (!marked) {
                logger.info("background_task_result_dropped", { taskId, reason: "status_changed" });
                return;
              }
              const task = stateStore.getBackgroundTask(taskId);
              if (!task) {
                logger.warn("background_task_missing_after_complete", { taskId });
                return;
              }
              await deliverBackgroundTask(task, "completion");
            })
            .catch(async (error) => {
              const message = error instanceof Error ? error.message : String(error);
              const failureReply = `Task in background fallito (ID: ${taskId}): ${message}`;
              const marked = stateStore.markBackgroundTaskFailed(taskId, message, failureReply);
              if (!marked) {
                logger.info("background_task_failure_dropped", { taskId, reason: "status_changed" });
                return;
              }
              const task = stateStore.getBackgroundTask(taskId);
              if (!task) {
                logger.warn("background_task_missing_after_failure", { taskId, message });
                return;
              }
              await deliverBackgroundTask(task, "completion");
            });

          return {
            reply:
              `Operazione lunga: continuo in background e ti aggiorno appena finisce.\n` +
              `Task ID: ${taskId}`,
            ok: false,
          };
        };

        const executePrompt = async (prompt: string, commandName: string) => {
          const result = await runOperationWithSoftTimeout({
            commandName,
            requestPreview: prompt,
            operation: (signal) => ambrogioAgent.handleMessage(update.userId, prompt, String(update.updateId), signal),
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
            const heartbeatState = heartbeatRunner.getHeartbeatState();
            const uptime = formatDuration(Date.now() - startedAtMs);
            const idle = lastTelegramMessageAtMs === null ? "n/a" : formatDuration(Date.now() - lastTelegramMessageAtMs);
            const lastTelegramAt = lastTelegramMessageAtMs === null ? "n/a" : new Date(lastTelegramMessageAtMs).toISOString();
            const summary = modelBridge.getLastExecutionSummary();
            const lines = [
              "Ambrogio-agent status:",
              `Uptime: ${uptime}`,
              `Handled messages: ${handledMessages}`,
              `Failed messages: ${failedMessages}`,
              `Background tasks pending delivery: ${stateStore.countPendingBackgroundTasks()}`,
              `Delayed tasks scheduled: ${stateStore.countScheduledTasks()}`,
              `Backend command: ${config.codexCommand}`,
              `Last codex exec: ${summary ? `${summary.status} (${summary.startedAt})` : "n/a"}`,
              `Heartbeat interval: ${Math.floor(HEARTBEAT_INTERVAL_MS / 60000)}m`,
              `Heartbeat running: ${heartbeatState.heartbeatInFlight ? "yes" : "no"}`,
              `Heartbeat last run: ${heartbeatState.heartbeatLastRunAt ?? "n/a"}`,
              `Heartbeat last result: ${heartbeatState.heartbeatLastResult}`,
              `Heartbeat quiet hours: ${heartbeatRunner.getQuietHoursRaw() ?? "disabled"}`,
              `Heartbeat now in quiet hours: ${heartbeatRunner.isInQuietHours() ? "yes" : "no"}`,
              `Last telegram message at: ${lastTelegramAt}`,
              `Idle since last telegram message: ${idle}`,
              `Last telegram message summary: ${lastTelegramMessageSummary}`,
            ];
            return lines.join("\n");
          },
          getLastLogReply: () => buildLastLogMessage(modelBridge.getLastExecutionSummary()),
          getMemoryReply: (userId) => {
            const stats = ambrogioAgent.getConversationStats(userId);
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
            const skills = new SkillDiscovery(codexSkillsRoot);
            const discovered = await skills.discover();
            if (discovered.length === 0) {
              return "Nessuna skill disponibile in /data/.codex/skills.";
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
            ambrogioAgent.clearConversation(userId);
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
            heartbeatRunner.resetHeartbeatState();
            try {
              stateStore.clearRecentMessages();
              logger.debug("state_store_recent_messages_cleared");
              stateStore.clearRuntimeValues([
                "heartbeat_last_run_at",
                "heartbeat_last_result",
                "heartbeat_last_alert_fingerprint",
                "heartbeat_last_alert_at",
              ]);
              stateStore.clearBackgroundTasks();
              logger.debug("state_store_runtime_values_cleared", {
                keys: [
                  "heartbeat_last_run_at",
                  "heartbeat_last_result",
                  "heartbeat_last_alert_fingerprint",
                  "heartbeat_last_alert_at",
                ],
              });
              logger.debug("state_store_background_tasks_cleared");
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
            const { realPath, relativePath } = await resolveAudioPathForUpload(
              dataRootRealPath,
              inputPath,
              MAX_TELEGRAM_AUDIO_BYTES,
            );
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
            await flushPendingBackgroundTasks();
            const outcome = await heartbeatRunner.runScheduledHeartbeat("manual");
            if (outcome.status === "skipped_inflight") {
              return "Heartbeat gia in esecuzione.";
            }
            if (outcome.status === "completed") {
              return "Heartbeat completato. La skill ha gestito autonomamente eventuali notifiche.";
            }
            if (outcome.status === "error") {
              return "Heartbeat fallito con errore. Controlla i log per dettagli.";
            }
            // skipped_quiet_hours non dovrebbe accadere con trigger "manual"
            return "Heartbeat skipped durante quiet hours.";
          },

        });
        if (commandHandled) {
          return;
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
          return;
        }

        const result = await runOperationWithSoftTimeout({
          requestPreview: promptText ?? (update.voiceFileId ? "voice message" : "attachment workflow"),
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

            const modelReply = await ambrogioAgent.handleMessage(update.userId, promptText, String(update.updateId), signal);
            lastPromptByUser.set(update.userId, promptText);
            return modelReply;
          },
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
    },
    onPollError: async (error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("telegram_poll_failed", { message });
      await Bun.sleep(2000);
    },
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
