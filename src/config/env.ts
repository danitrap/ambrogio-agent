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
  openaiApiKey: string;
  elevenLabsApiKey: string | null;
  dataRoot: string;
  codexCommand: string;
  codexArgs: string[];
  backend: "codex" | "claude";
  claudeCommand: string;
  claudeArgs: string[];
  logLevel: LogLevel;
  telegramPollTimeoutSeconds: number;
  heartbeatQuietHours: string | null;
};

export function loadConfig(): AppConfig {
  const logLevel = (Bun.env.LOG_LEVEL ?? "info") as LogLevel;
  const codexArgsRaw = Bun.env.CODEX_ARGS;
  const codexArgs = codexArgsRaw
    ? codexArgsRaw.split(" ").map((part) => part.trim()).filter(Boolean)
    : ["--dangerously-bypass-approvals-and-sandbox"];

  const backend = (Bun.env.BACKEND?.toLowerCase() ?? "codex") as
    | "codex"
    | "claude";
  const claudeArgsRaw = Bun.env.CLAUDE_ARGS;
  const claudeArgs = claudeArgsRaw
    ? claudeArgsRaw.split(" ").map((part) => part.trim()).filter(Boolean)
    : [];

  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserId: parseNumber(requireEnv("TELEGRAM_ALLOWED_USER_ID"), "TELEGRAM_ALLOWED_USER_ID"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    elevenLabsApiKey: Bun.env.ELEVENLABS_API_KEY ?? null,
    dataRoot: Bun.env.DATA_ROOT ?? "/data",
    codexCommand: Bun.env.CODEX_COMMAND ?? "codex",
    codexArgs,
    backend,
    claudeCommand: Bun.env.CLAUDE_COMMAND ?? "claude",
    claudeArgs,
    logLevel,
    telegramPollTimeoutSeconds: parseNumber(Bun.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? "20", "TELEGRAM_POLL_TIMEOUT_SECONDS"),
    heartbeatQuietHours: Bun.env.HEARTBEAT_QUIET_HOURS?.trim() || null,
  };
}
