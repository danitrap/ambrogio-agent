import { createConnection } from "node:net";
import { discoverSyncSkills, executeGenerator, type SyncSkill } from "./sync-manifest";
import { callMacToolsRpc } from "../mac-tools/rpc-client";
import type { RpcResponse as MacRpcResponse } from "../mac-tools/types";

type RpcError = { code: string; message: string };
type RpcResponse = { ok: true; result: unknown } | { ok: false; error: RpcError };

type RunDeps = {
  socketPath: string;
  sendRpc?: (op: string, args: Record<string, unknown>) => Promise<RpcResponse>;
  sendMacRpc?: (method: string, payload?: Record<string, unknown>) => Promise<MacRpcResponse>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  env?: Record<string, string>;
};

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function getEnvValue(deps: RunDeps, key: string): string | undefined {
  if (deps.env) {
    return deps.env[key];
  }
  return process.env[key];
}

function resolveAuthorizedTelegramIds(args: string[], deps: RunDeps, stderr: (line: string) => void): {
  userId: number;
  chatId: number;
} | null {
  const explicitUserId = readFlag(args, "--user-id");
  const explicitChatId = readFlag(args, "--chat-id");
  const allowedUserId = getEnvValue(deps, "TELEGRAM_ALLOWED_USER_ID");

  const normalizedUserIdRaw = explicitUserId ?? allowedUserId ?? null;
  const normalizedChatIdRaw = explicitChatId ?? allowedUserId ?? null;

  if (!normalizedUserIdRaw || !normalizedChatIdRaw) {
    stderr("Missing Telegram target identity. Set TELEGRAM_ALLOWED_USER_ID (or provide --user-id/--chat-id).");
    return null;
  }

  const userId = Number(normalizedUserIdRaw);
  const chatId = Number(normalizedChatIdRaw);
  if (Number.isNaN(userId) || Number.isNaN(chatId)) {
    stderr("Resolved userId/chatId are invalid. TELEGRAM_ALLOWED_USER_ID must be a valid number.");
    return null;
  }

  return { userId, chatId };
}

function mapErrorCodeToExit(code: string): number {
  if (code === "method_not_found") {
    return 3;
  }
  if (code === "invalid_params") {
    return 2;
  }
  if (code === "permission_denied" || code === "timeout" || code === "internal_error") {
    return 4;
  }
  if (code === "NOT_FOUND") {
    return 3;
  }
  if (code === "INVALID_STATE" || code === "INVALID_TIME" || code === "FORBIDDEN_PATH" || code === "PAYLOAD_TOO_LARGE") {
    return 4;
  }
  if (code === "BAD_REQUEST") {
    return 2;
  }
  return 10;
}

function formatRelativeMinutes(value: number): string {
  if (value >= 0) {
    return `in ${value}m`;
  }
  return `overdue ${Math.abs(value)}m`;
}

function formatIsoInTimezone(iso: string, timezone?: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return iso;
  }
  if (!timezone) {
    return iso;
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    const year = byType.get("year");
    const month = byType.get("month");
    const day = byType.get("day");
    const hour = byType.get("hour");
    const minute = byType.get("minute");
    const second = byType.get("second");
    if (!year || !month || !day || !hour || !minute || !second) {
      return iso;
    }
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  } catch {
    return iso;
  }
}

function formatCalendarStatus(event: {
  isOngoing?: boolean;
  isEnded?: boolean;
  startInMinutes?: number;
}): string {
  if (event.isOngoing) {
    return "ongoing";
  }
  if (event.isEnded) {
    return "ended";
  }
  if (typeof event.startInMinutes === "number") {
    if (event.startInMinutes >= 0) {
      return `starts in ${event.startInMinutes}m`;
    }
    return `started ${Math.abs(event.startInMinutes)}m ago`;
  }
  return "unknown";
}

async function defaultSendRpc(socketPath: string, op: string, args: Record<string, unknown>): Promise<RpcResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ op, args })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline).trim();
      socket.end();
      if (!line) {
        reject(new Error("Empty RPC response."));
        return;
      }
      try {
        resolve(JSON.parse(line) as RpcResponse);
      } catch (error) {
        reject(error);
      }
    });

    socket.on("error", (error) => {
      reject(error);
    });
  });
}

function formatResult(op: string, result: unknown): string {
  const nowMs = Date.now();
  const formatMute = (mutedUntil: string | null | undefined): string => {
    if (!mutedUntil) {
      return "unmuted";
    }
    const mutedUntilMs = Date.parse(mutedUntil);
    if (Number.isNaN(mutedUntilMs)) {
      return `mutedUntil=${mutedUntil}`;
    }
    if (mutedUntilMs > nowMs) {
      return `mutedUntil=${mutedUntil}`;
    }
    return `muteExpiredAt=${mutedUntil}`;
  };

  // Support both old tasks.list and new jobs.list
  if (op === "tasks.list" || op === "jobs.list") {
    const jobs = (result as { tasks?: Array<{
      taskId: string;
      status: string;
      kind?: string;
      runAt?: string | null;
      mutedUntil?: string | null;
    }> }).tasks ?? [];
    if (jobs.length === 0) {
      return "No jobs.";
    }
    return jobs
      .map((job) => `${job.taskId} | ${job.kind ?? "job"} | ${job.status}${job.runAt ? ` | runAt=${job.runAt}` : ""} | ${formatMute(job.mutedUntil)}`)
      .join("\n");
  }
  if (op === "jobs.list-recurring") {
    const jobs = (result as { jobs?: Array<{
      taskId: string;
      status: string;
      recurrenceType: string | null;
      recurrenceExpression: string | null;
      recurrenceRunCount: number;
      recurrenceMaxRuns: number | null;
      recurrenceEnabled: boolean;
      nextRunAt: string | null;
      requestPreview: string;
      mutedUntil?: string | null;
    }> }).jobs ?? [];
    if (jobs.length === 0) {
      return "No recurring jobs.";
    }
    return jobs.map((job) => {
      const enabled = job.recurrenceEnabled ? "enabled" : "paused";
      const runs = job.recurrenceMaxRuns ? `${job.recurrenceRunCount}/${job.recurrenceMaxRuns}` : `${job.recurrenceRunCount}`;
      return `${job.taskId} | ${job.recurrenceExpression} | ${enabled} | runs: ${runs} | next: ${job.nextRunAt} | ${formatMute(job.mutedUntil)} | ${job.requestPreview.slice(0, 60)}`;
    }).join("\n");
  }
  if (op === "jobs.mute") {
    const data = result as { jobId?: string; mutedUntil?: string };
    return `Job ${data.jobId} muted until ${data.mutedUntil}`;
  }
  if (op === "jobs.unmute") {
    const data = result as { jobId?: string };
    return `Job ${data.jobId} unmuted`;
  }
  if (op === "jobs.mute-pattern") {
    const data = result as { pattern?: string; mutedUntil?: string; count?: number };
    return `Muted ${data.count} job(s) matching "${data.pattern}" until ${data.mutedUntil}`;
  }
  if (op === "jobs.list-muted") {
    const jobs = (result as { jobs?: Array<{
      id: string;
      kind: string;
      prompt: string;
      mutedUntil: string;
      recurrenceExpression?: string;
    }> }).jobs ?? [];
    if (jobs.length === 0) {
      return "No muted jobs.";
    }
    return jobs.map((job) => {
      const recurrence = job.recurrenceExpression ? ` (${job.recurrenceExpression})` : "";
      return `${job.id} [${job.kind}${recurrence}]\n  Prompt: ${job.prompt}\n  Muted until: ${job.mutedUntil}`;
    }).join("\n\n");
  }
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

export async function runAmbrogioCtl(argv: string[], deps: RunDeps): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const sendRpc = deps.sendRpc ?? ((op: string, args: Record<string, unknown>) => defaultSendRpc(deps.socketPath, op, args));

  const [scope, action, ...args] = argv;

  if (scope === "status") {
    const json = hasFlag(action ? [action, ...args] : args, "--json");
    try {
      const response = await sendRpc("status.get", {});
      if (!response.ok) {
        stderr(response.error.message);
        return mapErrorCodeToExit(response.error.code);
      }
      if (json) {
        stdout(JSON.stringify(response.result));
      } else {
        const data = response.result as Record<string, unknown>;
        const lines: string[] = [];
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
              lines.push(`  ${subKey}: ${String(subValue)}`);
            }
          } else if (Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const item of value) {
              lines.push(`  - ${String(item)}`);
            }
          } else {
            lines.push(`${key}: ${String(value)}`);
          }
        }
        stdout(lines.join("\n"));
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(message);
      return 10;
    }
  }

  if (scope === "telegram") {
    if (!action) {
      stderr("Usage: ambrogioctl telegram <send-message|send-photo|send-audio|send-document> --text <text> | <text> | --path <absolute-path-under-data-root> [--json]");
      return 2;
    }

    // Handle send-message separately
    if (action === "send-message") {
      const text = readFlag(args, "--text") ?? args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
      if (!text) {
        stderr("Missing text. Use --text \"...\" or positional message.");
        return 2;
      }

      try {
        const response = await sendRpc("telegram.sendMessage", { text });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        stdout("Message sent successfully.");
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(`Failed to send message: ${message}`);
        return 10;
      }
    }

    // Handle media commands (send-photo, send-audio, send-document)
    const json = hasFlag(args, "--json");
    const mediaPath = readFlag(args, "--path");
    if (!mediaPath) {
      stderr("--path is required.");
      return 2;
    }

    const op = action === "send-photo"
      ? "telegram.sendPhoto"
      : action === "send-audio"
        ? "telegram.sendAudio"
        : action === "send-document"
          ? "telegram.sendDocument"
          : "";
    if (!op) {
      stderr(`Unknown action: ${action}`);
      return 2;
    }

    try {
      const response = await sendRpc(op, { path: mediaPath });
      if (!response.ok) {
        stderr(response.error.message);
        return mapErrorCodeToExit(response.error.code);
      }
      if (json) {
        stdout(JSON.stringify(response.result));
      } else {
        const result = response.result as {
          method?: string;
          path?: string;
          telegramMessageId?: number;
          sizeBytes?: number;
        };
        stdout([
          `method: ${result.method ?? "n/a"}`,
          `path: ${result.path ?? mediaPath}`,
          `telegramMessageId: ${typeof result.telegramMessageId === "number" ? result.telegramMessageId : "n/a"}`,
          `sizeBytes: ${typeof result.sizeBytes === "number" ? result.sizeBytes : "n/a"}`,
        ].join("\n"));
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(message);
      return 10;
    }
  }

  if (scope === "mac") {
    if (!action) {
      stderr("Usage: ambrogioctl mac <ping|info|calendar|reminders> [options]");
      return 2;
    }

    const json = hasFlag(args, "--json");
    const socketPath = getEnvValue(deps, "AMBROGIO_MAC_TOOLS_SOCKET_PATH") ?? "/tmp/ambrogio-mac-tools.sock";
    const sendMacRpc = deps.sendMacRpc
      ?? ((method: string, payload?: Record<string, unknown>) => callMacToolsRpc({
        socketPath,
        method,
        payload,
        requestId: `ctl-${Date.now()}`,
      }));
    const call = async (
      method: string,
      payload: Record<string, unknown> | undefined,
    ): Promise<number> => {
      try {
        const response = await sendMacRpc(method, payload);
        if ("error" in response) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
          return 0;
        }
        if (method === "system.ping") {
          const result = response.result as { service: string; version: string };
          stdout(`${result.service} ${result.version}`);
          return 0;
        }
        if (method === "system.info") {
          const info = response.result as {
            service: string;
            version: string;
            uptimeMs: number;
            socketPath: string;
            permissions: { calendar: string; reminders: string };
          };
          stdout([
            `service: ${info.service}`,
            `version: ${info.version}`,
            `uptimeMs: ${info.uptimeMs}`,
            `socketPath: ${info.socketPath}`,
            `calendarPermission: ${info.permissions.calendar}`,
            `remindersPermission: ${info.permissions.reminders}`,
          ].join("\n"));
          return 0;
        }
        if (method === "calendar.upcoming") {
          const result = response.result as {
            generatedAtEpochMs?: number;
            window: { from: string; to: string; timezone: string };
            events: Array<{
              title: string;
              startAt: string;
              endAt: string;
              calendarName: string;
              startInMinutes?: number;
              isOngoing?: boolean;
              isEnded?: boolean;
            }>;
            count: number;
          };
          if (result.events.length === 0) {
            stdout(`No events in ${result.window.timezone} window.`);
            return 0;
          }
          const lines = [
            `window: ${result.window.from} -> ${result.window.to} (${result.window.timezone})`,
            `count: ${result.count}`,
            ...result.events.map((event) => {
              const status = formatCalendarStatus(event);
              return `${event.startAt} | ${event.title} | ${event.calendarName} | ${status}`;
            }),
          ];
          stdout(lines.join("\n"));
          return 0;
        }
        if (method === "reminders.open") {
          const result = response.result as {
            generatedAt: string;
            generatedAtEpochMs?: number;
            timezone?: string;
            items: Array<{
              title: string;
              dueAt: string | null;
              dueInMinutes?: number | null;
              listName: string;
              isFlagged: boolean;
              tags: string[];
            }>;
            count: number;
          };
          if (result.items.length === 0) {
            stdout(`No open reminders (${result.generatedAt}).`);
            return 0;
          }
          const timezone = typeof result.timezone === "string" && result.timezone.trim().length > 0
            ? result.timezone.trim()
            : undefined;
          const generatedAtLabel = timezone
            ? `${formatIsoInTimezone(result.generatedAt, timezone)} (${timezone})`
            : result.generatedAt;
          const lines = [
            `generatedAt: ${generatedAtLabel}`,
            `count: ${result.count}`,
            ...result.items.map((item) => {
              const due = item.dueAt
                ? (timezone ? `${formatIsoInTimezone(item.dueAt, timezone)} (${timezone})` : item.dueAt)
                : "no-due-date";
              const relative = typeof item.dueInMinutes === "number" ? ` (${formatRelativeMinutes(item.dueInMinutes)})` : "";
              const flagged = item.isFlagged ? "flagged" : "normal";
              const tags = item.tags.length > 0 ? ` tags=${item.tags.join(",")}` : "";
              return `${due}${relative} | ${item.title} | ${item.listName} | ${flagged}${tags}`;
            }),
          ];
          stdout(lines.join("\n"));
          return 0;
        }
        stdout(JSON.stringify(response.result, null, 2));
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    };

    if (action === "ping") {
      return await call("system.ping", undefined);
    }
    if (action === "info") {
      return await call("system.info", undefined);
    }
    if (action === "calendar") {
      const sub = args[0];
      const subArgs = args.slice(1);
      if (sub !== "upcoming") {
        stderr("Usage: ambrogioctl mac calendar upcoming [--days N --limit N --timezone TZ --json]");
        return 2;
      }
      const daysRaw = readFlag(subArgs, "--days");
      const limitRaw = readFlag(subArgs, "--limit");
      const timezone = readFlag(subArgs, "--timezone") ?? undefined;
      const payload: Record<string, unknown> = {};
      if (daysRaw) {
        const days = Number(daysRaw);
        if (Number.isNaN(days) || !Number.isInteger(days) || days <= 0) {
          stderr("--days must be a positive integer.");
          return 2;
        }
        payload.days = days;
      }
      if (limitRaw) {
        const limit = Number(limitRaw);
        if (Number.isNaN(limit) || !Number.isInteger(limit) || limit <= 0) {
          stderr("--limit must be a positive integer.");
          return 2;
        }
        payload.limit = limit;
      }
      if (timezone) {
        payload.timezone = timezone;
      }
      return await call("calendar.upcoming", payload);
    }
    if (action === "reminders") {
      const sub = args[0];
      const subArgs = args.slice(1);
      if (sub !== "open") {
        stderr("Usage: ambrogioctl mac reminders open [--limit N --include-no-due-date true|false --json]");
        return 2;
      }
      const limitRaw = readFlag(subArgs, "--limit");
      const includeNoDueDateRaw = readFlag(subArgs, "--include-no-due-date");
      const payload: Record<string, unknown> = {};
      if (limitRaw) {
        const limit = Number(limitRaw);
        if (Number.isNaN(limit) || !Number.isInteger(limit) || limit <= 0) {
          stderr("--limit must be a positive integer.");
          return 2;
        }
        payload.limit = limit;
      }
      if (includeNoDueDateRaw !== null) {
        const normalized = includeNoDueDateRaw.trim().toLowerCase();
        if (!["true", "false"].includes(normalized)) {
          stderr("--include-no-due-date must be true or false.");
          return 2;
        }
        payload.includeNoDueDate = normalized === "true";
      }
      return await call("reminders.open", payload);
    }

    stderr(`Unknown mac action: ${action}`);
    return 2;
  }

  if (scope === "state") {
    if (!action) {
      stderr("Usage: ambrogioctl state <get|set|delete|list> [options]");
      return 2;
    }

    const json = hasFlag(args, "--json");

    if (action === "get") {
      const key = readFlag(args, "--key") ?? args[0];
      if (!key) {
        stderr("key is required (use --key flag or positional argument)");
        return 2;
      }

      try {
        const response = await sendRpc("state.get", { key });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as { key: string; value: string };
          stdout(`${result.key}=${result.value}`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "set") {
      const key = readFlag(args, "--key") ?? args[0];
      const value = readFlag(args, "--value") ?? args[1];
      if (!key || value === null || value === undefined) {
        stderr("key and value are required (use --key and --value flags or positional arguments)");
        return 2;
      }

      try {
        const response = await sendRpc("state.set", { key, value });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as { key: string; value: string };
          stdout(`Set ${result.key}=${result.value}`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "delete") {
      const keys = args.filter((arg) => !arg.startsWith("--"));
      if (keys.length === 0) {
        stderr("at least one key is required");
        return 2;
      }

      try {
        const response = await sendRpc("state.delete", { keys });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as { deleted: number };
          stdout(`Deleted ${result.deleted} key(s)`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "list") {
      const pattern = readFlag(args, "--pattern") ?? undefined;

      try {
        const response = await sendRpc("state.list", { pattern });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as { entries: Array<{ key: string; value: string; updatedAt: string }> };
          if (result.entries.length === 0) {
            stdout("No keys found.");
          } else {
            stdout(result.entries.map((entry) => `${entry.key}=${entry.value}`).join("\n"));
          }
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    stderr(`Unknown action: ${action}`);
    return 2;
  }

  if (scope === "conversation") {
    if (!action) {
      stderr("Usage: ambrogioctl conversation <clear|list|export|stats> [options]");
      return 2;
    }

    const json = hasFlag(args, "--json");
    const userIdRaw = readFlag(args, "--user-id") ?? getEnvValue(deps, "TELEGRAM_ALLOWED_USER_ID");
    if (!userIdRaw) {
      stderr("--user-id is required (or set TELEGRAM_ALLOWED_USER_ID environment variable)");
      return 2;
    }
    const userId = Number(userIdRaw);
    if (Number.isNaN(userId)) {
      stderr("--user-id must be a valid number");
      return 2;
    }

    if (action === "clear") {
      try {
        const response = await sendRpc("conversation.clear", { userId });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as { deleted: number; userId: number };
          stdout(`Cleared ${result.deleted} conversation entries for user ${result.userId}`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "list") {
      const limitRaw = readFlag(args, "--limit");
      const limit = limitRaw ? Number(limitRaw) : undefined;
      if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
        stderr("--limit must be a positive number");
        return 2;
      }

      try {
        const response = await sendRpc("conversation.list", { userId, limit });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as {
            entries: Array<{ role: "user" | "assistant"; text: string }>;
            userId: number;
            count: number;
          };
          if (result.entries.length === 0) {
            stdout("No conversation entries found.");
          } else {
            const lines = result.entries.map((entry, index) => {
              const truncated = entry.text.length > 80 ? `${entry.text.slice(0, 77)}...` : entry.text;
              return `${index + 1}. [${entry.role}] ${truncated}`;
            });
            stdout(lines.join("\n"));
          }
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "export") {
      const format = readFlag(args, "--format") ?? "text";
      if (format !== "text" && format !== "json") {
        stderr("--format must be either 'text' or 'json'");
        return 2;
      }

      try {
        const response = await sendRpc("conversation.export", { userId });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }

        const result = response.result as {
          entries: Array<{ role: "user" | "assistant"; text: string; createdAt: string }>;
          stats: { entries: number; userTurns: number; assistantTurns: number; hasContext: boolean };
          userId: number;
        };

        if (format === "json" || json) {
          stdout(JSON.stringify(result, null, 2));
        } else {
          const lines: string[] = [
            `=== Conversation Export for User ${result.userId} ===`,
            `Total entries: ${result.stats.entries}`,
            `User turns: ${result.stats.userTurns}`,
            `Assistant turns: ${result.stats.assistantTurns}`,
            "",
          ];
          for (const entry of result.entries) {
            lines.push(`[${entry.createdAt}] ${entry.role.toUpperCase()}:`);
            lines.push(entry.text);
            lines.push("");
          }
          stdout(lines.join("\n"));
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "stats") {
      try {
        const response = await sendRpc("conversation.stats", { userId });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as {
            entries: number;
            userTurns: number;
            assistantTurns: number;
            hasContext: boolean;
            userId: number;
          };
          stdout([
            `userId: ${result.userId}`,
            `entries: ${result.entries}`,
            `userTurns: ${result.userTurns}`,
            `assistantTurns: ${result.assistantTurns}`,
            `hasContext: ${result.hasContext}`,
          ].join("\n"));
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    stderr(`Unknown action: ${action}`);
    return 2;
  }

  if (scope === "jobs") {
    const json = hasFlag(args, "--json");

    if (!action) {
      stderr("Usage: ambrogioctl jobs <create-recurring|pause|resume|list-recurring|update-recurrence> [options]");
      return 2;
    }

    let op = "";
    let payload: Record<string, unknown> = {};

    if (action === "create-recurring") {
      const runAtIso = readFlag(args, "--run-at");
      const prompt = readFlag(args, "--prompt");
      const recurrenceType = readFlag(args, "--type");
      const recurrenceExpression = readFlag(args, "--expression");
      const maxRunsRaw = readFlag(args, "--max-runs");

      if (!runAtIso || !prompt || !recurrenceType || !recurrenceExpression) {
        stderr("--run-at, --prompt, --type, --expression are required.");
        return 2;
      }

      const targetIds = resolveAuthorizedTelegramIds(args, deps, stderr);
      if (!targetIds) {
        return 2;
      }

      if (recurrenceType !== "interval" && recurrenceType !== "cron") {
        stderr("--type must be 'interval' or 'cron'.");
        return 2;
      }

      op = "jobs.create-recurring";
      payload = {
        runAtIso,
        prompt,
        userId: targetIds.userId,
        chatId: targetIds.chatId,
        recurrenceType,
        recurrenceExpression,
      };

      if (maxRunsRaw) {
        const maxRuns = Number(maxRunsRaw);
        if (Number.isNaN(maxRuns) || maxRuns <= 0) {
          stderr("--max-runs must be a positive number.");
          return 2;
        }
        payload.maxRuns = maxRuns;
      }
    } else if (action === "pause" || action === "resume") {
      const id = readFlag(args, "--id");
      if (!id) {
        stderr("--id is required.");
        return 2;
      }
      payload.taskId = id;
      op = `jobs.${action}`;
    } else if (action === "list-recurring") {
      op = "jobs.list-recurring";
      const limitRaw = readFlag(args, "--limit");
      if (limitRaw) {
        const limit = Number(limitRaw);
        if (Number.isNaN(limit) || limit <= 0) {
          stderr("--limit must be a positive number.");
          return 2;
        }
        payload.limit = limit;
      }
    } else if (action === "update-recurrence") {
      const id = readFlag(args, "--id");
      const expression = readFlag(args, "--expression");
      if (!id || !expression) {
        stderr("--id and --expression are required.");
        return 2;
      }
      payload.taskId = id;
      payload.expression = expression;
      op = "jobs.update-recurrence";
    } else if (action === "list") {
      op = "jobs.list";
      const limitRaw = readFlag(args, "--limit");
      if (limitRaw) {
        const limit = Number(limitRaw);
        if (Number.isNaN(limit) || limit <= 0) {
          stderr("--limit must be a positive number.");
          return 2;
        }
        payload.limit = limit;
      }
    } else if (action === "inspect" || action === "cancel" || action === "retry") {
      const id = readFlag(args, "--id");
      if (!id) {
        stderr("--id is required.");
        return 2;
      }
      payload.taskId = id;
      op = `jobs.${action}`;
    } else if (action === "create") {
      const runAtIso = readFlag(args, "--run-at");
      const prompt = readFlag(args, "--prompt");
      if (!runAtIso || !prompt) {
        stderr("--run-at and --prompt are required.");
        return 2;
      }
      const targetIds = resolveAuthorizedTelegramIds(args, deps, stderr);
      if (!targetIds) {
        return 2;
      }
      op = "jobs.create";
      payload = {
        runAtIso,
        prompt,
        userId: targetIds.userId,
        chatId: targetIds.chatId,
      };
    } else if (action === "mute") {
      const id = readFlag(args, "--id");
      const until = readFlag(args, "--until");
      if (!id) {
        stderr("--id is required.");
        return 2;
      }
      if (!until) {
        stderr("--until is required.");
        return 2;
      }
      payload.id = id;
      payload.until = until;
      op = "jobs.mute";
    } else if (action === "unmute") {
      const id = readFlag(args, "--id");
      if (!id) {
        stderr("--id is required.");
        return 2;
      }
      payload.id = id;
      op = "jobs.unmute";
    } else if (action === "mute-pattern") {
      const pattern = readFlag(args, "--pattern");
      const until = readFlag(args, "--until");
      if (!pattern) {
        stderr("--pattern is required.");
        return 2;
      }
      if (!until) {
        stderr("--until is required.");
        return 2;
      }
      payload.pattern = pattern;
      payload.until = until;
      op = "jobs.mute-pattern";
    } else if (action === "list-muted") {
      op = "jobs.list-muted";
      const limitRaw = readFlag(args, "--limit");
      if (limitRaw) {
        const limit = Number(limitRaw);
        if (Number.isNaN(limit) || limit <= 0) {
          stderr("--limit must be a positive number.");
          return 2;
        }
        payload.limit = limit;
      }
    } else {
      stderr(`Unknown action: ${action}`);
      return 2;
    }

    try {
      const response = await sendRpc(op, payload);
      if (!response.ok) {
        stderr(response.error.message);
        return mapErrorCodeToExit(response.error.code);
      }
      if (json) {
        stdout(JSON.stringify(response.result));
      } else {
        stdout(formatResult(op, response.result));
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(message);
      return 10;
    }
  }

  // Handle deprecated "tasks" scope - map to jobs
  if (scope === "tasks") {
    stderr("Warning: 'tasks' scope is deprecated. Use 'jobs' instead.");
    // Recursively call with "jobs" scope instead
    return await runAmbrogioCtl(["jobs", action ?? "", ...args], deps);
  }

  if (scope === "memory") {
    if (!action) {
      stderr("Usage: ambrogioctl memory <add|get|list|search|delete|sync> [options]");
      return 2;
    }

    const json = hasFlag(args, "--json");

    if (action === "add") {
      const type = readFlag(args, "--type");
      const content = readFlag(args, "--content");
      const source = readFlag(args, "--source") ?? "explicit";
      const confidence = readFlag(args, "--confidence") ?? "100";
      const tagsRaw = readFlag(args, "--tags");
      const tags = tagsRaw ? tagsRaw.split(",").map((tag) => tag.trim()) : [];
      const contextInfo = readFlag(args, "--context") ?? "";

      if (!type || !content) {
        stderr("--type and --content are required.");
        return 2;
      }

      if (type !== "preference" && type !== "fact" && type !== "pattern") {
        stderr("--type must be 'preference', 'fact', or 'pattern'.");
        return 2;
      }

      const now = new Date().toISOString();
      const memoryId = `mem-${now.split("T")[0]}-${Math.random().toString(36).slice(2, 9)}`;
      const memoryData = JSON.stringify({
        id: memoryId,
        type,
        content,
        source,
        confidence: parseInt(confidence, 10),
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        tags,
        context: contextInfo,
        status: "active",
      });

      try {
        const response = await sendRpc("memory.add", { id: memoryId, type, data: memoryData });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as { memoryId: string; type: string };
          stdout(`Memory added: ${result.type}:${result.memoryId}`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "get") {
      const type = readFlag(args, "--type");
      const id = readFlag(args, "--id");
      if (!type || !id) {
        stderr("--type and --id are required.");
        return 2;
      }

      try {
        const response = await sendRpc("memory.get", { id, type });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as { id: string; type: string; data: string };
          const parsed = JSON.parse(result.data);
          stdout(`ID: ${result.id}`);
          stdout(`Type: ${result.type}`);
          stdout(`Content: ${parsed.content}`);
          stdout(`Confidence: ${parsed.confidence}`);
          stdout(`Status: ${parsed.status}`);
          if (parsed.tags && parsed.tags.length > 0) {
            stdout(`Tags: ${parsed.tags.join(", ")}`);
          }
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "list") {
      const type = readFlag(args, "--type") ?? undefined;

      try {
        const response = await sendRpc("memory.list", { type });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as {
            memories: Array<{ id: string; type: string; data: string; updatedAt: string }>;
          };
          if (result.memories.length === 0) {
            stdout("No memories found.");
          } else {
            for (const memory of result.memories) {
              try {
                const parsed = JSON.parse(memory.data);
                const preview = parsed.content.length > 60 ? `${parsed.content.slice(0, 57)}...` : parsed.content;
                stdout(`${memory.type}:${memory.id} | ${preview} | confidence: ${parsed.confidence}`);
              } catch {
                stdout(`${memory.type}:${memory.id} | (invalid data)`);
              }
            }
          }
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "search") {
      const query = readFlag(args, "--query");
      if (!query) {
        stderr("--query is required.");
        return 2;
      }

      try {
        const response = await sendRpc("memory.search", { query });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          const result = response.result as {
            matches: Array<{ id: string; type: string; data: string; updatedAt: string }>;
            query: string;
          };
          if (result.matches.length === 0) {
            stdout(`No matches found for query: "${result.query}"`);
          } else {
            stdout(`Found ${result.matches.length} match(es) for query: "${result.query}"`);
            for (const match of result.matches) {
              try {
                const parsed = JSON.parse(match.data);
                const preview = parsed.content.length > 60 ? `${parsed.content.slice(0, 57)}...` : parsed.content;
                stdout(`${match.type}:${match.id} | ${preview}`);
              } catch {
                stdout(`${match.type}:${match.id} | (invalid data)`);
              }
            }
          }
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "delete") {
      const type = readFlag(args, "--type");
      const id = readFlag(args, "--id");
      if (!type || !id) {
        stderr("--type and --id are required.");
        return 2;
      }

      try {
        const response = await sendRpc("memory.delete", { id, type });
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }
        if (json) {
          stdout(JSON.stringify(response.result));
        } else {
          stdout(`Memory deleted: ${type}:${id}`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    if (action === "sync") {
      const dataRoot = Bun.env.DATA_ROOT ?? "/data";
      const outputPath = readFlag(args, "--output") ?? `${dataRoot}/MEMORY.md`;

      try {
        // We need to access stateStore directly, so we use a special approach
        // The RPC server doesn't provide direct access to stateStore for this operation
        const response = await sendRpc("memory.list", {});
        if (!response.ok) {
          stderr(response.error.message);
          return mapErrorCodeToExit(response.error.code);
        }

        const result = response.result as {
          memories: Array<{ id: string; type: string; data: string; updatedAt: string }>;
        };

        // Generate markdown from memories
        const preferences: Array<{ id: string; data: any }> = [];
        const facts: Array<{ id: string; data: any }> = [];
        const patterns: Array<{ id: string; data: any }> = [];

        for (const memory of result.memories) {
          try {
            const parsed = JSON.parse(memory.data);
            if (parsed.status === "archived") continue;

            const memoryObj = { id: memory.id, data: parsed };
            if (memory.type === "preference") preferences.push(memoryObj);
            else if (memory.type === "fact") facts.push(memoryObj);
            else if (memory.type === "pattern") patterns.push(memoryObj);
          } catch {
            continue;
          }
        }

        // Sort by confidence and date
        const sortMemories = (a: any, b: any) => {
          const confA = a.data.confidence ?? 0;
          const confB = b.data.confidence ?? 0;
          if (confA !== confB) return confB - confA;
          return new Date(b.data.createdAt).getTime() - new Date(a.data.createdAt).getTime();
        };

        preferences.sort(sortMemories);
        facts.sort(sortMemories);
        patterns.sort(sortMemories);

        const lines: string[] = [
          "# Ambrogio Agent - Memory",
          "",
          "This file contains Ambrogio's long-term semantic memory across sessions.",
          "",
          "**Memory Types:**",
          "- **Preferences**: User's explicit choices (tools, communication style, workflows)",
          "- **Facts**: Contextual information (credentials, IPs, project details)",
          "- **Patterns**: Observed behaviors (habits, common mistakes)",
          "",
          "---",
          "",
        ];

        const formatSection = (memories: Array<{ id: string; data: any }>, title: string) => {
          if (memories.length === 0) return;

          lines.push(`## ${title}`, "");
          for (const memory of memories) {
            const m = memory.data;
            lines.push(`### ${m.content}`, "");
            lines.push(`- **ID**: \`${m.id}\``);
            lines.push(`- **Confidence**: ${m.confidence}%`);
            lines.push(`- **Source**: ${m.source}`);
            lines.push(`- **Created**: ${new Date(m.createdAt).toLocaleDateString()}`);
            lines.push(`- **Last Updated**: ${new Date(m.updatedAt).toLocaleDateString()}`);
            if (m.tags && m.tags.length > 0) {
              lines.push(`- **Tags**: ${m.tags.map((t: string) => `\`${t}\``).join(", ")}`);
            }
            if (m.context) {
              lines.push(`- **Context**: ${m.context}`);
            }
            if (m.status !== "active") {
              lines.push(`- **Status**: ${m.status}`);
            }
            lines.push("");
          }
        };

        formatSection(preferences, "User Preferences");
        formatSection(facts, "Facts & Knowledge");
        formatSection(patterns, "Behavioral Patterns");

        if (preferences.length === 0 && facts.length === 0 && patterns.length === 0) {
          lines.push("## No Memories Yet", "");
          lines.push("Use `ambrogioctl memory add` to create memories, or use the `memory-manager` skill.", "");
        }

        const markdown = lines.join("\n");

        // Write to file
        await Bun.write(outputPath, markdown);

        stdout(`MEMORY.md synced successfully to: ${outputPath}`);
        stdout(`Total memories: ${result.memories.length}`);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(message);
        return 10;
      }
    }

    stderr(`Unknown action: ${action}`);
    return 2;
  }

  if (scope === "sync") {
    if (!action) {
      stderr("Usage: ambrogioctl sync <list|validate|generate> [options]");
      return 2;
    }

    const json = hasFlag(args, "--json");
    const skillsDirs = (deps.env?.SKILLS_DIRS ?? "/data/.codex/skills").split(
      ":",
    );

    if (action === "list") {
      try {
        const skills = await discoverSyncSkills(skillsDirs);

        if (json) {
          stdout(
            JSON.stringify({
              skills: skills.map((s) => ({
                name: s.name,
                outputFile: s.manifest.outputFile,
                patterns: s.manifest.patterns,
                description: s.manifest.description,
              })),
            }),
          );
        } else {
          if (skills.length === 0) {
            stdout("No skills with SYNC.json found.");
          } else {
            stdout(`Found ${skills.length} skill(s) with sync capability:\n`);
            for (const skill of skills) {
              stdout(`  ${skill.name}`);
              stdout(`    Output: ${skill.manifest.outputFile}`);
              stdout(`    Patterns: ${skill.manifest.patterns.join(", ")}`);
              if (skill.manifest.description) {
                stdout(`    Description: ${skill.manifest.description}`);
              }
              stdout("");
            }
          }
        }
        return 0;
      } catch (error) {
        stderr(`Error discovering skills: ${error}`);
        return 10;
      }
    }

    if (action === "validate") {
      const skillName = readFlag(args, "--skill");
      if (!skillName) {
        stderr("--skill is required for validate");
        return 2;
      }

      try {
        const skills = await discoverSyncSkills(skillsDirs);
        const skill = skills.find((s) => s.name === skillName);

        if (!skill) {
          stderr(`Skill '${skillName}' not found or has no SYNC.json`);
          return 3;
        }

        if (json) {
          stdout(JSON.stringify({ valid: true, skill: skill.name }));
        } else {
          stdout(`✓ SYNC.json for '${skillName}' is valid`);
        }
        return 0;
      } catch (error) {
        stderr(`Validation error: ${error}`);
        return 10;
      }
    }

    if (action === "generate") {
      const skillName = readFlag(args, "--skill");
      const all = hasFlag(args, "--all");

      if (!skillName && !all) {
        stderr("Either --skill or --all is required for generate");
        return 2;
      }

      try {
        const skills = await discoverSyncSkills(skillsDirs);

        const toGenerate = all
          ? skills
          : skills.filter((s) => s.name === skillName);

        if (!all && toGenerate.length === 0) {
          stderr(`Skill '${skillName}' not found or has no SYNC.json`);
          return 3;
        }

        let hasErrors = false;
        const results: Array<{ skill: string; success: boolean; message: string }> =
          [];

        for (const skill of toGenerate) {
          stdout(`Generating ${skill.name}...`);
          const result = await executeGenerator(skill);

          if (result.success) {
            stdout(result.stdout);
            results.push({
              skill: skill.name,
              success: true,
              message: `Synced to ${skill.manifest.outputFile}`,
            });
          } else {
            hasErrors = true;
            stderr(
              `Failed to generate ${skill.name}: ${result.error ?? `exit code ${result.exitCode}`}`,
            );
            if (result.stderr) stderr(result.stderr);
            results.push({
              skill: skill.name,
              success: false,
              message: result.error ?? `Exit code ${result.exitCode}`,
            });
          }
        }

        if (json) {
          stdout(JSON.stringify({ results }));
        }

        // For --all, succeed even if some failed (report them but don't error)
        return all ? 0 : hasErrors ? 4 : 0;
      } catch (error) {
        stderr(`Error generating sync files: ${error}`);
        return 10;
      }
    }

    stderr(`Unknown sync action: ${action}`);
    return 2;
  }

  stderr("Usage: ambrogioctl <jobs|tasks|status|telegram|state|conversation|memory|sync> [options]");
  return 2;
}

if (import.meta.main) {
  const socketPath = process.env.AMBROGIO_SOCKET_PATH ?? "/tmp/ambrogio-agent.sock";
  const code = await runAmbrogioCtl(process.argv.slice(2), {
    socketPath,
    env: process.env as Record<string, string>,
  });
  process.exit(code);
}
