import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/runtime/state-store";

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

describe("StateStore", () => {
  test("persists recent messages and runtime values across reopen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "state-store-"));
    tempDirs.push(root);

    const storeA = await StateStore.open(root);
    storeA.setRuntimeValue("heartbeat_last_result", "ok");
    storeA.appendRecentMessage("user", "ciao", "2026-02-08T10:00:00.000Z", 50);
    storeA.appendRecentMessage("assistant", "ciao a te", "2026-02-08T10:00:01.000Z", 50);
    storeA.close();

    const storeB = await StateStore.open(root);
    expect(storeB.getRuntimeValue("heartbeat_last_result")).toBe("ok");
    const recent = storeB.getRecentMessages(5);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toEqual({
      createdAt: "2026-02-08T10:00:00.000Z",
      role: "user",
      summary: "ciao",
    });
    expect(recent[1]).toEqual({
      createdAt: "2026-02-08T10:00:01.000Z",
      role: "assistant",
      summary: "ciao a te",
    });
    storeB.close();
  });

  test("persists conversation memory across reopen with retention", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "state-store-"));
    tempDirs.push(root);

    const storeA = await StateStore.open(root);
    for (let i = 1; i <= 14; i += 1) {
      storeA.appendConversationTurn(1, i % 2 === 0 ? "assistant" : "user", `m-${i}`, 12);
    }
    storeA.close();

    const storeB = await StateStore.open(root);
    const conversation = storeB.getConversation(1, 20);
    expect(conversation).toHaveLength(12);
    expect(conversation[0]).toEqual({ role: "user", text: "m-3" });
    expect(conversation[11]).toEqual({ role: "assistant", text: "m-14" });

    const stats = storeB.getConversationStats(1);
    expect(stats).toEqual({
      entries: 12,
      userTurns: 6,
      assistantTurns: 6,
      hasContext: true,
    });
    storeB.close();
  });

  test("stores and updates background task delivery state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "state-store-"));
    tempDirs.push(root);

    const storeA = await StateStore.open(root);
    storeA.createBackgroundTask({
      taskId: "bg-1",
      updateId: 101,
      userId: 202,
      chatId: 303,
      command: "retry",
      requestPreview: "long-running task",
    });
    const activeRunning = storeA.getActiveBackgroundTasks(10);
    expect(activeRunning).toHaveLength(1);
    expect(activeRunning[0]?.status).toBe("running");
    storeA.markBackgroundTaskCompleted("bg-1", "<response_mode>text</response_mode>\ncompleted");
    expect(storeA.countPendingBackgroundTasks()).toBe(1);
    storeA.close();

    const storeB = await StateStore.open(root);
    const pending = storeB.getPendingBackgroundTasks(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.taskId).toBe("bg-1");
    expect(pending[0]?.status).toBe("completed_pending_delivery");
    expect(pending[0]?.deliveryText).toContain("completed");
    storeB.markBackgroundTaskDelivered("bg-1");
    expect(storeB.countPendingBackgroundTasks()).toBe(0);
    storeB.close();
  });
});
