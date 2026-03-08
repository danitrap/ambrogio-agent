# Suppress Tool Call Updates For Jobs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Estendere ai job non interattivi lo stesso comportamento dell'heartbeat, così cron job, delayed job, recurring job e background job non inviano aggiornamenti Telegram sui tool call mentre eseguono.

**Architecture:** Oggi l'heartbeat passa un flag esplicito che rimuove `onToolCallEvent` dalla request verso il model bridge. I job invece attraversano percorsi diversi in `main.ts` e continuano a usare la callback `notifyToolCallUpdate`. La soluzione più solida è introdurre un'opzione di esecuzione riusabile per i run non interattivi e applicarla in tutti gli entrypoint headless invece di spargere controlli speciali.

**Tech Stack:** Bun, TypeScript strict mode, Telegram runtime, `AmbrogioAgentService`, model bridge callbacks, Bun test.

---

### Task 1: Pin The Current Heartbeat Contract With Regression Coverage

**Files:**
- Modify: `/Users/daniele/Code/agent/test/heartbeat-runner.test.ts`
- Test: `/Users/daniele/Code/agent/test/heartbeat-runner.test.ts`

**Step 1: Add one explicit regression assertion name for the heartbeat contract**

Extend the existing heartbeat suppression test so the intent is unmistakable:

```ts
test("passes suppressToolCallUpdates=true to heartbeat model execution", async () => {
  let suppressToolCallUpdates: boolean | null = null;
  // create runner...
  expect(suppressToolCallUpdates).toBe(true);
});
```

**Step 2: Run the focused heartbeat test**

Run: `bun test test/heartbeat-runner.test.ts`

Expected: PASS and the suppression assertion stays green.

**Step 3: Commit**

```bash
git add test/heartbeat-runner.test.ts
git commit -m "test: pin heartbeat tool call suppression contract"
```

### Task 2: Add Failing Coverage For Non-Interactive Job Executions

**Files:**
- Create: `/Users/daniele/Code/agent/test/job-toolcall-suppression.test.ts`
- Modify: `/Users/daniele/Code/agent/src/main.ts`
- Test: `/Users/daniele/Code/agent/test/job-toolcall-suppression.test.ts`

**Step 1: Write a failing test for scheduled job execution**

Create a narrow seam around the scheduled-job path and assert that `ambrogioAgent.handleMessage(...)` is invoked without live tool call updates when the job kind is `delayed` or `recurring`.

Suggested test shape:

```ts
test("scheduled jobs run without tool call updates", async () => {
  let receivedOnToolCallEvent: unknown = Symbol("unset");

  const handleMessage = async (
    _userId: number,
    _prompt: string,
    _requestId?: string,
    _signal?: AbortSignal,
    onToolCallEvent?: unknown,
  ) => {
    receivedOnToolCallEvent = onToolCallEvent;
    return "[HEADLESS_NO_MESSAGE]";
  };

  await executeScheduledJobForTest(/* delayed or recurring job */);

  expect(receivedOnToolCallEvent).toBeUndefined();
});
```

**Step 2: Write a failing test for timeout-detached background continuation**

Assert that when a foreground request times out and continues in background, the detached completion path does not keep emitting tool call updates.

Suggested test shape:

```ts
test("soft-timeout background jobs suppress tool call updates after detaching", async () => {
  const toolCallEvents: string[] = [];
  // trigger timeout path
  // complete deferred operation
  expect(toolCallEvents).toEqual([]);
});
```

**Step 3: Run the new focused test file**

Run: `bun test test/job-toolcall-suppression.test.ts`

Expected: FAIL because the current scheduled/background paths still wire `notifyToolCallUpdate`.

**Step 4: Commit**

```bash
git add test/job-toolcall-suppression.test.ts src/main.ts
git commit -m "test: cover tool call suppression for jobs"
```

### Task 3: Introduce A Reusable Silent Tool-Event Execution Option

**Files:**
- Modify: `/Users/daniele/Code/agent/src/app/ambrogio-agent-service.ts`
- Modify: `/Users/daniele/Code/agent/src/main.ts`
- Modify: `/Users/daniele/Code/agent/test/ambrogio-agent-service.test.ts`
- Test: `/Users/daniele/Code/agent/test/ambrogio-agent-service.test.ts`

**Step 1: Refactor `AmbrogioAgentService.handleMessage` to accept execution options**

Replace the raw fifth positional callback with a small options object so headless behavior is first-class and reusable.

Target shape:

```ts
type HandleMessageOptions = {
  signal?: AbortSignal;
  onToolCallEvent?: (event: ModelToolCallEvent) => Promise<void> | void;
  suppressToolCallUpdates?: boolean;
};
```

Then map it internally like this:

```ts
const onToolCallEvent = options?.suppressToolCallUpdates
  ? undefined
  : options?.onToolCallEvent;
```

**Step 2: Preserve existing interactive behavior**

Update all current interactive call sites to pass:

```ts
{
  signal,
  onToolCallEvent: notifyToolCallUpdate,
}
```

No user-triggered chat path should lose live tool call updates.

**Step 3: Update the service test suite**

Add a passing regression test:

```ts
test("drops onToolCallEvent when suppressToolCallUpdates is true", async () => {
  let seenEventCallback: unknown = Symbol("unset");
  // respond stores request.onToolCallEvent
  await service.handleMessage(1, "ciao", "req-1", {
    onToolCallEvent: callback,
    suppressToolCallUpdates: true,
  });
  expect(seenEventCallback).toBeUndefined();
});
```

Keep the existing forwarding test for the default interactive case.

**Step 4: Run the service tests**

Run: `bun test test/ambrogio-agent-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/app/ambrogio-agent-service.ts src/main.ts test/ambrogio-agent-service.test.ts
git commit -m "refactor: add explicit silent tool event execution option"
```

### Task 4: Apply Silent Execution To Scheduled Jobs

**Files:**
- Modify: `/Users/daniele/Code/agent/src/main.ts`
- Modify: `/Users/daniele/Code/agent/test/job-toolcall-suppression.test.ts`
- Test: `/Users/daniele/Code/agent/test/job-toolcall-suppression.test.ts`

**Step 1: Update `executeScheduledJob` to opt into suppression**

Change the scheduled-job `handleMessage` call to:

```ts
await ambrogioAgent.handleMessage(
  job.userId,
  prefixedPrompt,
  `delayed-${job.taskId}`,
  {
    suppressToolCallUpdates: true,
  },
);
```

If the refactor keeps `signal` support here, pass it only if truly available. Scheduled jobs should not route `notifyToolCallUpdate`.

**Step 2: Keep delivery semantics unchanged**

Do not touch:
- headless prompt markers in [`src/runtime/scheduled-job-headless.ts`](/Users/daniele/Code/agent/src/runtime/scheduled-job-headless.ts)
- `HEADLESS_*` suppression tokens
- delivery/reschedule state transitions

This change is only about suppressing live tool-call progress updates.

**Step 3: Run the job suppression tests**

Run: `bun test test/job-toolcall-suppression.test.ts`

Expected: the scheduled-job assertion now passes.

**Step 4: Commit**

```bash
git add src/main.ts test/job-toolcall-suppression.test.ts
git commit -m "fix: suppress tool call updates for scheduled jobs"
```

### Task 5: Apply Silent Execution To Soft-Timeout Background Jobs

**Files:**
- Modify: `/Users/daniele/Code/agent/src/main.ts`
- Modify: `/Users/daniele/Code/agent/test/job-toolcall-suppression.test.ts`
- Test: `/Users/daniele/Code/agent/test/job-toolcall-suppression.test.ts`

**Step 1: Separate foreground interactivity from detached continuation**

Keep the foreground attempt interactive while the request is within the soft timeout, but make the detached background execution silent once the runtime has already told the user "continuo in background".

Recommended implementation direction:
- extend `startOperationWithTyping(...)` or the timeout wrapper so the operation factory can distinguish:
  - foreground interactive execution
  - detached/background completion handling
- when the request transitions to background, the underlying model execution must no longer publish tool call updates to Telegram

If the current structure makes that awkward, extract a helper from `main.ts`:

```ts
type AgentRunMode = "interactive" | "background" | "scheduled" | "heartbeat";
```

and resolve callback wiring in one place.

**Step 2: Ensure no regression in final delivery**

The detached background path must still:
- mark job completion/failure in SQLite
- deliver the final result via `deliverBackgroundJob(...)`
- retry via heartbeat when delivery fails

Only intermediate tool-call progress must disappear.

**Step 3: Run the focused job suppression test again**

Run: `bun test test/job-toolcall-suppression.test.ts`

Expected: both scheduled and background suppression assertions PASS.

**Step 4: Commit**

```bash
git add src/main.ts test/job-toolcall-suppression.test.ts
git commit -m "fix: suppress tool call updates for detached background jobs"
```

### Task 6: Full Verification

**Files:**
- Modify: `/Users/daniele/Code/agent/docs/plans/2026-03-08-suppress-toolcall-updates-jobs.md` (checklist/progress notes only if desired)

**Step 1: Run targeted tests**

Run: `bun test test/heartbeat-runner.test.ts test/ambrogio-agent-service.test.ts test/job-toolcall-suppression.test.ts`

Expected: PASS.

**Step 2: Run broader regression coverage**

Run: `bun test`

Expected: PASS.

**Step 3: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

**Step 4: Rebuild runtime stack**

Run: `docker compose up -d --build`

Expected: containers rebuilt and running with the new silent-job behavior.

**Step 5: Manual validation**

Validate these scenarios:
- manual user prompt still streams tool-call updates in Telegram
- `/heartbeat` and timer heartbeat still stay silent on tool calls
- one-shot delayed job runs without tool-call spam and still sends a final message only if the skill/tool decides to notify
- recurring cron job runs without tool-call spam and still respects headless delivery suppression
- a forced soft-timeout request returns a background job ID and later delivers only the final outcome

**Step 6: Commit**

```bash
git add docs/plans/2026-03-08-suppress-toolcall-updates-jobs.md
git commit -m "docs: finalize silent tool call jobs plan"
```
