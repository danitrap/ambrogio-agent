import { chmod, mkdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { StateStore } from "./state-store";

type RpcErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "INVALID_TIME"
  | "FORBIDDEN_PATH"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA"
  | "INTERNAL";

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

type JobRpcServerOptions = {
  socketPath: string;
  stateStore: StateStore;
  retryJobDelivery: (jobId: string) => Promise<string>;
  getStatus?: () => Promise<Record<string, unknown>>;
  telegram?: {
    getAuthorizedChatId: () => number | null;
    sendMessage: (chatId: number, text: string) => Promise<void>;
    recordMessage: (role: "assistant" | "user", summary: string) => Promise<void>;
  };
  media?: {
    dataRootRealPath: string;
    getAuthorizedChatId: () => number | null;
    maxPhotoBytes: number;
    maxAudioBytes: number;
    maxDocumentBytes: number;
    sendPhoto: (chatId: number, photo: Blob, fileName: string, caption?: string) => Promise<number>;
    sendAudio: (chatId: number, audio: Blob, fileName: string, caption?: string) => Promise<number>;
    sendDocument: (chatId: number, document: Blob, fileName: string, caption?: string) => Promise<number>;
  };
};

type JobRpcServerHandle = {
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

async function resolveRpcMediaFile(params: {
  dataRootRealPath: string;
  inputPath: string;
  maxBytes: number;
}): Promise<{ realPath: string; fileName: string; sizeBytes: number }> {
  if (!path.isAbsolute(params.inputPath)) {
    throw new Error("BAD_REQUEST:path must be absolute.");
  }
  const realPathValue = await realpath(params.inputPath);
  const normalizedRoot = params.dataRootRealPath.endsWith(path.sep)
    ? params.dataRootRealPath
    : `${params.dataRootRealPath}${path.sep}`;
  if (realPathValue !== params.dataRootRealPath && !realPathValue.startsWith(normalizedRoot)) {
    throw new Error("FORBIDDEN_PATH:path must be under /data.");
  }
  const fileStat = await stat(realPathValue);
  if (!fileStat.isFile()) {
    throw new Error("BAD_REQUEST:path is not a file.");
  }
  if (fileStat.size > params.maxBytes) {
    throw new Error(`PAYLOAD_TOO_LARGE:file exceeds limit (${fileStat.size} bytes).`);
  }
  return {
    realPath: realPathValue,
    fileName: path.basename(realPathValue),
    sizeBytes: fileStat.size,
  };
}

function parseTaggedError(error: unknown): RpcResponse | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("BAD_REQUEST:")) {
    return rpcError("BAD_REQUEST", message.slice("BAD_REQUEST:".length));
  }
  if (message.startsWith("FORBIDDEN_PATH:")) {
    return rpcError("FORBIDDEN_PATH", message.slice("FORBIDDEN_PATH:".length));
  }
  if (message.startsWith("PAYLOAD_TOO_LARGE:")) {
    return rpcError("PAYLOAD_TOO_LARGE", message.slice("PAYLOAD_TOO_LARGE:".length));
  }
  if (message.startsWith("UNSUPPORTED_MEDIA:")) {
    return rpcError("UNSUPPORTED_MEDIA", message.slice("UNSUPPORTED_MEDIA:".length));
  }
  return null;
}

async function handleRequest(request: RpcRequest, options: JobRpcServerOptions): Promise<RpcResponse> {
  const rawOp = readString(request.op);
  if (!rawOp) {
    return rpcError("BAD_REQUEST", "Missing operation.");
  }

  // Backwards compatibility: map old task operations to new job operations
  const operationAliases: Record<string, string> = {
    "tasks.list": "jobs.list",
    "tasks.inspect": "jobs.inspect",
    "tasks.create": "jobs.create",
    "tasks.cancel": "jobs.cancel",
    "tasks.retry": "jobs.retry",
  };
  const op = operationAliases[rawOp] || rawOp;
  const args = request.args ?? {};

  if (op === "jobs.list") {
    const limitRaw = readNumber(args.limit);
    const limit = limitRaw && limitRaw > 0 ? Math.floor(limitRaw) : 20;
    const active = options.stateStore.getActiveBackgroundJobs(limit);
    const statusFilter = Array.isArray(args.status)
      ? args.status.filter((item): item is string => typeof item === "string")
      : [];
    const jobs = (statusFilter.length > 0 ? active.filter((job) => statusFilter.includes(job.status)) : active).map((job) => ({
      taskId: job.taskId,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt,
      runAt: job.runAt,
      requestPreview: job.requestPreview,
    }));
    return rpcOk({ tasks: jobs }); // Keep "tasks" key for backwards compatibility
  }

  if (op === "jobs.inspect") {
    const jobId = readString(args.taskId);
    if (!jobId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }
    const job = options.stateStore.getBackgroundJob(jobId);
    if (!job) {
      return rpcError("NOT_FOUND", `Job non trovato: ${jobId}`);
    }
    return rpcOk(job);
  }

  if (op === "jobs.create") {
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
    const jobId = `dl-rpc-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const requestPreview = readString(args.requestPreview) ?? prompt;
    options.stateStore.createScheduledJob({
      jobId,
      updateId: 0,
      userId,
      chatId,
      command: "rpc_create",
      prompt,
      requestPreview,
      runAt: runAtIso,
    });
    return rpcOk({ taskId: jobId, status: "scheduled", runAtIso: new Date(runAtMs).toISOString() });
  }

  if (op === "jobs.cancel") {
    const jobId = readString(args.taskId);
    if (!jobId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }
    const result = options.stateStore.cancelJob(jobId);
    if (result === "not_found") {
      return rpcError("NOT_FOUND", `Job non trovato: ${jobId}`);
    }
    if (result === "already_done") {
      return rpcError("INVALID_STATE", `Job ${jobId} non cancellabile (gia completato/fallito).`);
    }
    return rpcOk({ status: "canceled", taskId: jobId });
  }

  if (op === "jobs.retry") {
    const jobId = readString(args.taskId);
    if (!jobId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }
    const job = options.stateStore.getBackgroundJob(jobId);
    if (!job) {
      return rpcError("NOT_FOUND", `Job non trovato: ${jobId}`);
    }
    if (!["completed_pending_delivery", "failed_pending_delivery"].includes(job.status)) {
      return rpcError("INVALID_STATE", `Job ${jobId} non ritentabile nello stato ${job.status}.`);
    }
    const message = await options.retryJobDelivery(jobId);
    return rpcOk({ taskId: jobId, message });
  }

  // Recurring jobs operations
  if (op === "jobs.create-recurring") {
    const runAtIso = readString(args.runAtIso);
    const prompt = readString(args.prompt);
    const userId = readNumber(args.userId);
    const chatId = readNumber(args.chatId);
    const recurrenceType = readString(args.recurrenceType);
    const recurrenceExpression = readString(args.recurrenceExpression);

    if (!runAtIso || !prompt || userId === null || chatId === null || !recurrenceType || !recurrenceExpression) {
      return rpcError("BAD_REQUEST", "runAtIso, prompt, userId, chatId, recurrenceType, recurrenceExpression are required.");
    }

    if (recurrenceType !== "interval" && recurrenceType !== "cron") {
      return rpcError("BAD_REQUEST", "recurrenceType must be 'interval' or 'cron'.");
    }

    const runAtMs = Date.parse(runAtIso);
    if (Number.isNaN(runAtMs) || runAtMs <= Date.now()) {
      return rpcError("INVALID_TIME", "runAtIso must be a future ISO timestamp.");
    }

    const maxRuns = readNumber(args.maxRuns) ?? undefined;

    const jobId = `rc-rpc-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const requestPreview = readString(args.requestPreview) ?? prompt;

    options.stateStore.createRecurringJob({
      jobId,
      updateId: 0,
      userId,
      chatId,
      command: "rpc_create_recurring",
      prompt,
      requestPreview,
      runAt: runAtIso,
      recurrenceType: recurrenceType as "interval" | "cron",
      recurrenceExpression,
      maxRuns,
    });

    return rpcOk({
      taskId: jobId,
      kind: "recurring",
      status: "scheduled",
      runAtIso: new Date(runAtMs).toISOString(),
      recurrenceType,
      recurrenceExpression,
    });
  }

  if (op === "jobs.pause") {
    const jobId = readString(args.taskId);
    if (!jobId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }

    const job = options.stateStore.getBackgroundJob(jobId);
    if (!job) {
      return rpcError("NOT_FOUND", `Job non trovato: ${jobId}`);
    }
    if (job.kind !== "recurring") {
      return rpcError("INVALID_STATE", `Job ${jobId} non è recurring (kind: ${job.kind}).`);
    }

    const success = options.stateStore.pauseRecurringJob(jobId);
    if (!success) {
      return rpcError("INTERNAL", `Failed to pause job ${jobId}.`);
    }

    return rpcOk({ status: "paused", taskId: jobId });
  }

  if (op === "jobs.resume") {
    const jobId = readString(args.taskId);
    if (!jobId) {
      return rpcError("BAD_REQUEST", "taskId is required.");
    }

    const job = options.stateStore.getBackgroundJob(jobId);
    if (!job) {
      return rpcError("NOT_FOUND", `Job non trovato: ${jobId}`);
    }
    if (job.kind !== "recurring") {
      return rpcError("INVALID_STATE", `Job ${jobId} non è recurring (kind: ${job.kind}).`);
    }

    const success = options.stateStore.resumeRecurringJob(jobId);
    if (!success) {
      return rpcError("INTERNAL", `Failed to resume job ${jobId}.`);
    }

    return rpcOk({ status: "resumed", taskId: jobId });
  }

  if (op === "jobs.list-recurring") {
    const limitRaw = readNumber(args.limit);
    const limit = limitRaw && limitRaw > 0 ? Math.floor(limitRaw) : 20;
    const recurringJobs = options.stateStore.getRecurringJobs(limit);

    const jobs = recurringJobs.map((job) => ({
      taskId: job.taskId,
      status: job.status,
      recurrenceType: job.recurrenceType,
      recurrenceExpression: job.recurrenceExpression,
      recurrenceRunCount: job.recurrenceRunCount,
      recurrenceMaxRuns: job.recurrenceMaxRuns,
      recurrenceEnabled: job.recurrenceEnabled,
      nextRunAt: job.runAt,
      createdAt: job.createdAt,
      requestPreview: job.requestPreview,
    }));

    return rpcOk({ jobs });
  }

  if (op === "jobs.update-recurrence") {
    const jobId = readString(args.taskId);
    const expression = readString(args.expression);

    if (!jobId || !expression) {
      return rpcError("BAD_REQUEST", "taskId and expression are required.");
    }

    const job = options.stateStore.getBackgroundJob(jobId);
    if (!job) {
      return rpcError("NOT_FOUND", `Job non trovato: ${jobId}`);
    }
    if (job.kind !== "recurring") {
      return rpcError("INVALID_STATE", `Job ${jobId} non è recurring (kind: ${job.kind}).`);
    }

    const success = options.stateStore.updateRecurrenceExpression(jobId, expression);
    if (!success) {
      return rpcError("INTERNAL", `Failed to update recurrence expression for job ${jobId}.`);
    }

    return rpcOk({ taskId: jobId, expression });
  }

  if (op === "status.get") {
    if (!options.getStatus) {
      return rpcError("BAD_REQUEST", "Status not available.");
    }
    const status = await options.getStatus();
    return rpcOk(status);
  }

  if (op === "telegram.sendMessage") {
    const telegram = options.telegram;
    if (!telegram) {
      return rpcError("BAD_REQUEST", "Telegram operations are not available.");
    }
    const text = readString(args.text);
    if (!text) {
      return rpcError("BAD_REQUEST", "text is required and must not be empty.");
    }
    if (text.length > 4000) {
      return rpcError("PAYLOAD_TOO_LARGE", `text exceeds 4000 characters (got ${text.length})`);
    }
    const chatId = telegram.getAuthorizedChatId();
    if (chatId === null) {
      return rpcError("NOT_FOUND", "No authorized chat configured.");
    }
    try {
      await telegram.sendMessage(chatId, text);
      // Register message in recent conversations
      const preview = text.length > 120 ? `${text.slice(0, 117)}...` : text;
      await telegram.recordMessage("assistant", `text: ${preview}`);
      return rpcOk({ sent: true, chatId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return rpcError("INTERNAL", `Failed to send telegram message: ${message}`);
    }
  }

  if (op === "telegram.sendPhoto" || op === "telegram.sendAudio" || op === "telegram.sendDocument") {
    const media = options.media;
    if (!media) {
      return rpcError("BAD_REQUEST", "Telegram media operations are not available.");
    }
    const inputPath = readString(args.path);
    if (!inputPath) {
      return rpcError("BAD_REQUEST", "path is required.");
    }
    const chatId = media.getAuthorizedChatId();
    if (chatId === null) {
      return rpcError("INVALID_STATE", "No authorized Telegram chat available.");
    }

    try {
      const resolved = await resolveRpcMediaFile({
        dataRootRealPath: media.dataRootRealPath,
        inputPath,
        maxBytes: op === "telegram.sendPhoto"
          ? media.maxPhotoBytes
          : op === "telegram.sendAudio"
            ? media.maxAudioBytes
            : media.maxDocumentBytes,
      });
      const fileBlob = Bun.file(resolved.realPath);
      const method = op === "telegram.sendPhoto" ? "sendPhoto" : op === "telegram.sendAudio" ? "sendAudio" : "sendDocument";
      const telegramMessageId = await (async () => {
        if (op === "telegram.sendPhoto") {
          return await media.sendPhoto(chatId, fileBlob, resolved.fileName);
        }
        if (op === "telegram.sendAudio") {
          return await media.sendAudio(chatId, fileBlob, resolved.fileName);
        }
        return await media.sendDocument(chatId, fileBlob, resolved.fileName);
      })();
      return rpcOk({
        method,
        path: resolved.realPath,
        telegramMessageId,
        sizeBytes: resolved.sizeBytes,
      });
    } catch (error) {
      const tagged = parseTaggedError(error);
      if (tagged) {
        return tagged;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        return rpcError("NOT_FOUND", `File non trovato: ${inputPath}`);
      }
      return rpcError("INTERNAL", message);
    }
  }

  // State operations
  if (op === "state.get") {
    const key = readString(args.key);
    if (!key) {
      return rpcError("BAD_REQUEST", "key is required and must not be empty.");
    }
    const value = options.stateStore.getRuntimeValue(key);
    if (value === null) {
      return rpcError("NOT_FOUND", `Key not found: ${key}`);
    }
    return rpcOk({ key, value });
  }

  if (op === "state.set") {
    const key = readString(args.key);
    const value = readString(args.value);
    if (!key || value === null) {
      return rpcError("BAD_REQUEST", "key and value are required and must not be empty.");
    }
    options.stateStore.setRuntimeValue(key, value);
    return rpcOk({ key, value });
  }

  if (op === "state.delete") {
    const keys = Array.isArray(args.keys)
      ? args.keys.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (keys.length === 0) {
      return rpcError("BAD_REQUEST", "keys array is required and must not be empty.");
    }
    options.stateStore.clearRuntimeValues(keys);
    return rpcOk({ deleted: keys.length });
  }

  if (op === "state.list") {
    const pattern = readString(args.pattern) ?? undefined;
    const entries = options.stateStore.getAllRuntimeKeys(pattern);
    return rpcOk({ entries });
  }

  // Conversation operations
  if (op === "conversation.clear") {
    const userId = readNumber(args.userId);
    if (userId === null) {
      return rpcError("BAD_REQUEST", "userId is required.");
    }
    const statsBefore = options.stateStore.getConversationStats(userId);
    options.stateStore.clearConversation(userId);
    return rpcOk({ deleted: statsBefore.entries, userId });
  }

  if (op === "conversation.list") {
    const userId = readNumber(args.userId);
    if (userId === null) {
      return rpcError("BAD_REQUEST", "userId is required.");
    }
    const limitRaw = readNumber(args.limit);
    const limit = limitRaw && limitRaw > 0 ? Math.floor(limitRaw) : 12;
    const entries = options.stateStore.getConversation(userId, limit);
    return rpcOk({ entries, userId, count: entries.length });
  }

  if (op === "conversation.export") {
    const userId = readNumber(args.userId);
    if (userId === null) {
      return rpcError("BAD_REQUEST", "userId is required.");
    }
    const limitRaw = readNumber(args.limit);
    const limit = limitRaw && limitRaw > 0 ? Math.floor(limitRaw) : 1000;
    const entries = options.stateStore.getConversationWithTimestamps(userId, limit);
    const stats = options.stateStore.getConversationStats(userId);
    return rpcOk({ entries, stats, userId });
  }

  if (op === "conversation.stats") {
    const userId = readNumber(args.userId);
    if (userId === null) {
      return rpcError("BAD_REQUEST", "userId is required.");
    }
    const stats = options.stateStore.getConversationStats(userId);
    return rpcOk({ ...stats, userId });
  }

  // Memory operations
  if (op === "memory.add") {
    const id = readString(args.id);
    const type = readString(args.type);
    const data = readString(args.data);
    if (!id || !type || !data) {
      return rpcError("BAD_REQUEST", "id, type, and data are required.");
    }
    if (type !== "preference" && type !== "fact" && type !== "pattern") {
      return rpcError("BAD_REQUEST", "type must be 'preference', 'fact', or 'pattern'.");
    }
    options.stateStore.setRuntimeValue(`memory:${type}:${id}`, data);
    return rpcOk({ memoryId: id, type });
  }

  if (op === "memory.get") {
    const id = readString(args.id);
    const type = readString(args.type);
    if (!id || !type) {
      return rpcError("BAD_REQUEST", "id and type are required.");
    }
    const value = options.stateStore.getRuntimeValue(`memory:${type}:${id}`);
    if (value === null) {
      return rpcError("NOT_FOUND", `Memory not found: ${type}:${id}`);
    }
    return rpcOk({ id, type, data: value });
  }

  if (op === "memory.list") {
    const type = readString(args.type) ?? undefined;
    const pattern = type ? `memory:${type}:*` : "memory:*";
    const entries = options.stateStore.getAllRuntimeKeys(pattern);
    const memories = entries.map((entry) => {
      const parts = entry.key.split(":");
      return {
        id: parts[2] ?? "",
        type: parts[1] ?? "",
        data: entry.value,
        updatedAt: entry.updatedAt,
      };
    });
    return rpcOk({ memories });
  }

  if (op === "memory.search") {
    const query = readString(args.query);
    if (!query) {
      return rpcError("BAD_REQUEST", "query is required.");
    }
    const entries = options.stateStore.getAllRuntimeKeys("memory:*");
    const lowerQuery = query.toLowerCase();
    const matches = entries
      .filter((entry) => {
        try {
          const memoryData = JSON.parse(entry.value);
          const content = (memoryData.content ?? "").toLowerCase();
          const tags = Array.isArray(memoryData.tags) ? memoryData.tags.join(" ").toLowerCase() : "";
          return content.includes(lowerQuery) || tags.includes(lowerQuery);
        } catch {
          return false;
        }
      })
      .map((entry) => {
        const parts = entry.key.split(":");
        return {
          id: parts[2] ?? "",
          type: parts[1] ?? "",
          data: entry.value,
          updatedAt: entry.updatedAt,
        };
      });
    return rpcOk({ matches, query });
  }

  if (op === "memory.delete") {
    const id = readString(args.id);
    const type = readString(args.type);
    if (!id || !type) {
      return rpcError("BAD_REQUEST", "id and type are required.");
    }
    const key = `memory:${type}:${id}`;
    const exists = options.stateStore.getRuntimeValue(key);
    if (exists === null) {
      return rpcError("NOT_FOUND", `Memory not found: ${type}:${id}`);
    }
    options.stateStore.clearRuntimeValues([key]);
    return rpcOk({ deleted: true, id, type });
  }

  if (op === "memory.sync") {
    // This operation will be handled by CLI script that generates MEMORY.md
    // RPC just confirms the operation is available
    return rpcOk({ synced: true, message: "Use memory sync command to regenerate MEMORY.md" });
  }

  return rpcError("BAD_REQUEST", `Unknown operation: ${op}`);
}

function attachConnection(socket: Socket, options: JobRpcServerOptions): void {
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

export async function startJobRpcServer(options: JobRpcServerOptions): Promise<JobRpcServerHandle> {
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
