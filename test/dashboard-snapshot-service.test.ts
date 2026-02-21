import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDashboardSnapshotService } from "../src/dashboard/snapshot-service";
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

describe("createDashboardSnapshotService", () => {
  test("returns calendar jobs and kanban data from sqlite + markdown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-snapshot-"));
    tempDirs.push(root);

    const dataRoot = path.join(root, "data");
    await mkdir(dataRoot, { recursive: true });

    const store = await StateStore.open(dataRoot);
    const now = Date.now();
    const future = new Date(now + 3600_000).toISOString();
    const past = new Date(now - 3600_000).toISOString();

    store.createDelayedJob({
      jobId: "dl-future",
      updateId: 1,
      userId: 1,
      chatId: 1,
      prompt: "future delayed",
      requestPreview: "future delayed",
      runAt: future,
    });
    store.createDelayedJob({
      jobId: "dl-past",
      updateId: 1,
      userId: 1,
      chatId: 1,
      prompt: "past delayed",
      requestPreview: "past delayed",
      runAt: past,
    });
    store.createRecurringJob({
      jobId: "rc-future",
      updateId: 1,
      userId: 1,
      chatId: 1,
      prompt: "future recurring",
      requestPreview: "future recurring",
      runAt: future,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
    });
    store.createRecurringJob({
      jobId: "rc-paused",
      updateId: 1,
      userId: 1,
      chatId: 1,
      prompt: "paused recurring",
      requestPreview: "paused recurring",
      runAt: future,
      recurrenceType: "interval",
      recurrenceExpression: "2h",
    });
    store.pauseRecurringJob("rc-paused");
    store.setRuntimeValue("heartbeat_last_run_at", new Date(now - 95 * 60_000).toISOString());
    store.setRuntimeValue("heartbeat_last_result", "completed");
    store.setRuntimeValue("memory:fact:abc123", "{\"id\":\"abc123\",\"type\":\"fact\",\"content\":\"likes espresso\"}");
    store.setRuntimeValue("notes:entry:n1", "{\"id\":\"n1\",\"type\":\"project\",\"title\":\"Dash\",\"body\":\"todo\"}");
    store.setRuntimeValue("fetch-url:cache:aaa", "{\"timestamp\":\"2026-02-21T09:00:00Z\"}");
    store.setRuntimeValue("tts:audio:bbb", "{\"timestamp\":\"2026-02-21T09:00:00Z\"}");
    store.setRuntimeValue("atm-tram-schedule:cache:ccc", "{\"timestamp\":\"2026-02-21T09:00:00Z\"}");
    store.setRuntimeValue("atm-tram-schedule:gtfs:timestamp", "2026-02-21T09:00:00Z");
    store.createDelayedJob({
      jobId: "dl-running",
      updateId: 1,
      userId: 1,
      chatId: 1,
      prompt: "running delayed",
      requestPreview: "running delayed",
      runAt: future,
    });
    store.claimScheduledJob("dl-running");
    store.createDelayedJob({
      jobId: "dl-failed-pending",
      updateId: 1,
      userId: 1,
      chatId: 1,
      prompt: "failed delayed",
      requestPreview: "failed delayed",
      runAt: future,
    });
    store.claimScheduledJob("dl-failed-pending");
    store.markBackgroundJobFailed("dl-failed-pending", "send failed", "delivery failed");

    await writeFile(
      path.join(dataRoot, "TODO.md"),
      ["# TODO", "## Backlog", "- [ ] Open item", "## Fatto", "- [x] Done item"].join("\n"),
    );
    await writeFile(
      path.join(dataRoot, "groceries.md"),
      ["# Groceries", "## To Buy", "- Apples", "## Fuori rotazione", "- Chips", "## In Pantry", "- Rice"].join("\n"),
    );
    await writeFile(path.join(dataRoot, "MEMORY.md"), "# Memory\n\n- likes espresso\n");
    await writeFile(path.join(dataRoot, "NOTES.md"), "# Structured Notes\n\n## Project Notes\n\n### Dash\n");

    const service = createDashboardSnapshotService({ stateStore: store, dataRoot });
    const snapshot = await service.getSnapshot();

    expect(snapshot.jobs.map((job) => job.id).sort()).toEqual(["dl-future", "rc-future"]);
    expect(snapshot.health.heartbeat.status).toBe("warn");
    expect(snapshot.health.errors.failedPendingDelivery).toBe(1);
    expect(snapshot.health.errors.total).toBe(1);
    expect(snapshot.health.pending.scheduled).toBe(3);
    expect(snapshot.health.pending.running).toBe(1);
    expect(snapshot.health.pending.pendingDelivery).toBe(1);
    expect(snapshot.health.pending.total).toBe(5);
    expect(snapshot.health.uptime.seconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.health.uptime.human.length).toBeGreaterThan(0);
    expect(snapshot.todo.columns.map((column) => column.title)).toEqual(["Backlog", "Fatto"]);
    expect(snapshot.todo.columns[0]?.items.map((item) => item.text)).toEqual(["Open item"]);
    expect(snapshot.todo.columns[1]?.items.map((item) => item.text)).toEqual(["Done item"]);
    expect(snapshot.groceries.columns.map((column) => column.title)).toEqual([
      "To Buy",
      "Fuori rotazione",
      "In Pantry",
    ]);
    expect(snapshot.groceries.columns[0]?.items.map((item) => item.text)).toEqual(["Apples"]);
    expect(snapshot.groceries.columns[1]?.items.map((item) => item.text)).toEqual(["Chips"]);
    expect(snapshot.groceries.columns[2]?.items.map((item) => item.text)).toEqual(["Rice"]);
    expect(snapshot.knowledge.memory.exists).toBe(true);
    expect(snapshot.knowledge.notes.exists).toBe(true);
    expect(snapshot.knowledge.memory.previewLines[0]).toBe("# Memory");
    expect(snapshot.knowledge.notes.previewLines[0]).toBe("# Structured Notes");
    expect(snapshot.knowledge.stateCounts.memoryEntries).toBe(1);
    expect(snapshot.knowledge.stateCounts.notesEntries).toBe(1);
    expect(snapshot.skillState.fetchUrlCacheEntries).toBe(1);
    expect(snapshot.skillState.ttsAudioCacheEntries).toBe(1);
    expect(snapshot.skillState.atmTramScheduleCacheEntries).toBe(1);
    expect(snapshot.skillState.atmTramScheduleGtfsTimestampPresent).toBe(true);

    store.close();
  });
});
