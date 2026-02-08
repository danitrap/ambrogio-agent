import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
});
