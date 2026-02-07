import { mkdir } from "node:fs/promises";
import { TelegramAllowlist } from "./auth/allowlist";
import { AgentService } from "./app/agent-service";
import { loadConfig } from "./config/env";
import { Logger } from "./logging/audit";
import { CodexAcpBridge } from "./model/codex-acp-bridge";
import { GitSnapshotManager } from "./snapshots/git";
import { SkillDiscovery } from "./skills/discovery";
import { TelegramAdapter } from "./telegram/adapter";
import { FsTools } from "./tools/fs-tools";

const TYPING_INTERVAL_MS = 4_000;
const MODEL_TIMEOUT_MS = 60_000;

function previewText(value: string, max = 160): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function isClearCommand(text: string): boolean {
  return /^\/clear(?:@\w+)?(?:\s+.*)?$/i.test(text.trim());
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const codexHome = Bun.env.CODEX_HOME ?? `${config.dataRoot}/.codex`;
  const homeDir = Bun.env.HOME ?? config.dataRoot;

  await mkdir(homeDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });

  const telegram = new TelegramAdapter(config.telegramBotToken);
  const allowlist = new TelegramAllowlist(config.telegramAllowedUserId);
  const fsTools = new FsTools({ root: config.dataRoot });
  await fsTools.init();

  const snapshots = new GitSnapshotManager(config.dataRoot);
  await snapshots.init();

  const skills = new SkillDiscovery(`${config.dataRoot}/skills`);
  const modelBridge = new CodexAcpBridge(config.acpCommand, config.acpArgs, logger, {
    cwd: config.dataRoot,
    env: {
      CODEX_HOME: codexHome,
      HOME: homeDir,
      NO_COLOR: Bun.env.NO_COLOR ?? "1",
    },
  });

  const agent = new AgentService({
    allowlist,
    modelBridge,
    skills,
    fsTools,
    snapshots,
    logger,
  });

  logger.info("agent_started", {
    dataRoot: config.dataRoot,
    acpCommand: config.acpCommand,
  });

  let offset = 0;
  while (true) {
    try {
      const updates = await telegram.getUpdates(offset, config.telegramPollTimeoutSeconds);
      for (const update of updates) {
        offset = Math.max(offset, update.updateId + 1);
        logger.info("telegram_message_received", {
          updateId: update.updateId,
          userId: update.userId,
          chatId: update.chatId,
          textLength: update.text.length,
          textPreview: previewText(update.text),
        });

        if (isClearCommand(update.text)) {
          if (!allowlist.isAllowed(update.userId)) {
            const outbound = "Unauthorized user.";
            await telegram.sendMessage(update.chatId, outbound);
            logger.info("telegram_message_sent", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              textLength: outbound.length,
              textPreview: previewText(outbound),
            });
            continue;
          }

          agent.clearConversation(update.userId);
          logger.info("conversation_cleared", {
            updateId: update.updateId,
            userId: update.userId,
            chatId: update.chatId,
          });
          const outbound = "Memoria conversazione cancellata.";
          await telegram.sendMessage(update.chatId, outbound);
          logger.info("telegram_message_sent", {
            updateId: update.updateId,
            userId: update.userId,
            chatId: update.chatId,
            textLength: outbound.length,
            textPreview: previewText(outbound),
          });
          continue;
        }

        let reply: string;
        const typingController = new AbortController();
        const typingLoop = startTypingLoop(
          telegram,
          logger,
          update.chatId,
          update.updateId,
          update.userId,
          typingController.signal,
        );
        try {
          reply = await withTimeout(agent.handleMessage(update.userId, update.text), MODEL_TIMEOUT_MS);
        } catch (error) {
          if (error instanceof Error && error.message === "MODEL_TIMEOUT") {
            logger.error("request_timed_out", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              timeoutMs: MODEL_TIMEOUT_MS,
            });
            reply = "Model backend unavailable right now. Riprova tra poco.";
          } else {
            const message = error instanceof Error ? error.message : "Unknown error";
            logger.error("message_processing_failed", { message, userId: update.userId });
            reply = `Error: ${message}`;
          }
        } finally {
          typingController.abort();
          await typingLoop;
        }

        const outbound = reply.slice(0, 4000);
        await telegram.sendMessage(update.chatId, outbound);
        logger.info("telegram_message_sent", {
          updateId: update.updateId,
          userId: update.userId,
          chatId: update.chatId,
          textLength: outbound.length,
          textPreview: previewText(outbound),
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
