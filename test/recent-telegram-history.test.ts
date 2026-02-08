import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  appendRecentTelegramMessage,
  clearRecentTelegramMessages,
  loadRecentTelegramMessages,
} from "../src/runtime/recent-telegram-history";

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

describe("recent telegram history", () => {
  test("returns empty list when history file does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-test-"));
    tempDirs.push(root);

    const history = await loadRecentTelegramMessages(root);
    expect(history).toEqual([]);
  });

  test("persists messages and keeps only the latest 50", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-test-"));
    tempDirs.push(root);

    for (let i = 1; i <= 55; i += 1) {
      await appendRecentTelegramMessage(root, `msg-${i}`);
    }

    const history = await loadRecentTelegramMessages(root);
    expect(history).toHaveLength(50);
    expect(history[0]).toBe("msg-6");
    expect(history[49]).toBe("msg-55");
  });

  test("ignores invalid persisted content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-test-"));
    tempDirs.push(root);

    await Bun.write(path.join(root, "runtime", "recent-telegram-messages.json"), "{invalid json");

    const history = await loadRecentTelegramMessages(root);
    expect(history).toEqual([]);
  });

  test("clear removes persisted history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-test-"));
    tempDirs.push(root);

    await appendRecentTelegramMessage(root, "msg-1");
    await appendRecentTelegramMessage(root, "msg-2");
    await clearRecentTelegramMessages(root);

    const history = await loadRecentTelegramMessages(root);
    expect(history).toEqual([]);
  });
});
