import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { StateStore } from "../src/runtime/state-store";

const TEST_RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
const TEST_DB_DIR = `/tmp/ambrogio-test-muted-integration-${TEST_RUN_ID}`;

describe("Muted Jobs Integration", () => {
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

  test("full workflow: create, mute, check, unmute", () => {
    const taskId = "dl-workflow-1";
    const runAt = new Date(Date.now() + 3600000).toISOString();
    const mutedUntil = new Date(Date.now() + 7200000).toISOString();

    // Create job
    stateStore.createDelayedJob({
      jobId: taskId,
      updateId: 1,
      userId: 123,
      chatId: 123,
      prompt: "Workflow test",
      requestPreview: "Workflow test",
      runAt,
    });

    let job = stateStore.getBackgroundJob(taskId);
    expect(job?.mutedUntil).toBeNull();

    // Mute job
    stateStore.muteJob(taskId, mutedUntil);
    job = stateStore.getBackgroundJob(taskId);
    expect(job?.mutedUntil).toBe(mutedUntil);

    // List muted jobs
    const muted = stateStore.getMutedJobs(10);
    expect(muted.length).toBe(1);
    expect(muted[0]?.taskId).toBe(taskId);

    // Unmute job
    stateStore.unmuteJob(taskId);
    job = stateStore.getBackgroundJob(taskId);
    expect(job?.mutedUntil).toBeNull();
  });

  test("recurring job remains scheduled when muted", () => {
    const taskId = "rc-workflow-1";
    const runAt = new Date(Date.now() - 1000).toISOString(); // Past (due now)
    const mutedUntil = new Date(Date.now() + 3600000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 1,
      userId: 123,
      chatId: 123,
      prompt: "Recurring workflow",
      requestPreview: "Recurring workflow",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
      mutedUntil,
    });

    // Job should be in getDueScheduledJobs
    const due = stateStore.getDueScheduledJobs(10);
    expect(due.some((j) => j.taskId === taskId)).toBe(true);

    // But should be muted
    const job = due.find((j) => j.taskId === taskId);
    expect(job?.mutedUntil).toBe(mutedUntil);
  });

  test("pattern muting affects multiple jobs", () => {
    const runAt = new Date(Date.now() + 3600000).toISOString();
    const mutedUntil = new Date(Date.now() + 7200000).toISOString();

    // Create jobs with "weather" in prompt
    stateStore.createDelayedJob({
      jobId: "dl-weather-1",
      updateId: 1,
      userId: 123,
      chatId: 123,
      prompt: "Check weather in Milan",
      requestPreview: "Weather check",
      runAt,
    });

    stateStore.createRecurringJob({
      jobId: "rc-weather-2",
      updateId: 2,
      userId: 123,
      chatId: 123,
      prompt: "Daily weather update",
      requestPreview: "Weather check",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1d",
    });

    // Create unrelated job
    stateStore.createDelayedJob({
      jobId: "dl-other-1",
      updateId: 3,
      userId: 123,
      chatId: 123,
      prompt: "Unrelated task",
      requestPreview: "Other task",
      runAt,
    });

    // Mute by pattern
    const count = stateStore.muteJobsByPattern("weather", mutedUntil);
    expect(count).toBe(2);

    // Check muted jobs
    const weather1 = stateStore.getBackgroundJob("dl-weather-1");
    const weather2 = stateStore.getBackgroundJob("rc-weather-2");
    const other = stateStore.getBackgroundJob("dl-other-1");

    expect(weather1?.mutedUntil).toBe(mutedUntil);
    expect(weather2?.mutedUntil).toBe(mutedUntil);
    expect(other?.mutedUntil).toBeNull();
  });
});
