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
  if (op === "tasks.list") {
    const tasks = (result as { tasks?: Array<{ taskId: string; status: string; kind?: string; runAt?: string | null }> }).tasks ?? [];
    if (tasks.length === 0) {
      return "No tasks.";
    }
    return tasks.map((task) => `${task.taskId} | ${task.kind ?? "task"} | ${task.status}${task.runAt ? ` | runAt=${task.runAt}` : ""}`).join("\n");
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
      stderr("Usage: ambrogioctl telegram <send-photo|send-audio|send-document> --path <absolute-path-under-data-root> [--json]");
      return 2;
    }
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

  if (scope !== "tasks" || !action) {
    stderr("Usage: ambrogioctl <tasks|status|telegram> [options]");
    return 2;
  }

  const json = hasFlag(args, "--json");

  let op = "";
  let payload: Record<string, unknown> = {};

  if (action === "list") {
    op = "tasks.list";
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
    op = `tasks.${action}`;
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
    op = "tasks.create";
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

if (import.meta.main) {
  const socketPath = process.env.AMBROGIO_SOCKET_PATH ?? "/tmp/ambrogio-agent.sock";
  const code = await runAmbrogioCtl(process.argv.slice(2), { socketPath });
  process.exit(code);
}
