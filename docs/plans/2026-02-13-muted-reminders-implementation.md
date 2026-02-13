# Muted Reminders Implementation Plan

**Goal:** Add temporary muting capability to background jobs with automatic expiration and pattern matching.

**Architecture:** Add `muted_until` column to jobs table, check mute status before execution in job runner, skip execution/delivery if muted, add CLI commands and natural language support for muting/unmuting jobs.

**Tech Stack:** TypeScript, Bun SQLite, ambrogioctl CLI

---

## Task 1: Add Database Schema and Types

**Files:**

- Modify: `src/runtime/state-store.ts` (add column, update types)
- Test: `test/state-store.test.ts`

### Step 1: Write failing test for muted_until column

Add to `test/state-store.test.ts`:

```typescript
test("should support muted_until column for jobs", async () => {
  const taskId = "dl-mute-test-1";
  const runAt = new Date(Date.now() + 3600000).toISOString();
  const mutedUntil = new Date(Date.now() + 7200000).toISOString();

  stateStore.createDelayedJob({
    jobId: taskId,
    updateId: 1,
    userId: 123,
    chatId: 123,
    prompt: "Test muted job",
    requestPreview: "Test muted job",
    runAt,
    mutedUntil,
  });

  const job = stateStore.getBackgroundJob(taskId);
  expect(job).not.toBeNull();
  expect(job?.mutedUntil).toBe(mutedUntil);
});

test("should support null muted_until for unmuted jobs", async () => {
  const taskId = "dl-mute-test-2";
  const runAt = new Date(Date.now() + 3600000).toISOString();

  stateStore.createDelayedJob({
    jobId: taskId,
    updateId: 1,
    userId: 123,
    chatId: 123,
    prompt: "Test unmuted job",
    requestPreview: "Test unmuted job",
    runAt,
  });

  const job = stateStore.getBackgroundJob(taskId);
  expect(job).not.toBeNull();
  expect(job?.mutedUntil).toBeNull();
});
```

### Step 2: Run test to verify it fails

Run: `bun test test/state-store.test.ts -t "should support muted_until"`

Expected: FAIL - `mutedUntil` property doesn't exist on JobEntry type

### Step 3: Add muted_until to database schema

In `src/runtime/state-store.ts`, update `ensureJobsTable()` method to add column if it doesn't exist:

```typescript
private ensureJobsTable(): void {
  // ... existing table creation code ...

  // Add muted_until column (migration for existing databases)
  const mutedUntilColumnExists = this.db
    .query("SELECT COUNT(*) as count FROM pragma_table_info('jobs') WHERE name='muted_until'")
    .get() as { count: number };

  if (mutedUntilColumnExists.count === 0) {
    this.db.run("ALTER TABLE jobs ADD COLUMN muted_until TEXT NULL");
  }
}
```

### Step 4: Update TypeScript types

In `src/runtime/state-store.ts`:

Update `JobEntry` type:

```typescript
export type JobEntry = {
  taskId: string;
  kind: JobKind;
  updateId: number;
  userId: number;
  chatId: number;
  command: string | null;
  payloadPrompt: string | null;
  runAt: string | null;
  requestPreview: string;
  status: JobStatus;
  createdAt: string;
  timedOutAt: string;
  completedAt: string | null;
  deliveredAt: string | null;
  deliveryText: string | null;
  errorMessage: string | null;
  recurrenceType: RecurrenceType;
  recurrenceExpression: string | null;
  recurrenceMaxRuns: number | null;
  recurrenceRunCount: number;
  recurrenceEnabled: boolean;
  mutedUntil: string | null; // NEW
};
```

Update `JobRow` type:

```typescript
type JobRow = {
  task_id: string;
  kind: JobKind;
  update_id: number;
  user_id: number;
  chat_id: number;
  command: string | null;
  payload_prompt: string | null;
  run_at: string | null;
  request_preview: string;
  status: JobStatus;
  created_at: string;
  timed_out_at: string;
  completed_at: string | null;
  delivered_at: string | null;
  delivery_text: string | null;
  error_message: string | null;
  recurrence_type: string | null;
  recurrence_expression: string | null;
  recurrence_max_runs: number | null;
  recurrence_run_count: number;
  recurrence_enabled: number;
  muted_until: string | null; // NEW
};
```

Update `mapJobRow()` method:

```typescript
private mapJobRow(row: JobRow): JobEntry {
  return {
    taskId: row.task_id,
    kind: row.kind,
    updateId: row.update_id,
    userId: row.user_id,
    chatId: row.chat_id,
    command: row.command,
    payloadPrompt: row.payload_prompt,
    runAt: row.run_at,
    requestPreview: row.request_preview,
    status: row.status,
    createdAt: row.created_at,
    timedOutAt: row.timed_out_at,
    completedAt: row.completed_at,
    deliveredAt: row.delivered_at,
    deliveryText: row.delivery_text,
    errorMessage: row.error_message,
    recurrenceType: row.recurrence_type as RecurrenceType,
    recurrenceExpression: row.recurrence_expression,
    recurrenceMaxRuns: row.recurrence_max_runs,
    recurrenceRunCount: row.recurrence_run_count,
    recurrenceEnabled: row.recurrence_enabled === 1,
    mutedUntil: row.muted_until,  // NEW
  };
}
```

### Step 5: Update createDelayedJob and createRecurringJob methods

In `src/runtime/state-store.ts`, update method signatures to accept optional `mutedUntil`:

```typescript
createDelayedJob(params: {
  jobId: string;
  updateId: number;
  userId: number;
  chatId: number;
  prompt: string;
  requestPreview: string;
  runAt: string;
  mutedUntil?: string | null;
}): void {
  const now = new Date().toISOString();
  this.db.run(
    `INSERT INTO jobs (
      task_id, kind, update_id, user_id, chat_id, command, payload_prompt,
      run_at, request_preview, status, created_at, timed_out_at,
      recurrence_type, recurrence_expression, recurrence_max_runs,
      recurrence_run_count, recurrence_enabled, muted_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params.jobId,
    "delayed",
    params.updateId,
    params.userId,
    params.chatId,
    null,
    params.prompt,
    params.runAt,
    params.requestPreview,
    "scheduled",
    now,
    now,
    null,
    null,
    null,
    0,
    1,
    params.mutedUntil ?? null,
  );
}

createRecurringJob(params: {
  jobId: string;
  updateId: number;
  userId: number;
  chatId: number;
  prompt: string;
  requestPreview: string;
  runAt: string;
  recurrenceType: "interval" | "cron";
  recurrenceExpression: string;
  maxRuns?: number;
  mutedUntil?: string | null;
}): void {
  const now = new Date().toISOString();
  this.db.run(
    `INSERT INTO jobs (
      task_id, kind, update_id, user_id, chat_id, command, payload_prompt,
      run_at, request_preview, status, created_at, timed_out_at,
      recurrence_type, recurrence_expression, recurrence_max_runs,
      recurrence_run_count, recurrence_enabled, muted_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params.jobId,
    "recurring",
    params.updateId,
    params.userId,
    params.chatId,
    null,
    params.prompt,
    params.runAt,
    params.requestPreview,
    "scheduled",
    now,
    now,
    params.recurrenceType,
    params.recurrenceExpression,
    params.maxRuns ?? null,
    0,
    1,
    params.mutedUntil ?? null,
  );
}
```

### Step 6: Run test to verify it passes

Run: `bun test test/state-store.test.ts -t "should support muted_until"`

Expected: PASS

### Step 7: Commit

```bash
git add src/runtime/state-store.ts test/state-store.test.ts
git commit -m "feat: add muted_until column to jobs table

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Add skipped_muted Status

**Files:**

- Modify: `src/runtime/state-store.ts`
- Test: `test/state-store.test.ts`

### Step 1: Write failing test for skipped_muted status

Add to `test/state-store.test.ts`:

```typescript
test("should mark job as skipped_muted", async () => {
  const taskId = "dl-skip-test-1";
  const runAt = new Date(Date.now() + 3600000).toISOString();

  stateStore.createDelayedJob({
    jobId: taskId,
    updateId: 1,
    userId: 123,
    chatId: 123,
    prompt: "Test skip",
    requestPreview: "Test skip",
    runAt,
  });

  stateStore.markJobSkippedMuted(taskId);

  const job = stateStore.getBackgroundJob(taskId);
  expect(job?.status).toBe("skipped_muted");
});
```

### Step 2: Run test to verify it fails

Run: `bun test test/state-store.test.ts -t "should mark job as skipped_muted"`

Expected: FAIL - `markJobSkippedMuted` method doesn't exist

### Step 3: Add skipped_muted to JobStatus type

In `src/runtime/state-store.ts`:

```typescript
export type JobStatus =
  | "scheduled"
  | "running"
  | "completed_pending_delivery"
  | "completed_delivered"
  | "failed_pending_delivery"
  | "failed_delivered"
  | "canceled"
  | "skipped_muted"; // NEW
```

### Step 4: Implement markJobSkippedMuted method

In `src/runtime/state-store.ts`:

```typescript
markJobSkippedMuted(taskId: string): boolean {
  const result = this.db.run(
    `UPDATE jobs SET status = ?, completed_at = ?
     WHERE task_id = ? AND status IN ('scheduled', 'running')`,
    "skipped_muted",
    new Date().toISOString(),
    taskId,
  );
  return result.changes > 0;
}
```

### Step 5: Run test to verify it passes

Run: `bun test test/state-store.test.ts -t "should mark job as skipped_muted"`

Expected: PASS

### Step 6: Commit

```bash
git add src/runtime/state-store.ts test/state-store.test.ts
git commit -m "feat: add skipped_muted status for muted jobs

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Add Mute/Unmute Methods to StateStore

**Files:**

- Modify: `src/runtime/state-store.ts`
- Test: `test/state-store.test.ts`

### Step 1: Write failing tests for mute operations

Add to `test/state-store.test.ts`:

```typescript
test("should mute a specific job", async () => {
  const taskId = "dl-mute-op-1";
  const runAt = new Date(Date.now() + 3600000).toISOString();
  const mutedUntil = new Date(Date.now() + 7200000).toISOString();

  stateStore.createDelayedJob({
    jobId: taskId,
    updateId: 1,
    userId: 123,
    chatId: 123,
    prompt: "Test mute",
    requestPreview: "Test mute",
    runAt,
  });

  const result = stateStore.muteJob(taskId, mutedUntil);
  expect(result).toBe(true);

  const job = stateStore.getBackgroundJob(taskId);
  expect(job?.mutedUntil).toBe(mutedUntil);
});

test("should unmute a job", async () => {
  const taskId = "dl-unmute-op-1";
  const runAt = new Date(Date.now() + 3600000).toISOString();
  const mutedUntil = new Date(Date.now() + 7200000).toISOString();

  stateStore.createDelayedJob({
    jobId: taskId,
    updateId: 1,
    userId: 123,
    chatId: 123,
    prompt: "Test unmute",
    requestPreview: "Test unmute",
    runAt,
    mutedUntil,
  });

  const result = stateStore.unmuteJob(taskId);
  expect(result).toBe(true);

  const job = stateStore.getBackgroundJob(taskId);
  expect(job?.mutedUntil).toBeNull();
});

test("should mute jobs by pattern matching", async () => {
  // Create multiple jobs
  const runAt = new Date(Date.now() + 3600000).toISOString();
  const mutedUntil = new Date(Date.now() + 7200000).toISOString();

  stateStore.createDelayedJob({
    jobId: "dl-tram-1",
    updateId: 1,
    userId: 123,
    chatId: 123,
    prompt: "Tram at 8:00",
    requestPreview: "Tram reminder",
    runAt,
  });

  stateStore.createRecurringJob({
    jobId: "rc-tram-2",
    updateId: 2,
    userId: 123,
    chatId: 123,
    prompt: "Tram at 8:15",
    requestPreview: "Tram reminder",
    runAt,
    recurrenceType: "interval",
    recurrenceExpression: "1d",
  });

  stateStore.createDelayedJob({
    jobId: "dl-weather-1",
    updateId: 3,
    userId: 123,
    chatId: 123,
    prompt: "Weather check",
    requestPreview: "Weather reminder",
    runAt,
  });

  const count = stateStore.muteJobsByPattern("tram", mutedUntil);
  expect(count).toBe(2);

  const tram1 = stateStore.getBackgroundJob("dl-tram-1");
  const tram2 = stateStore.getBackgroundJob("rc-tram-2");
  const weather = stateStore.getBackgroundJob("dl-weather-1");

  expect(tram1?.mutedUntil).toBe(mutedUntil);
  expect(tram2?.mutedUntil).toBe(mutedUntil);
  expect(weather?.mutedUntil).toBeNull();
});
```

### Step 2: Run test to verify it fails

Run: `bun test test/state-store.test.ts -t "mute"`

Expected: FAIL - Methods don't exist

### Step 3: Implement mute/unmute methods

In `src/runtime/state-store.ts`:

```typescript
muteJob(taskId: string, mutedUntil: string): boolean {
  const result = this.db.run(
    `UPDATE jobs SET muted_until = ? WHERE task_id = ?`,
    mutedUntil,
    taskId,
  );
  return result.changes > 0;
}

unmuteJob(taskId: string): boolean {
  const result = this.db.run(
    `UPDATE jobs SET muted_until = NULL WHERE task_id = ?`,
    taskId,
  );
  return result.changes > 0;
}

muteJobsByPattern(pattern: string, mutedUntil: string): number {
  const result = this.db.run(
    `UPDATE jobs
     SET muted_until = ?
     WHERE (payload_prompt LIKE ? OR request_preview LIKE ?)
     AND status IN ('scheduled', 'running')`,
    mutedUntil,
    `%${pattern}%`,
    `%${pattern}%`,
  );
  return result.changes;
}

getMutedJobs(limit = 50): JobEntry[] {
  const rows = this.db
    .query<JobRow>(
      `SELECT * FROM jobs
       WHERE muted_until IS NOT NULL
       AND muted_until > datetime('now')
       ORDER BY muted_until ASC
       LIMIT ?`
    )
    .all(limit);
  return rows.map((row) => this.mapJobRow(row));
}
```

### Step 4: Run test to verify it passes

Run: `bun test test/state-store.test.ts -t "mute"`

Expected: PASS

### Step 5: Commit

```bash
git add src/runtime/state-store.ts test/state-store.test.ts
git commit -m "feat: add mute/unmute operations for jobs

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Add Mute Check in Job Execution

**Files:**

- Modify: `src/main.ts`
- Test: Create `test/muted-job-execution.test.ts`

### Step 1: Write failing integration test

Create `test/muted-job-execution.test.ts`:

```typescript
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

    // Helper to check if job should be muted
    const shouldSkipDueToMute = (job: NonNullable<typeof job>): boolean => {
      if (!job.mutedUntil) return false;
      const mutedUntilDate = new Date(job.mutedUntil);
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

    const shouldSkipDueToMute = (job: NonNullable<typeof job>): boolean => {
      if (!job.mutedUntil) return false;
      const mutedUntilDate = new Date(job.mutedUntil);
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
```

### Step 2: Run test to verify it passes (logic test only)

Run: `bun test test/muted-job-execution.test.ts`

Expected: PASS (tests the logic, not full execution)

### Step 3: Add mute check to executeScheduledJob in main.ts

In `src/main.ts`, modify `executeScheduledJob` function (around line 417):

```typescript
const executeScheduledJob = async (job: ScheduledJob): Promise<void> => {
  if (!stateStore.claimScheduledJob(job.taskId)) {
    return;
  }

  // Check if job is muted
  if (job.mutedUntil) {
    const mutedUntilDate = new Date(job.mutedUntil);
    const now = new Date();

    if (mutedUntilDate > now) {
      // Job is currently muted - skip execution
      logger.info("job_skipped_muted", {
        jobId: job.taskId,
        kind: job.kind,
        mutedUntil: job.mutedUntil,
      });

      if (job.kind === "delayed") {
        // One-shot: mark as skipped_muted
        stateStore.markJobSkippedMuted(job.taskId);
      } else if (job.kind === "recurring") {
        // Recurring: increment run count and schedule next run
        const deliveryText = `[Skipped: muted until ${mutedUntilDate.toLocaleString()}]`;
        const rescheduled = stateStore.rescheduleRecurringJob(
          job.taskId,
          deliveryText,
        );
        if (!rescheduled) {
          // Max runs reached - mark completed
          stateStore.markBackgroundJobCompleted(job.taskId, deliveryText);
        }
      }
      return; // Skip execution
    }
  }

  const prompt = job.payloadPrompt ?? job.requestPreview;
  const isRecurring = job.kind === "recurring";

  // Prepend background job prefix to prompt
  const prefixedPrompt = `⏰ [Background Job]\n\n${prompt}`;

  try {
    const reply = await ambrogioAgent.handleMessage(
      job.userId,
      prefixedPrompt,
      `delayed-${job.taskId}`,
    );

    if (isRecurring) {
      // For recurring jobs: reschedule before delivery
      const rescheduled = stateStore.rescheduleRecurringJob(job.taskId, reply);
      if (!rescheduled) {
        // Max runs reached or disabled - mark as completed
        const marked = stateStore.markBackgroundJobCompleted(job.taskId, reply);
        if (!marked) {
          logger.info("recurring_job_completion_dropped", {
            jobId: job.taskId,
            reason: "status_changed",
          });
          return;
        }
      }
    } else {
      // One-shot job: mark completed
      const marked = stateStore.markBackgroundJobCompleted(job.taskId, reply);
      if (!marked) {
        logger.info("scheduled_job_result_dropped", {
          jobId: job.taskId,
          reason: "status_changed",
        });
        return;
      }
    }

    // Always deliver results
    const refreshed = stateStore.getBackgroundJob(job.taskId);
    if (!refreshed) {
      return;
    }
    await deliverBackgroundJob(refreshed, "completion");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureReply = `Job schedulato fallito (${job.taskId}): ${message}`;

    if (isRecurring) {
      // Log error but keep recurring (increment run count)
      const rescheduled = stateStore.recordRecurringJobFailure(
        job.taskId,
        message,
        failureReply,
      );
      if (!rescheduled) {
        // Max runs reached - mark as failed
        const marked = stateStore.markBackgroundJobFailed(
          job.taskId,
          message,
          failureReply,
        );
        if (!marked) {
          logger.info("recurring_job_failure_dropped", {
            jobId: job.taskId,
            reason: "status_changed",
          });
          return;
        }
      }
    } else {
      const marked = stateStore.markBackgroundJobFailed(
        job.taskId,
        message,
        failureReply,
      );
      if (!marked) {
        logger.info("scheduled_job_failure_dropped", {
          jobId: job.taskId,
          reason: "status_changed",
        });
        return;
      }
    }

    const refreshed = stateStore.getBackgroundJob(job.taskId);
    if (!refreshed) {
      return;
    }
    await deliverBackgroundJob(refreshed, "completion");
  }
};
```

### Step 4: Run tests to verify behavior

Run: `bun test test/muted-job-execution.test.ts`

Expected: PASS

### Step 5: Commit

```bash
git add src/main.ts test/muted-job-execution.test.ts
git commit -m "feat: skip muted jobs during execution

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Add RPC Handlers for Mute Operations

**Files:**

- Modify: `src/runtime/job-rpc-server.ts`

### Step 1: Add mute RPC handlers

In `src/runtime/job-rpc-server.ts`, add handlers after existing job operations:

```typescript
// Add to the RPC handler switch statement

if (method === "jobs.mute") {
  const jobId = (parsed.params?.id ?? "").trim();
  const mutedUntil = (parsed.params?.until ?? "").trim();

  if (!jobId) {
    return { ok: false, error: "missing_job_id" };
  }
  if (!mutedUntil) {
    return { ok: false, error: "missing_muted_until" };
  }

  // Validate ISO timestamp
  const date = new Date(mutedUntil);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: "invalid_timestamp" };
  }

  const success = stateStore.muteJob(jobId, mutedUntil);
  if (!success) {
    return { ok: false, error: "job_not_found" };
  }

  return { ok: true, result: { jobId, mutedUntil } };
}

if (method === "jobs.unmute") {
  const jobId = (parsed.params?.id ?? "").trim();

  if (!jobId) {
    return { ok: false, error: "missing_job_id" };
  }

  const success = stateStore.unmuteJob(jobId);
  if (!success) {
    return { ok: false, error: "job_not_found" };
  }

  return { ok: true, result: { jobId } };
}

if (method === "jobs.mute-pattern") {
  const pattern = (parsed.params?.pattern ?? "").trim();
  const mutedUntil = (parsed.params?.until ?? "").trim();

  if (!pattern) {
    return { ok: false, error: "missing_pattern" };
  }
  if (!mutedUntil) {
    return { ok: false, error: "missing_muted_until" };
  }

  // Validate ISO timestamp
  const date = new Date(mutedUntil);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: "invalid_timestamp" };
  }

  const count = stateStore.muteJobsByPattern(pattern, mutedUntil);
  return { ok: true, result: { pattern, mutedUntil, count } };
}

if (method === "jobs.list-muted") {
  const limit = Number.parseInt(String(parsed.params?.limit ?? "50"), 10);
  const jobs = stateStore.getMutedJobs(limit);

  return {
    ok: true,
    result: {
      jobs: jobs.map((job) => ({
        id: job.taskId,
        kind: job.kind,
        prompt: job.payloadPrompt ?? job.requestPreview,
        runAt: job.runAt,
        mutedUntil: job.mutedUntil,
        status: job.status,
        recurrenceExpression: job.recurrenceExpression,
      })),
    },
  };
}
```

### Step 2: Test RPC handlers manually

Test using `bun run ctl`:

```bash
# Create a test job first
bun run ctl -- jobs create --run-at "2099-01-01T10:00:00.000Z" --prompt "Test job" --user-id 123 --chat-id 123 --json

# Mute it
bun run ctl -- jobs mute --id <job-id> --until "2099-01-01T09:00:00.000Z" --json

# List muted jobs
bun run ctl -- jobs list-muted --json

# Unmute it
bun run ctl -- jobs unmute --id <job-id> --json
```

Expected: All commands succeed with proper JSON responses

### Step 3: Commit

```bash
git add src/runtime/job-rpc-server.ts
git commit -m "feat: add RPC handlers for mute operations

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Add CLI Commands to ambrogioctl

**Files:**

- Modify: `src/cli/ambrogioctl.ts`

### Step 1: Add CLI command handlers

In `src/cli/ambrogioctl.ts`, add commands after existing job commands:

```typescript
// Add after existing jobs commands (around line 150-200)

if (scope === "jobs" && operation === "mute") {
  const id = getArg("--id");
  const until = getArg("--until");
  const jsonFlag = hasArg("--json");

  if (!id) {
    console.error("Error: --id is required");
    process.exit(1);
  }
  if (!until) {
    console.error("Error: --until is required");
    process.exit(1);
  }

  const response = await sendRpcRequest({
    method: "jobs.mute",
    params: { id, until },
  });

  if (jsonFlag) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.ok) {
      console.log(`Job ${id} muted until ${until}`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

if (scope === "jobs" && operation === "unmute") {
  const id = getArg("--id");
  const jsonFlag = hasArg("--json");

  if (!id) {
    console.error("Error: --id is required");
    process.exit(1);
  }

  const response = await sendRpcRequest({
    method: "jobs.unmute",
    params: { id },
  });

  if (jsonFlag) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.ok) {
      console.log(`Job ${id} unmuted`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

if (scope === "jobs" && operation === "mute-pattern") {
  const pattern = getArg("--pattern");
  const until = getArg("--until");
  const jsonFlag = hasArg("--json");

  if (!pattern) {
    console.error("Error: --pattern is required");
    process.exit(1);
  }
  if (!until) {
    console.error("Error: --until is required");
    process.exit(1);
  }

  const response = await sendRpcRequest({
    method: "jobs.mute-pattern",
    params: { pattern, until },
  });

  if (jsonFlag) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.ok) {
      const count = response.result?.count ?? 0;
      console.log(`Muted ${count} job(s) matching "${pattern}" until ${until}`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

if (scope === "jobs" && operation === "list-muted") {
  const limit = getArg("--limit") ?? "50";
  const jsonFlag = hasArg("--json");

  const response = await sendRpcRequest({
    method: "jobs.list-muted",
    params: { limit: Number.parseInt(limit, 10) },
  });

  if (jsonFlag) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.ok && response.result?.jobs) {
      const jobs = response.result.jobs as Array<{
        id: string;
        kind: string;
        prompt: string;
        mutedUntil: string;
        recurrenceExpression?: string;
      }>;

      if (jobs.length === 0) {
        console.log("No muted jobs found.");
      } else {
        console.log(`Muted jobs (${jobs.length}):\n`);
        for (const job of jobs) {
          const recurrence = job.recurrenceExpression
            ? ` (${job.recurrenceExpression})`
            : "";
          console.log(`  ${job.id} [${job.kind}${recurrence}]`);
          console.log(`    Prompt: ${job.prompt}`);
          console.log(`    Muted until: ${job.mutedUntil}\n`);
        }
      }
    } else {
      console.error(`Error: ${response.error ?? "unknown"}`);
      process.exit(1);
    }
  }
  process.exit(0);
}
```

### Step 2: Test CLI commands

```bash
# Mute a job
bun run ctl -- jobs mute --id dl-test-1 --until "2099-01-01T10:00:00.000Z"

# Mute by pattern
bun run ctl -- jobs mute-pattern --pattern "tram" --until "2026-02-14T07:00:00.000Z"

# List muted jobs
bun run ctl -- jobs list-muted

# Unmute a job
bun run ctl -- jobs unmute --id dl-test-1
```

Expected: All commands work correctly

### Step 3: Commit

```bash
git add src/cli/ambrogioctl.ts
git commit -m "feat: add CLI commands for mute operations

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Update Natural Scheduler Skill

**Files:**

- Modify: `skills/natural-scheduler/SKILL.md`

### Step 1: Add mute examples to skill documentation

In `skills/natural-scheduler/SKILL.md`, add new section after "## Recurrence Expression Format":

````markdown
## Muting Jobs

Users can temporarily mute jobs to prevent notifications until a specified time.

### Mute Commands

- Mute specific job:
  - `ambrogioctl jobs mute --id <jobId> --until <ISO> --json`
- Mute multiple jobs by pattern:
  - `ambrogioctl jobs mute-pattern --pattern <text> --until <ISO> --json`
- Unmute job:
  - `ambrogioctl jobs unmute --id <jobId> --json`
- List muted jobs:
  - `ambrogioctl jobs list-muted [--limit <N>] --json`

### Natural Language Muting Examples

**Italian:**

- "Sono sul tram, non mandarmi più promemoria per il tram" → Find jobs matching "tram", mute until tomorrow 7:00am
- "Muta il job meteo fino a lunedì" → Mute weather job until next Monday 7:00am
- "Non disturbarmi più oggi" → Mute all scheduled jobs until tomorrow morning
- "Riattiva i promemoria del tram" → Unmute all tram-related jobs
- "Quali job sono mutati?" → List muted jobs

**English:**

- "I'm on the tram, stop alerting me" → Find jobs matching "tram", mute until tomorrow 7:00am
- "Mute the weather job until next week" → Mute weather job until next Monday
- "Don't bother me today" → Mute all scheduled jobs until tomorrow
- "Unmute the tram reminders" → Clear mute on tram jobs
- "Show muted jobs" → List muted jobs

### Mute Until Time Calculation

When user says "stop for today" or "I'm on the tram":

- Calculate: tomorrow at 7:00am local time
- Format: ISO 8601 timestamp

When user says "until next week":

- Calculate: next Monday at 7:00am local time
- Format: ISO 8601 timestamp

### Pattern Matching Strategy

1. Extract keywords from user message (e.g., "tram", "weather", "meteo")
2. Use `jobs mute-pattern --pattern <keyword>` to match prompts/previews
3. Confirm number of jobs muted
4. Reply with confirmation including unmute time

### Example Interaction: Contextual Muting

**User:** "Sono sul tram"

**Agent Response:**

1. Identify context: user is on the tram
2. Find tram-related jobs: `ambrogioctl jobs list-recurring --json | grep -i tram`
3. Calculate mute until: tomorrow 7:00am
4. Mute jobs:
   ```bash
   ambrogioctl jobs mute-pattern --pattern "tram" --until "2026-02-14T07:00:00+01:00" --json
   ```
````

1. Reply: "Ok Signor Daniele, ho mutato 3 promemoria del tram fino a domani mattina alle 7:00."

````

### Step 2: Test natural language muting

Manually test by sending messages to the agent:
- "I'm on the tram" → Should mute tram reminders
- "Show muted jobs" → Should list muted jobs

### Step 3: Commit

```bash
git add skills/natural-scheduler/SKILL.md
git commit -m "docs: add muting examples to natural-scheduler skill

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
````

---

## Task 8: Add Background Job Prefix to Deliveries

**Files:**

- Modify: `src/main.ts`

### Step 1: Update prompt prefix in executeScheduledJob

This was already done in Task 4, Step 3. Verify the prefix is in place:

```typescript
const prefixedPrompt = `⏰ [Background Job]\n\n${prompt}`;
```

### Step 2: Test prefix delivery

Create a test delayed job and verify it includes the prefix when delivered.

### Step 3: Commit (if changes needed)

```bash
git add src/main.ts
git commit -m "feat: add background job prefix to all deliveries

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Integration Testing

**Files:**

- Create: `test/muted-jobs-integration.test.ts`

### Step 1: Write integration test

Create `test/muted-jobs-integration.test.ts`:

```typescript
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
    expect(muted[0].taskId).toBe(taskId);

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
```

### Step 2: Run integration tests

Run: `bun test test/muted-jobs-integration.test.ts`

Expected: PASS

### Step 3: Run all tests

Run: `bun test`

Expected: All tests PASS

### Step 4: Commit

```bash
git add test/muted-jobs-integration.test.ts
git commit -m "test: add integration tests for muted jobs

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Documentation and README Update

**Files:**

- Modify: `README.md`

### Step 1: Add muted reminders section to README

In `README.md`, add section after "## Job Management":

```markdown
### Muted Reminders

Temporarily mute jobs to prevent notifications until a specified time. Useful when you're already doing what the reminder was for (e.g., "I'm on the tram, stop alerting me").

**Mute operations:**

- `ambrogioctl jobs mute --id <jobId> --until <ISO timestamp>` - Mute specific job
- `ambrogioctl jobs mute-pattern --pattern <text> --until <ISO timestamp>` - Mute jobs matching pattern
- `ambrogioctl jobs unmute --id <jobId>` - Unmute job
- `ambrogioctl jobs list-muted [--limit N]` - List currently muted jobs

**Natural language:**

- "I'm on the tram" → Mutes tram-related reminders until tomorrow morning
- "Stop bothering me about weather" → Mutes weather jobs
- "Show muted jobs" → Lists muted jobs
- "Unmute the tram reminders" → Clears mute on tram jobs

**Behavior:**

- One-shot jobs: Marked as `skipped_muted` when muted, never delivered
- Recurring jobs: Continue scheduling but skip execution until unmuted
- Jobs automatically unmute when `muted_until` time passes
- All job deliveries include "⏰ [Background Job]" prefix
```

### Step 2: Commit

```bash
git add README.md
git commit -m "docs: document muted reminders feature

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 11: Final Verification and Type Check

**Files:**

- All modified files

### Step 1: Run type check

Run: `bun run typecheck`

Expected: No type errors

### Step 2: Run all tests

Run: `bun test`

Expected: All tests PASS

### Step 3: Manual end-to-end test

1. Start the agent: `bun run dev`
2. Create a recurring tram reminder
3. Say "I'm on the tram"
4. Verify reminders are muted
5. Check `ambrogioctl jobs list-muted`
6. Wait for next day and verify reminders work again

### Step 4: Final commit

```bash
git add .
git commit -m "feat: complete muted reminders implementation

- Add muted_until column to jobs table
- Add skipped_muted status for one-shot jobs
- Skip execution for muted jobs (recurring continue scheduling)
- Add CLI commands: mute, unmute, mute-pattern, list-muted
- Add natural language support via natural-scheduler skill
- Add ⏰ [Background Job] prefix to all deliveries
- Full test coverage

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Success Criteria Checklist

- [ ] User can say "I'm on the tram" and agent mutes remaining tram reminders
- [ ] Muted recurring jobs continue scheduling but don't send notifications
- [ ] Muted one-shot jobs are marked as `skipped_muted`
- [ ] Jobs automatically unmute when `muted_until` passes
- [ ] All job deliveries include "⏰ [Background Job]" prefix
- [ ] CLI supports mute/unmute with pattern matching
- [ ] Job listings show mute status
- [ ] All tests pass
- [ ] Type check passes
- [ ] Documentation updated

---

## Notes

- Use `bun test` to run tests frequently during development
- Use `bun run typecheck` to catch type errors early
- Test CLI commands with `bun run ctl --` after each implementation
- Follow TDD: write test, run (expect fail), implement, run (expect pass), commit
- Keep commits atomic and descriptive
