import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { StateStore } from "../src/runtime/state-store";

// Generate unique test directory for this test run to avoid conflicts with production data
const TEST_RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
const TEST_DB_DIR = `/tmp/ambrogio-test-${TEST_RUN_ID}`;

describe("Recurring Jobs", () => {
  let stateStore: StateStore;

  beforeEach(async () => {
    // Clean up test database directory
    try {
      await rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }

    stateStore = await StateStore.open(TEST_DB_DIR);
  });

  afterEach(async () => {
    stateStore.close();
    try {
      await rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("should create a recurring job with interval type", () => {
    const taskId = "rc-test-1";
    const runAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test recurring job",
      requestPreview: "Test recurring job",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
    });

    const job = stateStore.getBackgroundJob(taskId);
    expect(job).not.toBeNull();
    expect(job?.kind).toBe("recurring");
    expect(job?.recurrenceType).toBe("interval");
    expect(job?.recurrenceExpression).toBe("1h");
    expect(job?.recurrenceRunCount).toBe(0);
    expect(job?.recurrenceEnabled).toBe(true);
  });

  test("should create a recurring job with cron type", () => {
    const taskId = "rc-test-2";
    const runAt = new Date(Date.now() + 3600000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test cron job",
      requestPreview: "Test cron job",
      runAt,
      recurrenceType: "cron",
      recurrenceExpression: "0 9 * * *",
    });

    const job = stateStore.getBackgroundJob(taskId);
    expect(job).not.toBeNull();
    expect(job?.kind).toBe("recurring");
    expect(job?.recurrenceType).toBe("cron");
    expect(job?.recurrenceExpression).toBe("0 9 * * *");
  });

  test("should reschedule recurring job after execution", () => {
    const taskId = "rc-test-3";
    const runAt = new Date(Date.now() + 3600000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test reschedule",
      requestPreview: "Test reschedule",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
    });

    // Claim and reschedule
    const claimed = stateStore.claimScheduledJob(taskId);
    expect(claimed).toBe(true);

    const rescheduled = stateStore.rescheduleRecurringJob(taskId, "Job completed");
    expect(rescheduled).toBe(true);

    const job = stateStore.getBackgroundJob(taskId);
    expect(job?.status).toBe("scheduled");
    expect(job?.recurrenceRunCount).toBe(1);
    // Check that the new run time is approximately 1 hour from now
    const nextRun = new Date(job!.runAt!);
    const expectedTime = new Date(Date.now() + 3600000);
    expect(Math.abs(nextRun.getTime() - expectedTime.getTime())).toBeLessThan(5000);
  });

  test("should stop rescheduling when max runs reached", () => {
    const taskId = "rc-test-4";
    const runAt = new Date(Date.now() + 3600000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test max runs",
      requestPreview: "Test max runs",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
      maxRuns: 2,
    });

    // First execution
    stateStore.claimScheduledJob(taskId);
    let rescheduled = stateStore.rescheduleRecurringJob(taskId, "Run 1");
    expect(rescheduled).toBe(true);

    let job = stateStore.getBackgroundJob(taskId);
    expect(job?.recurrenceRunCount).toBe(1);

    // Second execution (maxRuns=2 means it can run up to 2 times)
    stateStore.claimScheduledJob(taskId);
    rescheduled = stateStore.rescheduleRecurringJob(taskId, "Run 2");
    expect(rescheduled).toBe(true); // Still within max runs

    job = stateStore.getBackgroundJob(taskId);
    expect(job?.recurrenceRunCount).toBe(2);

    // Third execution attempt (should fail)
    stateStore.claimScheduledJob(taskId);
    rescheduled = stateStore.rescheduleRecurringJob(taskId, "Run 3");
    expect(rescheduled).toBe(false); // Max runs exceeded

    job = stateStore.getBackgroundJob(taskId);
    expect(job?.recurrenceRunCount).toBe(2); // Count doesn't increment on failure
  });

  test("should pause and resume recurring job", () => {
    const taskId = "rc-test-5";
    const runAt = new Date(Date.now() + 3600000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test pause/resume",
      requestPreview: "Test pause/resume",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
    });

    // Pause
    const paused = stateStore.pauseRecurringJob(taskId);
    expect(paused).toBe(true);

    let job = stateStore.getBackgroundJob(taskId);
    expect(job?.recurrenceEnabled).toBe(false);

    // Try to reschedule while paused (should fail)
    stateStore.claimScheduledJob(taskId);
    const rescheduled = stateStore.rescheduleRecurringJob(taskId, "Test");
    expect(rescheduled).toBe(false);

    // Resume
    const resumed = stateStore.resumeRecurringJob(taskId);
    expect(resumed).toBe(true);

    job = stateStore.getBackgroundJob(taskId);
    expect(job?.recurrenceEnabled).toBe(true);
  });

  test("should list recurring jobs", () => {
    // Create multiple recurring jobs
    for (let i = 0; i < 3; i++) {
      const taskId = `rc-test-list-${i}`;
      const runAt = new Date(Date.now() + 3600000).toISOString();

      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: `Test job ${i}`,
        requestPreview: `Test job ${i}`,
        runAt,
        recurrenceType: "interval",
        recurrenceExpression: `${i + 1}h`,
      });
    }

    const jobs = stateStore.getRecurringJobs(10);
    expect(jobs.length).toBe(3);
    expect(jobs.every((job) => job.kind === "recurring")).toBe(true);
  });

  test("should update recurrence expression", () => {
    const taskId = "rc-test-6";
    const runAt = new Date(Date.now() + 3600000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test update expression",
      requestPreview: "Test update expression",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
    });

    const updated = stateStore.updateRecurrenceExpression(taskId, "2h");
    expect(updated).toBe(true);

    const job = stateStore.getBackgroundJob(taskId);
    expect(job?.recurrenceExpression).toBe("2h");
  });

  test("should handle recurring job failures", () => {
    const taskId = "rc-test-7";
    const runAt = new Date(Date.now() + 3600000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test failure",
      requestPreview: "Test failure",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1h",
    });

    // Claim and fail
    stateStore.claimScheduledJob(taskId);
    const rescheduled = stateStore.recordRecurringJobFailure(
      taskId,
      "Test error",
      "Job failed"
    );
    expect(rescheduled).toBe(true);

    const job = stateStore.getBackgroundJob(taskId);
    expect(job?.status).toBe("scheduled"); // Should be rescheduled despite failure
    expect(job?.recurrenceRunCount).toBe(1);
    expect(job?.errorMessage).toBe("Test error");
  });

  test("should migrate from background_tasks to jobs table", async () => {
    // This test would require creating an old database format
    // For now, we just verify the new schema works
    const job = stateStore.getBackgroundJob("non-existent");
    expect(job).toBeNull();
  });
});

describe("Time Calculations", () => {
  let stateStore: StateStore;

  beforeEach(async () => {
    // Clean up test database directory
    try {
      await rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }
    stateStore = await StateStore.open(TEST_DB_DIR);
  });

  afterEach(async () => {
    stateStore.close();
    try {
      await rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("should calculate next run time for interval expressions", () => {
    const taskId = "rc-test-time-1";
    const runAt = new Date(Date.now() + 60000).toISOString(); // 1 minute from now

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test interval",
      requestPreview: "Test interval",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "30m",
    });

    stateStore.claimScheduledJob(taskId);
    stateStore.rescheduleRecurringJob(taskId, "Test");

    const job = stateStore.getBackgroundJob(taskId);
    const nextRunTime = new Date(job!.runAt!);
    const expectedTime = new Date(Date.now() + 30 * 60 * 1000);

    // Allow 5 second tolerance
    expect(Math.abs(nextRunTime.getTime() - expectedTime.getTime())).toBeLessThan(5000);
  });

  test("should handle hour intervals", () => {
    const taskId = "rc-test-time-2";
    const runAt = new Date(Date.now() + 60000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test hour interval",
      requestPreview: "Test hour interval",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "2h",
    });

    stateStore.claimScheduledJob(taskId);
    stateStore.rescheduleRecurringJob(taskId, "Test");

    const job = stateStore.getBackgroundJob(taskId);
    const nextRunTime = new Date(job!.runAt!);
    const expectedTime = new Date(Date.now() + 2 * 60 * 60 * 1000);

    expect(Math.abs(nextRunTime.getTime() - expectedTime.getTime())).toBeLessThan(5000);
  });

  test("should handle day intervals", () => {
    const taskId = "rc-test-time-3";
    const runAt = new Date(Date.now() + 60000).toISOString();

    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test day interval",
      requestPreview: "Test day interval",
      runAt,
      recurrenceType: "interval",
      recurrenceExpression: "1d",
    });

    stateStore.claimScheduledJob(taskId);
    stateStore.rescheduleRecurringJob(taskId, "Test");

    const job = stateStore.getBackgroundJob(taskId);
    const nextRunTime = new Date(job!.runAt!);
    const expectedTime = new Date(Date.now() + 24 * 60 * 60 * 1000);

    expect(Math.abs(nextRunTime.getTime() - expectedTime.getTime())).toBeLessThan(5000);
  });

  test("should respect day-of-week constraint in cron expressions", () => {
    const taskId = "rc-test-dow-1";
    const runAt = new Date(Date.now() + 60000).toISOString();

    // Test cron for Monday, Wednesday, Friday at 06:46
    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test day-of-week",
      requestPreview: "Test day-of-week",
      runAt,
      recurrenceType: "cron",
      recurrenceExpression: "46 6 * * 1,3,5", // Monday, Wednesday, Friday
    });

    stateStore.claimScheduledJob(taskId);
    stateStore.rescheduleRecurringJob(taskId, "Test");

    const job = stateStore.getBackgroundJob(taskId);
    const nextRunTime = new Date(job!.runAt!);
    const dayOfWeek = nextRunTime.getDay(); // 0 (Sunday) to 6 (Saturday)

    // Verify that next run is on Monday (1), Wednesday (3), or Friday (5)
    expect([1, 3, 5]).toContain(dayOfWeek);

    // Verify the time is set correctly
    expect(nextRunTime.getHours()).toBe(6);
    expect(nextRunTime.getMinutes()).toBe(46);
  });

  test("should skip to next valid day when current day is not allowed", () => {
    const taskId = "rc-test-dow-2";

    // Get a Saturday or Sunday
    const now = new Date();
    const dayOfWeek = now.getDay();

    // If today is Monday-Friday, set time to past so it skips to next occurrence
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      now.setHours(7, 0, 0, 0); // Past 06:46
    }

    const runAt = now.toISOString();

    // Cron for Monday only at 06:46
    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test skip to Monday",
      requestPreview: "Test skip to Monday",
      runAt,
      recurrenceType: "cron",
      recurrenceExpression: "46 6 * * 1", // Monday only
    });

    stateStore.claimScheduledJob(taskId);
    stateStore.rescheduleRecurringJob(taskId, "Test");

    const job = stateStore.getBackgroundJob(taskId);
    const nextRunTime = new Date(job!.runAt!);
    const nextDayOfWeek = nextRunTime.getDay();

    // Verify next run is on Monday
    expect(nextDayOfWeek).toBe(1);
    expect(nextRunTime.getHours()).toBe(6);
    expect(nextRunTime.getMinutes()).toBe(46);
  });

  test("should handle day-of-week ranges", () => {
    const taskId = "rc-test-dow-3";
    const runAt = new Date(Date.now() + 60000).toISOString();

    // Test cron for Monday-Friday (weekdays) at 09:00
    stateStore.createRecurringJob({
      jobId: taskId,
      updateId: 0,
      userId: 123,
      chatId: 123,
      prompt: "Test weekdays",
      requestPreview: "Test weekdays",
      runAt,
      recurrenceType: "cron",
      recurrenceExpression: "0 9 * * 1-5", // Monday to Friday
    });

    stateStore.claimScheduledJob(taskId);
    stateStore.rescheduleRecurringJob(taskId, "Test");

    const job = stateStore.getBackgroundJob(taskId);
    const nextRunTime = new Date(job!.runAt!);
    const dayOfWeek = nextRunTime.getDay();

    // Verify next run is on a weekday (1-5)
    expect(dayOfWeek).toBeGreaterThanOrEqual(1);
    expect(dayOfWeek).toBeLessThanOrEqual(5);
    expect(nextRunTime.getHours()).toBe(9);
    expect(nextRunTime.getMinutes()).toBe(0);
  });
});
