import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { StateStore } from "./state-store";

type RpcErrorCode = "BAD_REQUEST" | "NOT_FOUND" | "INVALID_STATE" | "INVALID_TIME" | "INTERNAL";

type RpcError = {
  code: RpcErrorCode;
  message: string;
};

type RpcRequest = {
  op?: string;
  args?: Record<string, unknown>;
};

type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: RpcError };

type TaskRpcServerOptions = {
  socketPath: string;
  stateStore: StateStore;
  retryTaskDelivery: (taskId: string) => Promise<string>;
  getStatus?: () => Promise<Record<string, unknown>>;
};

type TaskRpcServerHandle = {
  close: () => Promise<void>;
};

function rpcOk(result: unknown): RpcResponse {
  return { ok: true, result };
}

function rpcError(code: RpcErrorCode, message: string): RpcResponse {
  return { ok: false, error: { code, message } };
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return value;
}

async function safeUnlink(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function handleRequest(request: RpcRequest, options: TaskRpcServerOptions): Promise<RpcResponse> {
  const op = readString(request.op);
  if (!op) {
    return rpcError("BAD_REQUEST", "Missing operation.");
  }
  const args = request.args ?? {};

  if (op === "tasks.list") {
    const limitRaw = readNumber(args.limit);
    const limit = limitRaw && limitRaw > 0 ? Math.floor(limitRaw) : 20;
    const active = options.stateStore.getActiveBackgroundTasks(limit);
    const statusFilter = Array.isArray(args.status)
      ? args.status.filter((item): item is string => typeof item === "string")
      : [];
    const tasks = (statusFilter.length > 0 ? active.filter((task) => statusFilter.includes(task.status)) : active).map((task) => ({
      taskId: task.taskId,
      kind: task.kind,
      status: task.status,
      createdAt: task.createdAt,
      runAt: task.runAt,
      requestPreview: task.requestPreview,
    }));
    return rpcOk({ tasks });
  }

  if (op === "tasks.inspect") {
    const taskId = readString(args.taskId);
    if (!taskId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }
    const task = options.stateStore.getBackgroundTask(taskId);
    if (!task) {
      return rpcError("NOT_FOUND", `Task non trovato: ${taskId}`);
    }
    return rpcOk(task);
  }

  if (op === "tasks.create") {
    const runAtIso = readString(args.runAtIso);
    const prompt = readString(args.prompt);
    const userId = readNumber(args.userId);
    const chatId = readNumber(args.chatId);
    if (!runAtIso || !prompt || userId === null || chatId === null) {
      return rpcError("BAD_REQUEST", "runAtIso, prompt, userId, chatId are required.");
    }
    const runAtMs = Date.parse(runAtIso);
    if (Number.isNaN(runAtMs) || runAtMs <= Date.now()) {
      return rpcError("INVALID_TIME", "runAtIso must be a future ISO timestamp.");
    }
    const taskId = `dl-rpc-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const requestPreview = readString(args.requestPreview) ?? prompt;
    options.stateStore.createScheduledTask({
      taskId,
      updateId: 0,
      userId,
      chatId,
      command: "rpc_create",
      prompt,
      requestPreview,
      runAt: runAtIso,
    });
    return rpcOk({ taskId, status: "scheduled", runAtIso: new Date(runAtMs).toISOString() });
  }

  if (op === "tasks.cancel") {
    const taskId = readString(args.taskId);
    if (!taskId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }
    const result = options.stateStore.cancelTask(taskId);
    if (result === "not_found") {
      return rpcError("NOT_FOUND", `Task non trovato: ${taskId}`);
    }
    if (result === "already_done") {
      return rpcError("INVALID_STATE", `Task ${taskId} non cancellabile (gia completato/fallito).`);
    }
    return rpcOk({ status: "canceled", taskId });
  }

  if (op === "tasks.retry") {
    const taskId = readString(args.taskId);
    if (!taskId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }
    const task = options.stateStore.getBackgroundTask(taskId);
    if (!task) {
      return rpcError("NOT_FOUND", `Task non trovato: ${taskId}`);
    }
    if (!["completed_pending_delivery", "failed_pending_delivery"].includes(task.status)) {
      return rpcError("INVALID_STATE", `Task ${taskId} non ritentabile nello stato ${task.status}.`);
    }
    const message = await options.retryTaskDelivery(taskId);
    return rpcOk({ taskId, message });
  }

  if (op === "status.get") {
    if (!options.getStatus) {
      return rpcError("BAD_REQUEST", "Status not available.");
    }
    const status = await options.getStatus();
    return rpcOk(status);
  }

  return rpcError("BAD_REQUEST", `Unknown operation: ${op}`);
}

function attachConnection(socket: Socket, options: TaskRpcServerOptions): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", async (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let request: RpcRequest;
      try {
        request = JSON.parse(line) as RpcRequest;
      } catch {
        socket.write(`${JSON.stringify(rpcError("BAD_REQUEST", "Invalid JSON request."))}\n`);
        continue;
      }
      try {
        const response = await handleRequest(request, options);
        socket.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        socket.write(`${JSON.stringify(rpcError("INTERNAL", message))}\n`);
      }
    }
  });
}

export async function startTaskRpcServer(options: TaskRpcServerOptions): Promise<TaskRpcServerHandle> {
  await mkdir(path.dirname(options.socketPath), { recursive: true });
  await safeUnlink(options.socketPath);

  const server: Server = createServer((socket) => {
    void attachConnection(socket, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    await chmod(options.socketPath, 0o600);
  } catch {
    // Some environments do not support chmod on unix socket files.
  }

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await safeUnlink(options.socketPath);
    },
  };
}
