import { mkdir } from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AttachmentService, type ProcessedAttachment } from "./attachments/attachment-service";
import { TelegramAllowlist } from "./auth/allowlist";
import { AgentService } from "./app/agent-service";
import { loadConfig } from "./config/env";
import { Logger } from "./logging/audit";
import { CodexAcpBridge } from "./model/codex-acp-bridge";
import { ElevenLabsTts } from "./model/elevenlabs-tts";
import { OpenAiTranscriber } from "./model/openai-transcriber";
import { GitSnapshotManager } from "./snapshots/git";
import { bootstrapProjectSkills } from "./skills/bootstrap";
import { SkillDiscovery } from "./skills/discovery";
import { TelegramAdapter } from "./telegram/adapter";
import { parseTelegramCommand } from "./telegram/commands";
import { parseResponseMode } from "./telegram/response-mode";
import { FsTools } from "./tools/fs-tools";

const TYPING_INTERVAL_MS = 4_000;
const MODEL_TIMEOUT_MS = 180_000;
const MAX_TELEGRAM_AUDIO_BYTES = 49_000_000;
const MAX_INLINE_ATTACHMENT_TEXT_BYTES = 64 * 1024;

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

function buildLastLogMessage(summary: ReturnType<CodexAcpBridge["getLastExecutionSummary"]>): string {
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

async function resolveAudioPathForUpload(rootRealPath: string, inputPath: string): Promise<{ realPath: string; relativePath: string }> {
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
  if (fileStat.size > MAX_TELEGRAM_AUDIO_BYTES) {
    throw new Error(`File too large for Telegram audio upload (${fileStat.size} bytes)`);
  }

  return {
    realPath: real,
    relativePath: path.relative(rootRealPath, real),
  };
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
  const dataRootRealPath = await realpath(config.dataRoot);

  const snapshots = new GitSnapshotManager(config.dataRoot);
  await snapshots.init();

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
  const modelBridge = new CodexAcpBridge(config.acpCommand, config.acpArgs, logger, {
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
    fsTools,
    snapshots,
    logger,
  });

  logger.info("agent_started", {
    dataRoot: config.dataRoot,
    acpCommand: config.acpCommand,
  });

  let offset = 0;
  const startedAtMs = Date.now();
  let handledMessages = 0;
  let failedMessages = 0;
  const lastPromptByUser = new Map<number, string>();
  while (true) {
    try {
      const updates = await telegram.getUpdates(offset, config.telegramPollTimeoutSeconds);
      for (const update of updates) {
        offset = Math.max(offset, update.updateId + 1);
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
        if (command) {
          const sendCommandReply = async (outbound: string): Promise<void> => {
            await telegram.sendMessage(update.chatId, outbound.slice(0, 4000));
            logger.info("telegram_message_sent", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              textLength: outbound.length,
              textPreview: previewText(outbound),
              command: command.name,
            });
          };

          if (!allowlist.isAllowed(update.userId)) {
            await sendCommandReply("Unauthorized user.");
            continue;
          }

          switch (command.name) {
            case "help": {
              await sendCommandReply(
                [
                  "Comandi disponibili:",
                  "/help - mostra questo aiuto",
                  "/status - stato runtime agente",
                  "/lastlog - ultimo riepilogo codex exec",
                  "/retry - riesegue l'ultimo prompt utente",
                  "/audio <prompt> - esegue il prompt e risponde in audio",
                  "/memory - stato memoria conversazione",
                  "/skills - lista skills disponibili",
                  "/clear - cancella memoria conversazione",
                  "/sendaudio <path> - invia un file audio da /data",
                ].join("\n"),
              );
              continue;
            }
            case "status": {
              const uptime = formatDuration(Date.now() - startedAtMs);
              const summary = modelBridge.getLastExecutionSummary();
              const lines = [
                "Agent status:",
                `Uptime: ${uptime}`,
                `Handled messages: ${handledMessages}`,
                `Failed messages: ${failedMessages}`,
                `Backend command: ${config.acpCommand}`,
                `Last codex exec: ${summary ? `${summary.status} (${summary.startedAt})` : "n/a"}`,
              ];
              await sendCommandReply(lines.join("\n"));
              continue;
            }
            case "lastlog": {
              await sendCommandReply(buildLastLogMessage(modelBridge.getLastExecutionSummary()));
              continue;
            }
            case "memory": {
              const stats = agent.getConversationStats(update.userId);
              const lines = [
                "Conversation memory:",
                `Entries: ${stats.entries}`,
                `User turns: ${stats.userTurns}`,
                `Assistant turns: ${stats.assistantTurns}`,
                `Has context: ${stats.hasContext ? "yes" : "no"}`,
              ];
              await sendCommandReply(lines.join("\n"));
              continue;
            }
            case "skills": {
              const discovered = await skills.discover();
              if (discovered.length === 0) {
                await sendCommandReply("Nessuna skill disponibile in /data/skills o /data/.codex/skills.");
                continue;
              }

              const lines = [
                "Skills disponibili:",
                ...discovered.map((skill, index) => {
                  const description = skill.description.replaceAll(/\s+/g, " ").trim();
                  return `${index + 1}. ${skill.id} - ${description}`;
                }),
              ];
              await sendCommandReply(lines.join("\n"));
              continue;
            }
            case "retry": {
              const lastPrompt = lastPromptByUser.get(update.userId);
              if (!lastPrompt) {
                await sendCommandReply("Nessun prompt precedente da rieseguire.");
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
                reply = await withTimeout(agent.handleMessage(update.userId, lastPrompt, String(update.updateId)), MODEL_TIMEOUT_MS);
                handledMessages += 1;
              } catch (error) {
                failedMessages += 1;
                if (error instanceof Error && error.message === "MODEL_TIMEOUT") {
                  logger.error("request_timed_out", {
                    updateId: update.updateId,
                    userId: update.userId,
                    chatId: update.chatId,
                    timeoutMs: MODEL_TIMEOUT_MS,
                    command: "retry",
                  });
                  reply = "Model backend unavailable right now. Riprova tra poco.";
                } else {
                  const message = error instanceof Error ? error.message : "Unknown error";
                  logger.error("message_processing_failed", { message, userId: update.userId, command: "retry" });
                  reply = `Error: ${message}`;
                }
              } finally {
                typingController.abort();
                await typingLoop;
              }

              const parsed = parseResponseMode(reply);
              if (parsed.mode === "audio" && tts) {
                try {
                  const audioBlob = await tts.synthesize(parsed.text.slice(0, 4000));
                  await telegram.sendAudio(update.chatId, audioBlob, `retry-${update.updateId}.mp3`);
                  logger.info("telegram_audio_reply_sent", {
                    updateId: update.updateId,
                    userId: update.userId,
                    chatId: update.chatId,
                    command: "retry",
                    mode: parsed.mode,
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  logger.warn("telegram_audio_reply_failed", {
                    updateId: update.updateId,
                    userId: update.userId,
                    chatId: update.chatId,
                    command: "retry",
                    mode: parsed.mode,
                    message,
                  });
                  await sendCommandReply(parsed.text);
                }
              } else {
                await sendCommandReply(parsed.text);
              }
              continue;
            }
            case "audio": {
              if (!command.args) {
                await sendCommandReply("Usage: /audio <prompt>");
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
                reply = await withTimeout(agent.handleMessage(update.userId, command.args, String(update.updateId)), MODEL_TIMEOUT_MS);
                handledMessages += 1;
                lastPromptByUser.set(update.userId, command.args);
              } catch (error) {
                failedMessages += 1;
                if (error instanceof Error && error.message === "MODEL_TIMEOUT") {
                  logger.error("request_timed_out", {
                    updateId: update.updateId,
                    userId: update.userId,
                    chatId: update.chatId,
                    timeoutMs: MODEL_TIMEOUT_MS,
                    command: "audio",
                  });
                  reply = "Model backend unavailable right now. Riprova tra poco.";
                } else {
                  const message = error instanceof Error ? error.message : "Unknown error";
                  logger.error("message_processing_failed", { message, userId: update.userId, command: "audio" });
                  reply = `Error: ${message}`;
                }
              } finally {
                typingController.abort();
                await typingLoop;
              }

              const parsed = parseResponseMode(reply);
              const audioText = parsed.text.slice(0, 4000);
              if (!tts) {
                await sendCommandReply("ELEVENLABS_API_KEY non configurata, invio testo:\n\n" + audioText.slice(0, 3800));
                continue;
              }

              try {
                const audioBlob = await tts.synthesize(audioText);
                await telegram.sendAudio(update.chatId, audioBlob, `reply-${update.updateId}.mp3`);
                logger.info("telegram_audio_reply_sent", {
                  updateId: update.updateId,
                  userId: update.userId,
                  chatId: update.chatId,
                  textLength: audioText.length,
                  textPreview: previewText(audioText),
                  command: "audio",
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn("telegram_audio_reply_failed", {
                  updateId: update.updateId,
                  userId: update.userId,
                  chatId: update.chatId,
                  message,
                  command: "audio",
                });
                await sendCommandReply(`Audio non disponibile (${message}), invio testo:\n\n${audioText.slice(0, 3600)}`);
              }
              continue;
            }
            case "sendaudio": {
              try {
                const { realPath, relativePath } = await resolveAudioPathForUpload(dataRootRealPath, command.args);
                const fileBlob = Bun.file(realPath);
                await telegram.sendAudio(update.chatId, fileBlob, path.basename(relativePath), `File: ${relativePath}`);
                logger.info("telegram_audio_sent", {
                  updateId: update.updateId,
                  userId: update.userId,
                  chatId: update.chatId,
                  filePath: relativePath,
                });
                await sendCommandReply(`Audio inviato: ${relativePath}`);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn("telegram_audio_send_failed", {
                  updateId: update.updateId,
                  userId: update.userId,
                  chatId: update.chatId,
                  message,
                });
                await sendCommandReply(`Impossibile inviare audio: ${message}`);
              }
              continue;
            }
            case "clear":
              break;
            default: {
              await sendCommandReply(`Comando non riconosciuto: /${command.name}. Usa /help.`);
              continue;
            }
          }
        }

        if (update.text && isClearCommand(update.text)) {
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
        let promptText = update.text;

        if (!promptText && (update.voiceFileId || update.attachments.length > 0) && !allowlist.isAllowed(update.userId)) {
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
            reply = update.attachments.length > 0
              ? "Non riesco a processare l'allegato inviato."
              : "Posso gestire solo messaggi testuali o vocali.";
          } else {
            reply = await withTimeout(agent.handleMessage(update.userId, promptText, String(update.updateId)), MODEL_TIMEOUT_MS);
            handledMessages += 1;
            lastPromptByUser.set(update.userId, promptText);
          }
        } catch (error) {
          failedMessages += 1;
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

        const parsed = parseResponseMode(reply);
        const outbound = parsed.text.slice(0, 4000);
        if (parsed.mode === "audio" && tts) {
          try {
            const audioBlob = await tts.synthesize(outbound);
            await telegram.sendAudio(update.chatId, audioBlob, `reply-${update.updateId}.mp3`);
            logger.info("telegram_audio_reply_sent", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              textLength: outbound.length,
              textPreview: previewText(outbound),
              mode: parsed.mode,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("telegram_audio_reply_failed", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              message,
              mode: parsed.mode,
            });
            await telegram.sendMessage(update.chatId, outbound);
            logger.info("telegram_message_sent", {
              updateId: update.updateId,
              userId: update.userId,
              chatId: update.chatId,
              textLength: outbound.length,
              textPreview: previewText(outbound),
              mode: "text_fallback",
            });
          }
        } else {
          await telegram.sendMessage(update.chatId, outbound);
          logger.info("telegram_message_sent", {
            updateId: update.updateId,
            userId: update.userId,
            chatId: update.chatId,
            textLength: outbound.length,
            textPreview: previewText(outbound),
            mode: parsed.mode,
          });
        }
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
