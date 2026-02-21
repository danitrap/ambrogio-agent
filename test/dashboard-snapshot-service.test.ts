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

    await writeFile(
      path.join(dataRoot, "TODO.md"),
      ["# TODO", "## Backlog", "- [ ] Open item", "## Fatto", "- [x] Done item"].join("\n"),
    );
    await writeFile(
      path.join(dataRoot, "groceries.md"),
      ["# Groceries", "## To Buy", "- Apples", "## Fuori rotazione", "- Chips", "## In Pantry", "- Rice"].join("\n"),
    );

    const service = createDashboardSnapshotService({ stateStore: store, dataRoot });
    const snapshot = await service.getSnapshot();

    expect(snapshot.jobs.map((job) => job.id).sort()).toEqual(["dl-future", "rc-future"]);
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

    store.close();
  });
});
