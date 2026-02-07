import type { LogLevel } from "../logging/audit";

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }
  return parsed;
}

export type AppConfig = {
  telegramBotToken: string;
  telegramAllowedUserId: number;
  dataRoot: string;
  acpCommand: string;
  acpArgs: string[];
  logLevel: LogLevel;
  telegramPollTimeoutSeconds: number;
};

export function loadConfig(): AppConfig {
  const logLevel = (Bun.env.LOG_LEVEL ?? "info") as LogLevel;
  const acpArgsRaw = Bun.env.ACP_ARGS;
  const acpArgs = acpArgsRaw
    ? acpArgsRaw.split(" ").map((part) => part.trim()).filter(Boolean)
    : ["--dangerously-bypass-approvals-and-sandbox", "-c", "instructions=acp_fs"];

  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserId: parseNumber(requireEnv("TELEGRAM_ALLOWED_USER_ID"), "TELEGRAM_ALLOWED_USER_ID"),
    dataRoot: Bun.env.DATA_ROOT ?? "/data",
    acpCommand: Bun.env.ACP_COMMAND ?? "codex-acp",
    acpArgs,
    logLevel,
    telegramPollTimeoutSeconds: parseNumber(Bun.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? "20", "TELEGRAM_POLL_TIMEOUT_SECONDS"),
  };
}
