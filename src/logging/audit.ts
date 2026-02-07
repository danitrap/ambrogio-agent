export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly level: LogLevel = "info") {}

  private shouldLog(level: LogLevel): boolean {
    return levelOrder[level] >= levelOrder[this.level];
  }

  log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...fields,
    };

    console.log(JSON.stringify(payload));
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.log("error", message, fields);
  }
}
