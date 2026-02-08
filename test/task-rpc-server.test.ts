import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { StateStore } from "../src/runtime/state-store";
import { startTaskRpcServer } from "../src/runtime/task-rpc-server";

type RpcResponse = {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

async function rpcCall(socketPath: string, request: unknown): Promise<RpcResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
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
        reject(new Error("empty response"));
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

describe("TaskRpcServer", () => {
  test("lists active tasks and supports inspect/create/cancel/retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "task-rpc-"));
    tempDirs.push(root);

    const stateStore = await StateStore.open(root);
    const retried: string[] = [];
    const socketPath = path.join(root, "runtime", "ambrogio.sock");

    const server = await startTaskRpcServer({
      socketPath,
      stateStore,
      retryTaskDelivery: async (taskId) => {
        retried.push(taskId);
        return `retried:${taskId}`;
      },
    });

    const emptyList = await rpcCall(socketPath, { op: "tasks.list", args: { limit: 10 } });
    expect(emptyList.ok).toBe(true);
    expect(emptyList.result).toEqual({ tasks: [] });

    const create = await rpcCall(socketPath, {
      op: "tasks.create",
      args: {
        runAtIso: "2099-01-01T10:00:00.000Z",
        prompt: "send hello",
        requestPreview: "send hello",
        userId: 1,
        chatId: 2,
      },
    });
    expect(create.ok).toBe(true);
    const createdTaskId = (create.result as { taskId: string }).taskId;
    expect(createdTaskId.startsWith("dl-rpc-")).toBe(true);

    const listed = await rpcCall(socketPath, { op: "tasks.list", args: { limit: 10 } });
    expect(listed.ok).toBe(true);
    const tasks = (listed.result as { tasks: Array<{ taskId: string; status: string }> }).tasks;
    expect(tasks.some((task) => task.taskId === createdTaskId && task.status === "scheduled")).toBe(true);

    const inspect = await rpcCall(socketPath, { op: "tasks.inspect", args: { taskId: createdTaskId } });
    expect(inspect.ok).toBe(true);
    expect((inspect.result as { taskId: string }).taskId).toBe(createdTaskId);

    const cancel = await rpcCall(socketPath, { op: "tasks.cancel", args: { taskId: createdTaskId } });
    expect(cancel).toEqual({ ok: true, result: { status: "canceled", taskId: createdTaskId } });

    stateStore.createBackgroundTask({
      taskId: "bg-rpc-1",
      updateId: 10,
      userId: 1,
      chatId: 2,
      requestPreview: "bg",
      command: "rpc",
    });
    expect(stateStore.markBackgroundTaskCompleted("bg-rpc-1", "done")).toBe(true);

    const retry = await rpcCall(socketPath, { op: "tasks.retry", args: { taskId: "bg-rpc-1" } });
    expect(retry).toEqual({ ok: true, result: { message: "retried:bg-rpc-1", taskId: "bg-rpc-1" } });
    expect(retried).toEqual(["bg-rpc-1"]);

    await server.close();
    stateStore.close();
  });

  test("status.get returns runtime status when getStatus is provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "task-rpc-"));
    tempDirs.push(root);

    const stateStore = await StateStore.open(root);
    const socketPath = path.join(root, "runtime", "ambrogio-status.sock");
    const statusData = { now: "2026-02-08T10:00:00.000Z", uptime: "1h", handledMessages: 5 };

    const server = await startTaskRpcServer({
      socketPath,
      stateStore,
      retryTaskDelivery: async () => "ok",
      getStatus: async () => statusData,
    });

    const response = await rpcCall(socketPath, { op: "status.get" });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual(statusData);

    await server.close();
    stateStore.close();
  });

  test("status.get returns error when getStatus is not provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "task-rpc-"));
    tempDirs.push(root);

    const stateStore = await StateStore.open(root);
    const socketPath = path.join(root, "runtime", "ambrogio-nostatus.sock");

    const server = await startTaskRpcServer({
      socketPath,
      stateStore,
      retryTaskDelivery: async () => "ok",
    });

    const response = await rpcCall(socketPath, { op: "status.get" });
    expect(response.ok).toBe(false);
    expect(response.error).toEqual({ code: "BAD_REQUEST", message: "Status not available." });

    await server.close();
    stateStore.close();
  });

  test("returns structured errors for invalid input and not found", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "task-rpc-"));
    tempDirs.push(root);

    const stateStore = await StateStore.open(root);
    const socketPath = path.join(root, "runtime", "ambrogio.sock");
    const server = await startTaskRpcServer({
      socketPath,
      stateStore,
      retryTaskDelivery: async () => "ok",
    });

    const badOp = await rpcCall(socketPath, { op: "tasks.unknown", args: {} });
    expect(badOp).toEqual({
      ok: false,
      error: { code: "BAD_REQUEST", message: "Unknown operation: tasks.unknown" },
    });

    const badTime = await rpcCall(socketPath, {
      op: "tasks.create",
      args: {
        runAtIso: "2020-01-01T00:00:00.000Z",
        prompt: "late",
        userId: 1,
        chatId: 2,
      },
    });
    expect(badTime).toEqual({
      ok: false,
      error: { code: "INVALID_TIME", message: "runAtIso must be a future ISO timestamp." },
    });

    const notFound = await rpcCall(socketPath, { op: "tasks.inspect", args: { taskId: "missing" } });
    expect(notFound).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Task non trovato: missing" },
    });

    await server.close();
    stateStore.close();
  });

  test("supports telegram media rpc with path and size enforcement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "task-rpc-media-"));
    tempDirs.push(root);
    const dataRoot = path.join(root, "data");
    const mediaDir = path.join(dataRoot, "generated");
    await mkdir(mediaDir, { recursive: true });
    const dataRootRealPath = await realpath(dataRoot);
    await writeFile(path.join(mediaDir, "photo.png"), "image-bytes");
    await writeFile(path.join(mediaDir, "audio.mp3"), "audio-bytes");
    await writeFile(path.join(mediaDir, "doc.pdf"), "pdf-bytes");

    const stateStore = await StateStore.open(root);
    const socketPath = path.join(root, "runtime", "ambrogio-media.sock");
    const calls: Array<{ method: string; chatId: number; fileName: string }> = [];
    const server = await startTaskRpcServer({
      socketPath,
      stateStore,
      retryTaskDelivery: async () => "ok",
      media: {
        dataRootRealPath,
        getAuthorizedChatId: () => 99,
        maxPhotoBytes: 1000,
        maxAudioBytes: 1000,
        maxDocumentBytes: 10,
        sendPhoto: async (chatId, _blob, fileName) => {
          calls.push({ method: "sendPhoto", chatId, fileName });
          return 1;
        },
        sendAudio: async (chatId, _blob, fileName) => {
          calls.push({ method: "sendAudio", chatId, fileName });
          return 2;
        },
        sendDocument: async (chatId, _blob, fileName) => {
          calls.push({ method: "sendDocument", chatId, fileName });
          return 3;
        },
      },
    });

    const sendPhoto = await rpcCall(socketPath, {
      op: "telegram.sendPhoto",
      args: { path: path.join(mediaDir, "photo.png") },
    });
    const photoRealPath = await realpath(path.join(mediaDir, "photo.png"));
    expect(sendPhoto).toEqual({
      ok: true,
      result: {
        method: "sendPhoto",
        path: photoRealPath,
        telegramMessageId: 1,
        sizeBytes: "image-bytes".length,
      },
    });

    const sendAudio = await rpcCall(socketPath, {
      op: "telegram.sendAudio",
      args: { path: path.join(mediaDir, "audio.mp3") },
    });
    const audioRealPath = await realpath(path.join(mediaDir, "audio.mp3"));
    expect(sendAudio).toEqual({
      ok: true,
      result: {
        method: "sendAudio",
        path: audioRealPath,
        telegramMessageId: 2,
        sizeBytes: "audio-bytes".length,
      },
    });

    const sendDocument = await rpcCall(socketPath, {
      op: "telegram.sendDocument",
      args: { path: path.join(mediaDir, "doc.pdf") },
    });
    const documentRealPath = await realpath(path.join(mediaDir, "doc.pdf"));
    expect(sendDocument).toEqual({
      ok: true,
      result: {
        method: "sendDocument",
        path: documentRealPath,
        telegramMessageId: 3,
        sizeBytes: "pdf-bytes".length,
      },
    });

    expect(calls).toEqual([
      { method: "sendPhoto", chatId: 99, fileName: "photo.png" },
      { method: "sendAudio", chatId: 99, fileName: "audio.mp3" },
      { method: "sendDocument", chatId: 99, fileName: "doc.pdf" },
    ]);

    const outsidePath = path.join(root, "outside.txt");
    await writeFile(outsidePath, "x");
    const forbidden = await rpcCall(socketPath, {
      op: "telegram.sendDocument",
      args: { path: outsidePath },
    });
    expect(forbidden).toEqual({
      ok: false,
      error: { code: "FORBIDDEN_PATH", message: "path must be under /data." },
    });

    await writeFile(path.join(mediaDir, "big.bin"), "12345678901");
    const oversized = await rpcCall(socketPath, {
      op: "telegram.sendDocument",
      args: { path: path.join(mediaDir, "big.bin") },
    });
    expect(oversized).toEqual({
      ok: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "file exceeds limit (11 bytes)." },
    });

    await server.close();
    stateStore.close();
  });
});
