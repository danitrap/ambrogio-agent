import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { StateStore } from "../src/runtime/state-store";

const TEST_RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
const TEST_DB_DIR = `/tmp/ambrogio-test-muted-${TEST_RUN_ID}`;

describe("Muted Job Execution", () => {
  let stateStore: StateStore;

  beforeEach(async () => {
    try {
      await rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    stateStore = await StateStore.open(TEST_DB_DIR);
  });

  afterEach(async () => {
    stateStore.close();
    try {
      await rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  test("should detect when job is currently muted", () => {
    const taskId = "dl-mute-check-1";
    const runAt = new Date(Date.now() - 1000).toISOString(); // Past (due now)
    const mutedUntil = new Date(Date.now() + 3600000).toISOString(); // Future (muted)

    stateStore.createDelayedJob({
      jobId: taskId,
      updateId: 1,
      userId: 123,
      chatId: 123,
      prompt: "Test muted execution",
      requestPreview: "Test muted execution",
      runAt,
      mutedUntil,
    });

    const job = stateStore.getBackgroundJob(taskId);
    expect(job).not.toBeNull();

    // Check if job should be muted
    const shouldSkipDueToMute = (j: NonNullable<ReturnType<typeof stateStore.getBackgroundJob>>): boolean => {
      if (!j.mutedUntil) return false;
      const mutedUntilDate = new Date(j.mutedUntil);
      const now = new Date();
      return mutedUntilDate > now;
    };

    expect(shouldSkipDueToMute(job!)).toBe(true);
  });

  test("should detect when mute has expired", () => {
    const taskId = "dl-mute-expired-1";
    const runAt = new Date(Date.now() - 1000).toISOString();
    const mutedUntil = new Date(Date.now() - 1000).toISOString(); // Past (mute expired)

    stateStore.createDelayedJob({
      jobId: taskId,
      updateId: 1,
      userId: 123,
      chatId: 123,
      prompt: "Test expired mute",
      requestPreview: "Test expired mute",
      runAt,
      mutedUntil,
    });

    const job = stateStore.getBackgroundJob(taskId);
    expect(job).not.toBeNull();

    const shouldSkipDueToMute = (j: NonNullable<ReturnType<typeof stateStore.getBackgroundJob>>): boolean => {
      if (!j.mutedUntil) return false;
      const mutedUntilDate = new Date(j.mutedUntil);
      const now = new Date();
      return mutedUntilDate > now;
    };

    expect(shouldSkipDueToMute(job!)).toBe(false);
  });

  test("should mark one-shot job as skipped_muted when muted", () => {
    const taskId = "dl-skip-oneshot-1";
    const runAt = new Date(Date.now() - 1000).toISOString();
    const mutedUntil = new Date(Date.now() + 3600000).toISOString();

    stateStore.createDelayedJob({
      jobId: taskId,
      updateId: 1,
      userId: 123,
      chatId: 123,
      prompt: "Skip me",
      requestPreview: "Skip me",
      runAt,
      mutedUntil,
    });

    // Simulate execution flow
    const job = stateStore.getBackgroundJob(taskId);
    const claimed = stateStore.claimScheduledJob(taskId);
    expect(claimed).toBe(true);

    // Check if muted
    const shouldSkip =
      job!.mutedUntil && new Date(job!.mutedUntil) > new Date();
    expect(shouldSkip).toBe(true);

    // Mark as skipped
    if (shouldSkip) {
      stateStore.markJobSkippedMuted(taskId);
    }

    const updated = stateStore.getBackgroundJob(taskId);
    expect(updated?.status).toBe("skipped_muted");
  });
});
