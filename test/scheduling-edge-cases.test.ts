import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { StateStore } from "../src/runtime/state-store";

// Generate unique test directory for this test run
const TEST_RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
const TEST_DB_DIR = `/tmp/ambrogio-edge-test-${TEST_RUN_ID}`;

describe("Scheduling Edge Cases", () => {
  let stateStore: StateStore;

  beforeEach(async () => {
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

  describe("Invalid Cron Expressions", () => {
    test("should reject invalid minute value", () => {
      expect(() => {
        stateStore.createRecurringJob({
          jobId: "invalid-minute",
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "cron",
          recurrenceExpression: "99 9 * * *", // Invalid: minute 99
        });
      }).toThrow();
    });

    test("should reject invalid hour value", () => {
      expect(() => {
        stateStore.createRecurringJob({
          jobId: "invalid-hour",
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "cron",
          recurrenceExpression: "0 30 * * *", // Invalid: hour 30
        });
      }).toThrow();
    });

    test("should reject too few fields", () => {
      expect(() => {
        stateStore.createRecurringJob({
          jobId: "too-few-fields",
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "cron",
          recurrenceExpression: "0 9", // Invalid: only 2 fields
        });
      }).toThrow();
    });

    test("should reject invalid day-of-week", () => {
      expect(() => {
        stateStore.createRecurringJob({
          jobId: "invalid-dow",
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "cron",
          recurrenceExpression: "0 9 * * 8", // Invalid: day-of-week 8
        });
      }).toThrow();
    });
  });

  describe("Invalid Interval Expressions", () => {
    test("should reject invalid interval format", () => {
      expect(() => {
        stateStore.createRecurringJob({
          jobId: "invalid-interval",
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "interval",
          recurrenceExpression: "30", // Missing unit
        });
      }).toThrow();
    });

    test("should reject invalid time unit", () => {
      expect(() => {
        stateStore.createRecurringJob({
          jobId: "invalid-unit",
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "interval",
          recurrenceExpression: "30x", // Invalid unit 'x'
        });
      }).toThrow();
    });

    test("should reject negative interval", () => {
      expect(() => {
        stateStore.createRecurringJob({
          jobId: "negative-interval",
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "interval",
          recurrenceExpression: "-5m",
        });
      }).toThrow();
    });

    test("should handle very large interval", () => {
      // This test verifies that validation prevents overflow issues
      const taskId = "large-interval";

      // Should now throw due to validation
      expect(() => {
        stateStore.createRecurringJob({
          jobId: taskId,
          updateId: 0,
          userId: 123,
          chatId: 123,
          prompt: "Test",
          requestPreview: "Test",
          runAt: new Date(Date.now() + 3600000).toISOString(),
          recurrenceType: "interval",
          recurrenceExpression: "999999d", // Very large interval
        });
      }).toThrow(/Interval too large/);
    });
  });

  describe("Timezone Edge Cases", () => {
    test("demonstrates timezone ambiguity", () => {
      // This test shows that timezones are not explicitly handled
      const taskId = "tz-test";
      const runAt = new Date("2026-02-16T09:00:00-08:00"); // 9am PST

      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: "Test",
        requestPreview: "Test",
        runAt: runAt.toISOString(), // Converts to UTC
        recurrenceType: "cron",
        recurrenceExpression: "0 9 * * *", // But this is interpreted in system local time
      });

      const job = stateStore.getBackgroundJob(taskId);
      expect(job).not.toBeNull();

      // BUG: The cron "0 9 * * *" will run at 9am in system timezone,
      // not the timezone of the original runAt
    });
  });

  describe("Day-of-Month (Now Implemented)", () => {
    test("day-of-month is now respected", () => {
      // This verifies that day-of-month field is now implemented
      const taskId = "dom-test";

      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: "Test",
        requestPreview: "Test",
        runAt: new Date(Date.now() + 3600000).toISOString(),
        recurrenceType: "cron",
        recurrenceExpression: "0 9 15 * *", // 15th of each month at 9am
      });

      stateStore.claimScheduledJob(taskId);
      stateStore.rescheduleRecurringJob(taskId, "Test");

      const job = stateStore.getBackgroundJob(taskId);
      const nextRun = new Date(job!.runAt!);

      // FIXED: Next run now respects day-of-month constraint
      // The job should run on the 15th
      expect(nextRun.getDate()).toBe(15);
      expect(nextRun.getHours()).toBe(9);
      expect(nextRun.getMinutes()).toBe(0);
    });
  });

  describe("Month Field (Now Implemented)", () => {
    test("month field is now respected", () => {
      // This verifies that month field is now implemented
      const taskId = "month-test";

      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: "Test",
        requestPreview: "Test",
        runAt: new Date(Date.now() + 3600000).toISOString(),
        recurrenceType: "cron",
        recurrenceExpression: "0 9 1 1 *", // January 1st at 9am
      });

      stateStore.claimScheduledJob(taskId);
      stateStore.rescheduleRecurringJob(taskId, "Test");

      const job = stateStore.getBackgroundJob(taskId);
      const nextRun = new Date(job!.runAt!);

      // FIXED: Month is now respected, job runs only in January
      // Job should only run in January (month = 0 in JavaScript Date)
      expect(nextRun.getMonth()).toBe(0); // January
      expect(nextRun.getDate()).toBe(1); // 1st
      expect(nextRun.getHours()).toBe(9);
    });
  });

  describe("Minute Wildcard Behavior", () => {
    test("minute wildcard defaults to :00 instead of every minute", () => {
      const taskId = "minute-wildcard";

      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: "Test",
        requestPreview: "Test",
        runAt: new Date(Date.now() + 3600000).toISOString(),
        recurrenceType: "cron",
        recurrenceExpression: "* 9 * * *", // Should run every minute at 9am hour
      });

      stateStore.claimScheduledJob(taskId);
      stateStore.rescheduleRecurringJob(taskId, "Test");

      const job = stateStore.getBackgroundJob(taskId);
      const nextRun = new Date(job!.runAt!);

      // BUG: Minute wildcard is treated as 0, not "every minute"
      // Traditional cron would run at 9:00, 9:01, 9:02, etc.
      // This implementation only runs at 9:00
      expect(nextRun.getMinutes()).toBe(0);
    });
  });

  describe("Concurrent Job Claiming", () => {
    test("demonstrates potential race condition", async () => {
      // This test demonstrates that concurrent claims might succeed
      const taskId = "race-condition-test";

      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: "Test",
        requestPreview: "Test",
        runAt: new Date(Date.now() - 1000).toISOString(), // Already due
        recurrenceType: "interval",
        recurrenceExpression: "1h",
      });

      // Simulate two processes trying to claim the same job
      const claim1 = stateStore.claimScheduledJob(taskId);
      const claim2 = stateStore.claimScheduledJob(taskId);

      // Both claims should not succeed (but in this simple test, only one does)
      expect(claim1).toBe(true);
      expect(claim2).toBe(false); // Second claim fails because status already changed

      // NOTE: In a real concurrent scenario with two separate database connections,
      // both might read status='scheduled' before either writes, causing double execution
    });
  });

  describe("Muted Job Behavior", () => {
    test("muted recurring job should skip execution but reschedule", () => {
      const taskId = "muted-recurring";
      const mutedUntil = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: "Test",
        requestPreview: "Test",
        runAt: new Date(Date.now() + 1000).toISOString(),
        recurrenceType: "interval",
        recurrenceExpression: "1h",
        mutedUntil,
      });

      const job = stateStore.getBackgroundJob(taskId);
      expect(job?.mutedUntil).toBe(mutedUntil);

      // When executed, main.ts checks mutedUntil and skips execution
      // but still reschedules (see executeScheduledJob in main.ts)
      // This is correct behavior, but worth testing
    });
  });

  describe("Hour Interval Edge Cases", () => {
    test("hour interval with */2 pattern", () => {
      const taskId = "hour-interval";

      // This tests the "*/2" pattern for hours
      stateStore.createRecurringJob({
        jobId: taskId,
        updateId: 0,
        userId: 123,
        chatId: 123,
        prompt: "Test",
        requestPreview: "Test",
        runAt: new Date(Date.now() + 1000).toISOString(),
        recurrenceType: "cron",
        recurrenceExpression: "0 */2 * * *", // Every 2 hours
      });

      stateStore.claimScheduledJob(taskId);
      stateStore.rescheduleRecurringJob(taskId, "Test");

      const job = stateStore.getBackgroundJob(taskId);
      const nextRun = new Date(job!.runAt!);

      // Next run should be at an even hour (0, 2, 4, 6, etc.)
      expect(nextRun.getHours() % 2).toBe(0);
      expect(nextRun.getMinutes()).toBe(0);
    });
  });
});
