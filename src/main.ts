import { TelegramAllowlist } from "./auth/allowlist";
import { AgentService } from "./app/agent-service";
import { loadConfig } from "./config/env";
import { Logger } from "./logging/audit";
import { CodexAcpBridge } from "./model/codex-acp-bridge";
import { GitSnapshotManager } from "./snapshots/git";
import { SkillDiscovery } from "./skills/discovery";
import { TelegramAdapter } from "./telegram/adapter";
import { FsTools } from "./tools/fs-tools";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

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
      CODEX_HOME: Bun.env.CODEX_HOME ?? `${config.dataRoot}/.codex`,
      HOME: Bun.env.HOME ?? config.dataRoot,
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

        let reply: string;
        try {
          reply = await agent.handleMessage(update.userId, update.text);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          logger.error("message_processing_failed", { message, userId: update.userId });
          reply = `Error: ${message}`;
        }

        await telegram.sendMessage(update.chatId, reply.slice(0, 4000));
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
