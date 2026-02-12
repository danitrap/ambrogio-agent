import { createConnection } from "node:net";

type RpcError = { code: string; message: string };
type RpcResponse = { ok: true; result: unknown } | { ok: false; error: RpcError };

type RunDeps = {
  socketPath: string;
  sendRpc?: (op: string, args: Record<string, unknown>) => Promise<RpcResponse>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
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

function mapErrorCodeToExit(code: string): number {
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
  // Support both old tasks.list and new jobs.list
  if (op === "tasks.list" || op === "jobs.list") {
    const jobs = (result as { tasks?: Array<{ taskId: string; status: string; kind?: string; runAt?: string | null }> }).tasks ?? [];
    if (jobs.length === 0) {
      return "No jobs.";
    }
    return jobs.map((job) => `${job.taskId} | ${job.kind ?? "job"} | ${job.status}${job.runAt ? ` | runAt=${job.runAt}` : ""}`).join("\n");
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
    }> }).jobs ?? [];
    if (jobs.length === 0) {
      return "No recurring jobs.";
    }
    return jobs.map((job) => {
      const enabled = job.recurrenceEnabled ? "enabled" : "paused";
      const runs = job.recurrenceMaxRuns ? `${job.recurrenceRunCount}/${job.recurrenceMaxRuns}` : `${job.recurrenceRunCount}`;
      return `${job.taskId} | ${job.recurrenceExpression} | ${enabled} | runs: ${runs} | next: ${job.nextRunAt} | ${job.requestPreview.slice(0, 60)}`;
    }).join("\n");
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
      stderr("Usage: ambrogioctl telegram <send-message|send-photo|send-audio|send-document> --text <text> | --path <absolute-path-under-data-root> [--json]");
      return 2;
    }

    // Handle send-message separately
    if (action === "send-message") {
      const text = readFlag(args, "--text");
      if (!text) {
        stderr("Missing --text flag");
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
    const userIdRaw = readFlag(args, "--user-id") ?? process.env.TELEGRAM_ALLOWED_USER_ID;
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
      const userIdRaw = readFlag(args, "--user-id");
      const chatIdRaw = readFlag(args, "--chat-id");
      const recurrenceType = readFlag(args, "--type");
      const recurrenceExpression = readFlag(args, "--expression");
      const maxRunsRaw = readFlag(args, "--max-runs");

      if (!runAtIso || !prompt || !userIdRaw || !chatIdRaw || !recurrenceType || !recurrenceExpression) {
        stderr("--run-at, --prompt, --user-id, --chat-id, --type, --expression are required.");
        return 2;
      }

      const userId = Number(userIdRaw);
      const chatId = Number(chatIdRaw);
      if (Number.isNaN(userId) || Number.isNaN(chatId)) {
        stderr("--user-id and --chat-id must be numbers.");
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
        userId,
        chatId,
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
      const userIdRaw = readFlag(args, "--user-id");
      const chatIdRaw = readFlag(args, "--chat-id");
      if (!runAtIso || !prompt || !userIdRaw || !chatIdRaw) {
        stderr("--run-at, --prompt, --user-id, --chat-id are required.");
        return 2;
      }
      const userId = Number(userIdRaw);
      const chatId = Number(chatIdRaw);
      if (Number.isNaN(userId) || Number.isNaN(chatId)) {
        stderr("--user-id and --chat-id must be numbers.");
        return 2;
      }
      op = "jobs.create";
      payload = {
        runAtIso,
        prompt,
        userId,
        chatId,
      };
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

  stderr("Usage: ambrogioctl <jobs|tasks|status|telegram|state|conversation|memory> [options]");
  return 2;
}

if (import.meta.main) {
  const socketPath = process.env.AMBROGIO_SOCKET_PATH ?? "/tmp/ambrogio-agent.sock";
  const code = await runAmbrogioCtl(process.argv.slice(2), { socketPath });
  process.exit(code);
}
