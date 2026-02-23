import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { AttachmentService, type ProcessedAttachment } from "./attachments/attachment-service";
import { TelegramAllowlist } from "./auth/allowlist";
import { AmbrogioAgentService } from "./app/ambrogio-agent-service";
import { loadConfig } from "./config/env";
import { Logger } from "./logging/audit";
import { correlationFields } from "./logging/correlation";
import { createModelBridge } from "./model/bridge-factory";
import type { ModelExecutionSummary } from "./model/types";
import { ElevenLabsTts } from "./model/elevenlabs-tts";
import { OpenAiTranscriber } from "./model/openai-transcriber";
import { handleTelegramCommand } from "./runtime/command-handlers";
import { createHeartbeatRunner } from "./runtime/heartbeat-runner";
import { parseQuietHours } from "./runtime/heartbeat-quiet-hours";
import { HEARTBEAT_FILE_NAME, HEARTBEAT_INTERVAL_MS } from "./runtime/heartbeat";
import { sendTelegramTextReply } from "./runtime/message-sender";
import { buildActiveJobsFastReply, isActiveJobsListQuery } from "./runtime/active-jobs-fast-path";
import { dispatchAssistantReply, resolveAudioPathForUpload } from "./runtime/reply-dispatcher";
import {
  buildScheduledJobExecutionPrompt,
  shouldDisableImplicitScheduledDelivery,
  shouldSuppressScheduledJobDelivery,
} from "./runtime/scheduled-job-headless";
import { StateStore } from "./runtime/state-store";
import { startJobRpcServer } from "./runtime/job-rpc-server";
import { createTelegramInputBuffer, type BufferedTelegramInput } from "./runtime/telegram-input-buffer";
import { startTelegramUpdateLoop } from "./runtime/telegram-update-loop";
import { parseOpenTodoItems } from "./runtime/todo-snapshot";
import { createToolCallTelegramNotifier } from "./runtime/tool-call-updates";
import { bootstrapProjectSkills } from "./skills/bootstrap";
import { SkillDiscovery } from "./skills/discovery";
import { bootstrapAgentsFile } from "./agents/bootstrap";
import { TelegramAdapter, type TelegramMessage } from "./telegram/adapter";
import { parseTelegramCommand } from "./telegram/commands";
import { createDashboardSnapshotService } from "./dashboard/snapshot-service";
import { startDashboardHttpServer } from "./dashboard/http-server";

const TYPING_INTERVAL_MS = 4_000;
const MODEL_TIMEOUT_MS = 60_000;
const MAX_TELEGRAM_PHOTO_BYTES = 10_000_000;
const MAX_TELEGRAM_AUDIO_BYTES = 49_000_000;
const MAX_TELEGRAM_DOCUMENT_BYTES = 49_000_000;
const MAX_INLINE_ATTACHMENT_TEXT_BYTES = 64 * 1024;
const GENERATED_SCANNED_PDFS_RELATIVE_DIR = "generated/scanned-pdfs";
const MAX_RECENT_TELEGRAM_MESSAGES = 1000;
const DELAYED_JOB_POLL_INTERVAL_MS = 10_000;
type PendingBackgroundJob = ReturnType<StateStore["getPendingBackgroundJobs"]>[number];
type ScheduledJob = ReturnType<StateStore["getDueScheduledJobs"]>[number];

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

function buildLastLogMessage(summary: ModelExecutionSummary | null | undefined): string {
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
  const claudeHome = Bun.env.CLAUDE_HOME ?? `${config.dataRoot}/.claude`;
  const homeDir = Bun.env.HOME ?? config.dataRoot;

  await mkdir(homeDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(claudeHome, { recursive: true });
  await mkdir(path.join(config.dataRoot, GENERATED_SCANNED_PDFS_RELATIVE_DIR), { recursive: true });

  const telegram = new TelegramAdapter(config.telegramBotToken);
  const allowlist = new TelegramAllowlist(config.telegramAllowedUserId);
  const dataRootRealPath = await realpath(config.dataRoot);

  const projectSkillsRoot = Bun.env.PROJECT_SKILLS_ROOT ?? path.resolve(import.meta.dir, "..", "skills");
  const codexSkillsRoot = `${codexHome}/skills`;
  const claudeSkillsRoot = `${claudeHome}/skills`;

  // Sync to both directories to support backend switching
  const codexBootstrapResult = await bootstrapProjectSkills({
    sourceRoot: projectSkillsRoot,
    destinationRoot: codexSkillsRoot,
  });
  const claudeBootstrapResult = await bootstrapProjectSkills({
    sourceRoot: projectSkillsRoot,
    destinationRoot: claudeSkillsRoot,
  });

  const bootstrapResult = {
    copied: [...codexBootstrapResult.copied, ...claudeBootstrapResult.copied],
    updated: [...codexBootstrapResult.updated, ...claudeBootstrapResult.updated],
    skipped: [...codexBootstrapResult.skipped, ...claudeBootstrapResult.skipped],
  };

  if (bootstrapResult.copied.length > 0 || bootstrapResult.updated.length > 0 || bootstrapResult.skipped.length > 0) {
    logger.info("skills_bootstrap_completed", {
      sourceRoot: projectSkillsRoot,
      destinationRoots: [codexSkillsRoot, claudeSkillsRoot],
      copiedCount: bootstrapResult.copied.length,
      updatedCount: bootstrapResult.updated.length,
      skippedCount: bootstrapResult.skipped.length,
      copied: bootstrapResult.copied,
      updated: bootstrapResult.updated,
      skipped: bootstrapResult.skipped,
    });
  }

  const projectAgentsFile = Bun.env.PROJECT_AGENTS_FILE ?? path.resolve(import.meta.dir, "..", "agents", "AGENTS.md");
  const dataAgentsFile = path.join(config.dataRoot, "AGENTS.md");
  const agentsBootstrapResult = await bootstrapAgentsFile({
    sourceFile: projectAgentsFile,
    destinationFile: dataAgentsFile,
  });
  if (agentsBootstrapResult.copied || agentsBootstrapResult.updated || agentsBootstrapResult.skipped) {
    logger.info("agents_bootstrap_completed", {
      sourceFile: projectAgentsFile,
      destinationFile: dataAgentsFile,
      copied: agentsBootstrapResult.copied,
      updated: agentsBootstrapResult.updated,
      skipped: agentsBootstrapResult.skipped,
    });
  }

  // Create CLAUDE.md symlink for Claude Code CLI
  const claudeMdPath = path.join(config.dataRoot, "CLAUDE.md");
  try {
    await Bun.write(claudeMdPath, Bun.file(dataAgentsFile));
    logger.debug("claude_md_synced", { source: dataAgentsFile, destination: claudeMdPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("claude_md_sync_failed", { message });
  }
  const modelBridge = createModelBridge(
    config.backend,
    {
      codexCommand: config.codexCommand,
      codexArgs: config.codexArgs,
      claudeCommand: config.claudeCommand,
      claudeArgs: config.claudeArgs,
      options: {
        cwd: config.dataRoot,
        env: {
          CODEX_HOME: codexHome,
          CLAUDE_HOME: claudeHome,
          HOME: homeDir,
          NO_COLOR: Bun.env.NO_COLOR ?? "1",
        },
      },
    },
    logger,
  );
  const transcriber = new OpenAiTranscriber(config.openaiApiKey);
  const attachmentService = new AttachmentService(config.dataRoot, MAX_INLINE_ATTACHMENT_TEXT_BYTES);
  const tts = config.elevenLabsApiKey ? new ElevenLabsTts(config.elevenLabsApiKey) : null;
  const stateStore = await StateStore.open(config.dataRoot);
  logger.info("state_store_opened", { dbPath: path.join(config.dataRoot, "runtime", "state.db") });
  const recoveredOrphanJobs = stateStore.recoverOrphanRunningScheduledJobs();
  if (recoveredOrphanJobs > 0) {
    logger.warn("scheduled_orphan_jobs_recovered", { recoveredJobs: recoveredOrphanJobs });
  }
  const normalizedHeadlessPrompts = stateStore.normalizeExistingScheduledHeadlessPrompts();
  if (normalizedHeadlessPrompts > 0) {
    logger.info("scheduled_headless_prompts_normalized", { updatedJobs: normalizedHeadlessPrompts });
  }
  const dashboardSnapshotService = createDashboardSnapshotService({
    stateStore,
    dataRoot: config.dataRoot,
  });

  if (config.dashboardEnabled) {
    startDashboardHttpServer({
      host: config.dashboardHost,
      port: config.dashboardPort,
      logger,
      getSnapshot: dashboardSnapshotService.getSnapshot,
    });
  } else {
    logger.info("dashboard_http_disabled");
  }

  const ambrogioAgent = new AmbrogioAgentService({
    allowlist,
    modelBridge,
    logger,
    conversationStore: stateStore,
    memoryStore: stateStore,
  });

  logger.info("ambrogio_agent_started", {
    dataRoot: config.dataRoot,
    backend: config.backend,
    command: config.backend === "codex" ? config.codexCommand : config.claudeCommand,
    args: config.backend === "codex" ? config.codexArgs : config.claudeArgs,
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

  const notifyToolCallUpdate = createToolCallTelegramNotifier({
    enabled: config.toolCallTelegramUpdatesEnabled,
    chatId: config.telegramAllowedUserId,
    telegram,
    logger,
    onSentText: async (text) => {
      await recordRecentTelegramEntry("assistant", `tool update: ${previewText(text, 120)}`);
    },
  });

  const backgroundDeliveryInFlight = new Set<string>();

  const deliverBackgroundJob = async (job: PendingBackgroundJob, trigger: "completion" | "heartbeat"): Promise<boolean> => {
    if (job.kind === "delayed" || job.kind === "recurring") {
      stateStore.markBackgroundJobDelivered(job.taskId);
      logger.info("scheduled_job_delivery_disabled", {
        jobId: job.taskId,
        kind: job.kind,
        trigger,
        status: job.status,
      });
      return true;
    }

    if (!job.deliveryText) {
      logger.warn("background_job_missing_delivery_text", {
        jobId: job.taskId,
        status: job.status,
        trigger,
      });
      return false;
    }
    if (backgroundDeliveryInFlight.has(job.taskId)) {
      return false;
    }

    backgroundDeliveryInFlight.add(job.taskId);
    try {
      await dispatchAssistantReply({
        telegram,
        logger,
        tts,
        rootRealPath: dataRootRealPath,
        update: {
          updateId: job.updateId,
          userId: job.userId,
          chatId: job.chatId,
        },
        rawReply: job.deliveryText,
        logContext: { command: job.command ?? "background" },
        onTextSent: async (text) => {
          await recordRecentTelegramEntry(
            "assistant",
            `background job ${job.taskId}: ${previewText(text, 120)}`,
          );
        },
      });
      stateStore.markBackgroundJobDelivered(job.taskId);
      logger.info("background_job_delivered", {
        jobId: job.taskId,
        trigger,
        status: job.status,
        chatId: job.chatId,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("background_job_delivery_failed", {
        jobId: job.taskId,
        trigger,
        status: job.status,
        chatId: job.chatId,
        message,
      });
      return false;
    } finally {
      backgroundDeliveryInFlight.delete(job.taskId);
    }
  };

  const flushPendingBackgroundJobs = async (): Promise<void> => {
    const pending = stateStore.getPendingBackgroundJobs(20);
    if (pending.length === 0) {
      return;
    }
    for (const job of pending) {
      await deliverBackgroundJob(job, "heartbeat");
    }
  };

  const executeScheduledJob = async (job: ScheduledJob): Promise<void> => {
    if (!stateStore.claimScheduledJob(job.taskId)) {
      return;
    }

    // Check if job is muted
    if (job.mutedUntil) {
      const mutedUntilDate = new Date(job.mutedUntil);
      const now = new Date();

      if (mutedUntilDate > now) {
        // Job is currently muted - skip execution
        logger.info("job_skipped_muted", {
          jobId: job.taskId,
          kind: job.kind,
          mutedUntil: job.mutedUntil,
        });

        if (job.kind === "delayed") {
          // One-shot: mark as skipped_muted
          stateStore.markJobSkippedMuted(job.taskId);
        } else if (job.kind === "recurring") {
          // Recurring: increment run count and schedule next run
          const deliveryText = `[Skipped: muted until ${mutedUntilDate.toLocaleString()}]`;
          const rescheduled = stateStore.rescheduleRecurringJob(
            job.taskId,
            deliveryText,
          );
          if (!rescheduled) {
            // Max runs reached - mark completed
            stateStore.markBackgroundJobCompleted(job.taskId, deliveryText);
          }
        }
        return; // Skip execution
      }
    }

    const prompt = job.payloadPrompt ?? job.requestPreview;
    const isRecurring = job.kind === "recurring";

    const prefixedPrompt = buildScheduledJobExecutionPrompt(prompt, job.kind, job.recurrenceType);

    try {
      const reply = await ambrogioAgent.handleMessage(
        job.userId,
        prefixedPrompt,
        `delayed-${job.taskId}`,
        undefined,
        notifyToolCallUpdate,
      );

      const disableImplicitDelivery = shouldDisableImplicitScheduledDelivery(job.kind, job.recurrenceType);
      const suppressDelivery = disableImplicitDelivery || shouldSuppressScheduledJobDelivery(reply, job.kind, job.recurrenceType);

      if (isRecurring) {
        // For recurring jobs: reschedule before delivery
        const rescheduled = stateStore.rescheduleRecurringJob(job.taskId, reply);
        if (!rescheduled) {
          // Max runs reached or disabled - mark as completed
          const marked = stateStore.markBackgroundJobCompleted(job.taskId, reply);
          if (!marked) {
            logger.info("recurring_job_completion_dropped", { jobId: job.taskId, reason: "status_changed" });
            return;
          }
        }
      } else {
        // One-shot job: mark completed
        const marked = stateStore.markBackgroundJobCompleted(job.taskId, reply);
        if (!marked) {
          logger.info("scheduled_job_result_dropped", { jobId: job.taskId, reason: "status_changed" });
          return;
        }
      }

      if (suppressDelivery) {
        logger.info("scheduled_job_delivery_suppressed_headless", {
          jobId: job.taskId,
          implicitDeliveryDisabled: disableImplicitDelivery,
          recurrenceType: job.recurrenceType,
        });
        const refreshedSuppressed = stateStore.getBackgroundJob(job.taskId);
        if (refreshedSuppressed?.status === "completed_pending_delivery") {
          stateStore.markBackgroundJobDelivered(job.taskId);
        }
        return;
      }

      // Deliver results when not explicitly suppressed
      const refreshed = stateStore.getBackgroundJob(job.taskId);
      if (!refreshed) {
        return;
      }
      await deliverBackgroundJob(refreshed, "completion");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureReply = `Job schedulato fallito (${job.taskId}): ${message}`;

      if (isRecurring) {
        // Log error but keep recurring (increment run count)
        const rescheduled = stateStore.recordRecurringJobFailure(job.taskId, message, failureReply);
        if (!rescheduled) {
          // Max runs reached - mark as failed
          const marked = stateStore.markBackgroundJobFailed(job.taskId, message, failureReply);
          if (!marked) {
            logger.info("recurring_job_failure_dropped", { jobId: job.taskId, reason: "status_changed" });
            return;
          }
        }
      } else {
        const marked = stateStore.markBackgroundJobFailed(job.taskId, message, failureReply);
        if (!marked) {
          logger.info("scheduled_job_failure_dropped", { jobId: job.taskId, reason: "status_changed" });
          return;
        }
      }

      if (shouldDisableImplicitScheduledDelivery(job.kind, job.recurrenceType)) {
        logger.info("scheduled_job_failure_delivery_suppressed_headless", {
          jobId: job.taskId,
          recurrenceType: job.recurrenceType,
        });
        const refreshedSuppressed = stateStore.getBackgroundJob(job.taskId);
        if (refreshedSuppressed?.status === "failed_pending_delivery") {
          stateStore.markBackgroundJobDelivered(job.taskId);
        }
        return;
      }

      const refreshed = stateStore.getBackgroundJob(job.taskId);
      if (!refreshed) {
        return;
      }
      await deliverBackgroundJob(refreshed, "completion");
    }
  };

  const retryJobDelivery = async (jobId: string): Promise<string> => {
    const normalized = jobId.trim();
    if (!normalized) {
      return "Job ID mancante.";
    }
    const job = stateStore.getBackgroundJob(normalized);
    if (!job) {
      return `Job non trovato: ${normalized}`;
    }
    if (job.status === "completed_delivered" || job.status === "failed_delivered") {
      return `Job ${normalized} gia consegnato.`;
    }
    if (job.status === "canceled") {
      return `Job ${normalized} e cancellato.`;
    }
    if (job.status === "scheduled") {
      return `Job ${normalized} e schedulato; verra eseguito a ${job.runAt ?? "orario non disponibile"}.`;
    }
    if (job.status === "running") {
      return `Job ${normalized} ancora in esecuzione.`;
    }
    const delivered = await deliverBackgroundJob(job, "completion");
    return delivered
      ? `Job ${normalized} consegnato con successo.`
      : `Job ${normalized} non consegnato; verra ritentato automaticamente all'heartbeat.`;
  };

  const runDueScheduledJobs = async (): Promise<void> => {
    const due = stateStore.getDueScheduledJobs(10);
    for (const job of due) {
      void executeScheduledJob(job);
    }
  };

  const runHeartbeatPromptWithTimeout = async (
    prompt: string,
    requestId: string,
    suppressToolCallUpdates: boolean,
  ): Promise<string> => {
    const controller = new AbortController();
    const result = await withTimeout(
      (async () => {
        return modelBridge.respond({
          requestId,
          message: prompt,
          signal: controller.signal,
          onToolCallEvent: suppressToolCallUpdates ? undefined : notifyToolCallUpdate,
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
    const summary = modelBridge.getLastExecutionSummary?.();
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
      backgroundJobsPendingDelivery: stateStore.countPendingBackgroundJobs(),
      scheduledJobs: stateStore.countScheduledJobs(),
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
  await startJobRpcServer({
    socketPath: rpcSocketPath,
    stateStore,
    retryJobDelivery: async (jobId) => {
      return retryJobDelivery(jobId);
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
  logger.info("job_rpc_server_started", { socketPath: rpcSocketPath });

  setInterval(() => {
    void (async () => {
      await flushPendingBackgroundJobs();
      await heartbeatRunner.runScheduledHeartbeat("timer");
    })();
  }, HEARTBEAT_INTERVAL_MS);
  setInterval(() => {
    void runDueScheduledJobs();
  }, DELAYED_JOB_POLL_INTERVAL_MS);
  void flushPendingBackgroundJobs();
  void runDueScheduledJobs();
  logger.info("heartbeat_loop_started", {
    intervalMs: HEARTBEAT_INTERVAL_MS,
    filePath: `${config.dataRoot}/${HEARTBEAT_FILE_NAME}`,
  });

  const summarizeUpdate = (update: TelegramMessage): string => {
    if (update.text) {
      return `text: ${previewText(update.text, 120)}`;
    }
    if (update.voiceFileId) {
      return "voice message";
    }
    if (update.attachments.length > 0) {
      const kinds = [...new Set(update.attachments.map((attachment) => attachment.kind))];
      return `attachments: ${kinds.join(",")} (${update.attachments.length})`;
    }
    return "non-text message";
  };

  const runOperationWithSoftTimeout = async (params: {
    update: Pick<TelegramMessage, "updateId" | "userId" | "chatId">;
    commandName?: string;
    requestPreview: string;
    operation: (signal: AbortSignal) => Promise<string>;
  }): Promise<{ reply: string; ok: boolean }> => {
    const tracked = startOperationWithTyping({
      telegram,
      logger,
      chatId: params.update.chatId,
      updateId: params.update.updateId,
      userId: params.update.userId,
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
          updateId: params.update.updateId,
          userId: params.update.userId,
          chatId: params.update.chatId,
          command: params.commandName,
        }),
      });
      return { reply: `Error: ${message}`, ok: false };
    }

    await tracked.stopTyping();
    const jobId = `bg-${params.update.updateId}-${Date.now()}`;
    logger.error("request_timed_out", {
      ...correlationFields({
        updateId: params.update.updateId,
        userId: params.update.userId,
        chatId: params.update.chatId,
        command: params.commandName,
      }),
      timeoutMs: MODEL_TIMEOUT_MS,
      jobId,
    });
    stateStore.createBackgroundJob({
      jobId,
      updateId: params.update.updateId,
      userId: params.update.userId,
      chatId: params.update.chatId,
      command: params.commandName,
      requestPreview: previewText(params.requestPreview, 240),
    });

    void tracked.operationPromise
      .then(async (reply) => {
        const marked = stateStore.markBackgroundJobCompleted(jobId, reply);
        if (!marked) {
          logger.info("background_job_result_dropped", { jobId, reason: "status_changed" });
          return;
        }
        const job = stateStore.getBackgroundJob(jobId);
        if (!job) {
          logger.warn("background_job_missing_after_complete", { jobId });
          return;
        }
        await deliverBackgroundJob(job, "completion");
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const failureReply = `Job in background fallito (ID: ${jobId}): ${message}`;
        const marked = stateStore.markBackgroundJobFailed(jobId, message, failureReply);
        if (!marked) {
          logger.info("background_job_failure_dropped", { jobId, reason: "status_changed" });
          return;
        }
        const job = stateStore.getBackgroundJob(jobId);
        if (!job) {
          logger.warn("background_job_missing_after_failure", { jobId, message });
          return;
        }
        await deliverBackgroundJob(job, "completion");
      });

    return {
      reply:
        `Operazione lunga: continuo in background e ti aggiorno appena finisce.\n` +
        `Job ID: ${jobId}`,
      ok: false,
    };
  };

  const executeBufferedInput = async (input: BufferedTelegramInput): Promise<void> => {
    const updateContext: TelegramMessage = {
      updateId: input.lastUpdateId,
      userId: input.userId,
      chatId: input.chatId,
      text: null,
      voiceFileId: null,
      voiceMimeType: null,
      attachments: [],
    };
    let promptText = input.textSegments.join("\n\n").trim() || null;

    if (!promptText && (input.voiceItems.length > 0 || input.attachments.length > 0) && !allowlist.isAllowed(input.userId)) {
      await sendTelegramTextReply({
        telegram,
        logger,
        update: updateContext,
        text: "Unauthorized user.",
        onSentText: async (text) => {
          await recordRecentTelegramEntry("assistant", `text: ${previewText(text, 120)}`);
        },
      });
      return;
    }

    const result = await runOperationWithSoftTimeout({
      update: updateContext,
      requestPreview: promptText ?? (input.voiceItems.length > 0 ? "voice message" : "attachment workflow"),
      operation: async (signal) => {
        const processedAttachments: ProcessedAttachment[] = [];
        for (let index = 0; index < input.attachments.length; index += 1) {
          const attachment = input.attachments[index];
          if (!attachment) {
            continue;
          }
          try {
            const download = await telegram.downloadFileById(attachment.fileId);
            const processed = await attachmentService.processIncoming({
              attachment,
              download,
              updateId: input.lastUpdateId,
              sequence: index,
            });
            processedAttachments.push(processed);
            logger.info("telegram_attachment_saved", {
              updateId: input.lastUpdateId,
              userId: input.userId,
              chatId: input.chatId,
              kind: processed.kind,
              relativePath: processed.relativePath,
              sizeBytes: processed.sizeBytes,
              inlineText: processed.inlineText !== null,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("telegram_attachment_processing_failed", {
              updateId: input.lastUpdateId,
              userId: input.userId,
              chatId: input.chatId,
              attachmentKind: attachment.kind,
              message,
            });
          }
        }

        const transcriptions: string[] = [];
        for (const voiceItem of input.voiceItems) {
          try {
            const audio = await telegram.downloadFileById(voiceItem.fileId);
            const transcription = await transcriber.transcribe(audio.fileBlob, audio.fileName, audio.mimeType ?? voiceItem.mimeType);
            transcriptions.push(transcription);
            logger.info("telegram_voice_transcribed", {
              updateId: voiceItem.updateId,
              userId: input.userId,
              chatId: input.chatId,
              transcriptionLength: transcription.length,
              transcriptionPreview: previewText(transcription),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("telegram_voice_transcription_failed", {
              updateId: voiceItem.updateId,
              userId: input.userId,
              chatId: input.chatId,
              message,
            });
          }
        }

        if (transcriptions.length > 0) {
          const voiceText = transcriptions.join("\n\n");
          promptText = promptText ? [promptText, voiceText].join("\n\n") : voiceText;
        }

        const attachmentContext = attachmentService.buildPromptContext(processedAttachments);
        if (attachmentContext) {
          const basePrompt = promptText ?? "Analizza gli allegati salvati e proponi i prossimi passi.";
          promptText = [attachmentContext, "", "User message:", basePrompt].join("\n");
        }

        if (!promptText) {
          return input.attachments.length > 0
            ? "Non riesco a processare l'allegato inviato."
            : "Posso gestire solo messaggi testuali o vocali.";
        }

        const modelReply = await ambrogioAgent.handleMessage(
          input.userId,
          promptText,
          String(input.lastUpdateId),
          signal,
          notifyToolCallUpdate,
        );
        lastPromptByUser.set(input.userId, promptText);
        return modelReply;
      },
    });

    if (result.ok) {
      handledMessages += 1;
    } else {
      failedMessages += 1;
    }

    await dispatchAssistantReply({
      telegram,
      logger,
      tts,
      rootRealPath: dataRootRealPath,
      update: updateContext,
      rawReply: result.reply,
      onTextSent: async (text) => {
        await recordRecentTelegramEntry("assistant", text);
      },
    });
  };

  const inputBuffer = createTelegramInputBuffer({
    idleMs: config.telegramInputIdleMs,
    enabled: config.telegramInputBufferEnabled,
    onFlush: async (input) => {
      logger.info("telegram_input_buffer_flushed", {
        chatId: input.chatId,
        userId: input.userId,
        firstUpdateId: input.firstUpdateId,
        lastUpdateId: input.lastUpdateId,
        updateCount: input.updates.length,
        textCount: input.textSegments.length,
        voiceCount: input.voiceItems.length,
        attachmentCount: input.attachments.length,
      });
      await executeBufferedInput(input);
    },
    onFlushError: async (error, input) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("telegram_input_buffer_flush_failed", {
        message,
        chatId: input.chatId,
        userId: input.userId,
        firstUpdateId: input.firstUpdateId,
        lastUpdateId: input.lastUpdateId,
      });
    },
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
      lastTelegramMessageSummary = summarizeUpdate(update);
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
        const result = await runOperationWithSoftTimeout({
          update,
          commandName,
          requestPreview: prompt,
          operation: (signal) => ambrogioAgent.handleMessage(
            update.userId,
            prompt,
            String(update.updateId),
            signal,
            notifyToolCallUpdate,
          ),
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
          const summary = modelBridge.getLastExecutionSummary?.();
          const lines = [
            "Ambrogio-agent status:",
            `Uptime: ${uptime}`,
            `Handled messages: ${handledMessages}`,
            `Failed messages: ${failedMessages}`,
            `Background jobs pending delivery: ${stateStore.countPendingBackgroundJobs()}`,
            `Delayed jobs scheduled: ${stateStore.countScheduledJobs()}`,
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
        getLastLogReply: () => buildLastLogMessage(modelBridge.getLastExecutionSummary?.()),
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
          const skillsRoot =
            config.backend === "codex" ? codexSkillsRoot : claudeSkillsRoot;
          const skills = new SkillDiscovery(skillsRoot);
          const discovered = await skills.discover();
          if (discovered.length === 0) {
            return `Nessuna skill disponibile in ${skillsRoot}.`;
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
          inputBuffer.clear();
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
            logger.debug("state_store_runtime_values_cleared", {
              keys: [
                "heartbeat_last_run_at",
                "heartbeat_last_result",
                "heartbeat_last_alert_fingerprint",
                "heartbeat_last_alert_at",
              ],
            });
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
          await flushPendingBackgroundJobs();
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
          return "Heartbeat skipped durante quiet hours.";
        },

      });
      if (commandHandled) {
        return;
      }

      if (
        update.text &&
        update.voiceFileId === null &&
        update.attachments.length === 0 &&
        allowlist.isAllowed(update.userId) &&
        isActiveJobsListQuery(update.text)
      ) {
        const activeJobs = stateStore
          .getActiveBackgroundJobs(200)
          .filter((job) => job.userId === update.userId && job.chatId === update.chatId)
          .filter((job) => !(job.kind === "recurring" && job.status === "scheduled" && !job.recurrenceEnabled));
        const reply = buildActiveJobsFastReply(activeJobs);
        logger.info("active_jobs_fast_path_served", {
          updateId: update.updateId,
          userId: update.userId,
          chatId: update.chatId,
          activeJobs: activeJobs.length,
          textPreview: previewText(update.text),
        });
        await sendTelegramTextReply({
          telegram,
          logger,
          update,
          text: reply,
          onSentText: async (text) => {
            await recordRecentTelegramEntry("assistant", `text: ${previewText(text, 120)}`);
          },
        });
        handledMessages += 1;
        return;
      }

      inputBuffer.enqueue(update);
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
