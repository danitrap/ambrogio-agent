import { describe, expect, test } from "bun:test";
import type { JobEntry } from "../src/runtime/state-store";
import { buildActiveJobsFastReply, isActiveJobsListQuery } from "../src/runtime/active-jobs-fast-path";

function createJob(overrides: Partial<JobEntry>): JobEntry {
  return {
    taskId: "job-1",
    kind: "recurring",
    updateId: 1,
    userId: 10,
    chatId: 20,
    command: null,
    payloadPrompt: null,
    runAt: "2026-02-24T05:00:00.000Z",
    requestPreview: "Morning check",
    status: "scheduled",
    createdAt: "2026-02-23T12:00:00.000Z",
    timedOutAt: "2026-02-23T12:01:00.000Z",
    completedAt: null,
    deliveredAt: null,
    deliveryText: null,
    errorMessage: null,
    recurrenceType: "cron",
    recurrenceExpression: "0 6 * * *",
    recurrenceMaxRuns: null,
    recurrenceRunCount: 0,
    recurrenceEnabled: true,
    mutedUntil: null,
    ...overrides,
  };
}

describe("active-jobs-fast-path", () => {
  test("recognizes italian active jobs query", () => {
    expect(isActiveJobsListQuery("Quali job ci sono?"))
      .toBe(true);
    expect(isActiveJobsListQuery("Mi fai vedere i job attivi?"))
      .toBe(true);
  });

  test("does not match non-listing job requests", () => {
    expect(isActiveJobsListQuery("Annulla il job rc-rpc-123"))
      .toBe(false);
  });

  test("formats active jobs summary", () => {
    const jobs = [
      createJob({ taskId: "job-b", runAt: "2026-02-25T05:00:00.000Z", requestPreview: "B task" }),
      createJob({ taskId: "job-a", runAt: "2026-02-24T05:00:00.000Z", requestPreview: "A task" }),
      createJob({
        taskId: "job-running",
        kind: "background",
        status: "running",
        runAt: null,
        requestPreview: "Long operation",
      }),
      createJob({
        taskId: "job-muted",
        runAt: "2026-02-24T06:00:00.000Z",
        mutedUntil: "2099-01-01T00:00:00.000Z",
      }),
    ];

    const reply = buildActiveJobsFastReply(jobs);

    expect(reply).toContain("Job attivi: 4");
    expect(reply).toContain("job-a");
    expect(reply).toContain("job-b");
    expect(reply).toContain("job-running");
    expect(reply).toContain("job-muted");
    expect(reply).toContain("mutedUntil=2099-01-01T00:00:00.000Z");
    expect(reply).toContain("unmuted");
  });

  test("handles empty active jobs list", () => {
    const reply = buildActiveJobsFastReply([]);
    expect(reply).toContain("Nessun job attivo");
  });
});
