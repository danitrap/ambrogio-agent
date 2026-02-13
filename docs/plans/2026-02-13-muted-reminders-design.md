# Muted Reminders Design

**Date:** 2026-02-13
**Status:** Approved

## Overview

Add temporary muting capability to background jobs (reminders) with automatic expiration. When a user is on the tram, they can tell the agent to stop alerting about remaining tram schedules for the day, and reminders automatically resume the next morning.

## Use Case

User has 3 recurring tram reminders at 8:00am, 8:15am, and 8:30am. At 8:10am they board the 8:00 tram and say "I'm on the tram, stop alerting me about tram schedules." The agent mutes the 8:15am and 8:30am reminders until tomorrow morning. The next day, all three reminders work normally again.

## Core Concept

**Muting behavior:**
- Add `muted_until` (nullable ISO timestamp) column to jobs table
- When a job's scheduled run time arrives:
  - If `muted_until` is NULL or in the past → execute normally (send notification with prefix)
  - If `muted_until` is in the future → skip execution entirely, no notification sent
- For recurring jobs: continue scheduling next runs regardless of mute status
- For one-shot jobs: mark as `"skipped_muted"` when skipped due to mute
- Muting is temporary and time-bound - jobs automatically unmute when `muted_until` passes

**Prompt prefix for all job deliveries:**
When any job (delayed or recurring) executes and delivers its prompt, prefix the message with:
```
⏰ [Background Job]

{original prompt content}
```

This makes it clear the message is from a scheduled job/cron, not a conversational response.

## Database Schema Changes

**New column:**
```sql
ALTER TABLE jobs ADD COLUMN muted_until TEXT NULL;
```

**Behavior:**
- `muted_until = NULL` → job executes normally
- `muted_until = ISO timestamp` → job is muted until that time

**New status value:**
- Add `"skipped_muted"` to `JobStatus` type enum
- Used when a one-shot job is skipped due to muting
- Recurring jobs don't change status when muted, they just skip the execution cycle

**Migration strategy:**
- Add column with default NULL (all existing jobs unmuted by default)
- Update `StateStore.ensureJobsTable()` to include new column in schema
- Fully backwards compatible - NULL means "not muted"

## Job Execution Logic

**Before executing a job, check mute status:**

```typescript
if (job.mutedUntil) {
  const mutedUntilDate = new Date(job.mutedUntil);
  const now = new Date();

  if (mutedUntilDate > now) {
    // Job is currently muted - skip execution
    if (job.kind === 'delayed') {
      // One-shot: mark as skipped_muted
      stateStore.updateJobStatus(job.taskId, 'skipped_muted');
    } else if (job.kind === 'recurring') {
      // Recurring: increment run count, schedule next run, but don't execute
      stateStore.incrementRecurringRunCount(job.taskId);
      scheduleNextRun(job);
    }
    return; // Skip execution - no prompt execution, no notification
  }
}

// Normal execution path...
// Add "⏰ [Background Job]\n\n" prefix to delivery message
```

**For recurring jobs when muted:**
- Still advance the schedule (next run time calculated normally)
- Still increment run count (counts as a "run" even though muted)
- Don't execute the prompt with Codex
- Don't send any notification to Telegram

**For one-shot jobs when muted:**
- Set status to `"skipped_muted"`
- Never delivered, never retried
- Remains in history for audit purposes

## CLI Interface

**New ambrogioctl commands:**

1. **Mute specific job:**
   ```bash
   ambrogioctl jobs mute --id <jobId> --until <ISO timestamp> --json
   ```
   Sets `muted_until` on a single job.

2. **Mute multiple jobs by pattern:**
   ```bash
   ambrogioctl jobs mute-pattern --pattern "tram" --until <ISO timestamp> --json
   ```
   - Searches job prompts and request previews for pattern match
   - Mutes all matching jobs with same `muted_until` timestamp
   - Returns count of jobs muted

3. **Unmute job (clear mute):**
   ```bash
   ambrogioctl jobs unmute --id <jobId> --json
   ```
   Sets `muted_until = NULL` (immediate unmute).

4. **List muted jobs:**
   ```bash
   ambrogioctl jobs list --muted-only --json
   ```
   Returns only jobs where `muted_until IS NOT NULL AND muted_until > now()`.

5. **Show mute status in regular list:**
   Add `mutedUntil` field to job list output, display with 🔇 indicator.

## Natural Language Interface

**Update natural-scheduler skill to handle:**

- "Stop alerting me about tram schedules" → Find jobs matching "tram", mute until tomorrow morning (7am)
- "Mute the weather job until next week" → Mute specific job until computed date
- "I'm on the tram" → Contextual muting - find tram-related jobs, mute for rest of day
- "Unmute the tram reminders" → Clear mute on matching jobs
- "Show muted jobs" → List jobs where `muted_until IS NOT NULL AND muted_until > now()`

**Agent behavior when user indicates they're done with a reminder category:**

1. Identify relevant jobs using keyword matching (fuzzy search in prompt and request_preview)
2. Calculate appropriate `muted_until`:
   - For "I'm on the tram" → mute until tomorrow morning (7:00am local time)
   - For "stop for today" → mute until tomorrow morning
   - For "stop for the week" → mute until next Monday 7:00am
   - For explicit time → use that timestamp
3. Call `ambrogioctl jobs mute-pattern` or individual `mute` commands
4. Confirm to user: "Muted 3 tram reminders until tomorrow at 7:00am"

## Implementation Files

**Core changes:**
- `src/runtime/state-store.ts` - Add `muted_until` column, new methods for muting
- `src/runtime/job-rpc-server.ts` - Add RPC handlers for mute/unmute commands
- `src/cli/ambrogioctl.ts` - Add CLI commands for mute operations
- Job runner (likely in `src/main.ts` or heartbeat) - Add mute check before execution
- Message delivery - Add "⏰ [Background Job]" prefix to all job deliveries

**Skill updates:**
- `skills/natural-scheduler/SKILL.md` - Add natural language muting examples and patterns

**Tests:**
- `test/recurring-jobs.test.ts` - Add muting scenarios for recurring jobs
- `test/state-store.test.ts` - Test mute column and status transitions
- New test file for mute-pattern matching logic

## Success Criteria

1. User can say "I'm on the tram" and agent mutes remaining tram reminders until tomorrow
2. Muted recurring jobs continue scheduling but don't send notifications
3. Muted one-shot jobs are marked as `skipped_muted` and never delivered
4. Jobs automatically unmute when `muted_until` timestamp passes
5. All job deliveries include "⏰ [Background Job]" prefix
6. CLI supports mute/unmute operations with pattern matching
7. Job listings show mute status clearly

## Future Enhancements (Not in Scope)

- Mute all jobs globally (user-level mute)
- Mute by time window (e.g., "mute between 10pm-6am")
- Smart muting based on location or calendar events
