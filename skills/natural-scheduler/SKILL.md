---
name: natural-scheduler
description: Manage Ambrogio runtime jobs (background, delayed, recurring, muted) from natural-language scheduling requests.
---

# Natural Scheduler

## Use This Skill When
- The user asks to schedule, inspect, pause, resume, retry, mute, or cancel runtime jobs.

## Do Not Use This Skill When
- The request is clearly TODO-list management (use `todo-manager`).

## Hard Rules
- Execute job operations only via `ambrogioctl ... --json`.
- Never invent job IDs.
- Never output raw JSON to user.
- Never pass `--user-id` or `--chat-id` for jobs create operations. `ambrogioctl` must infer both from `TELEGRAM_ALLOWED_USER_ID`.
- If TODO vs runtime job is ambiguous, ask explicit confirmation.
- Always surface mute state in job summaries:
  - include `mutedUntil=<ISO>` when mute is active,
  - include `unmuted` otherwise.

## Intent-to-Command Map
- List jobs: `ambrogioctl jobs list --json`
- Inspect: `ambrogioctl jobs inspect --id <jobId> --json`
- Create delayed: `ambrogioctl jobs create --run-at <ISO> --prompt "<text>" --json`
- Create recurring: `ambrogioctl jobs create-recurring --run-at <ISO> --prompt "<text>" --type <interval|cron> --expression <expr> --json`
- Retry: `ambrogioctl jobs retry --id <jobId> --json`
- Cancel: `ambrogioctl jobs cancel --id <jobId> --json`
- Pause/resume: `ambrogioctl jobs pause|resume --id <jobId> --json`
- Update recurrence: `ambrogioctl jobs update-recurrence --id <jobId> --expression <expr> --json`
- Mute: `ambrogioctl jobs mute --id <jobId> --until <ISO> --json`
- Unmute: `ambrogioctl jobs unmute --id <jobId> --json`
- List recurring: `ambrogioctl jobs list-recurring --json`
- List muted: `ambrogioctl jobs list-muted --json`

## Prompt Transformation Rule (Critical)
When creating delayed/recurring jobs, `--prompt` must be delivery-ready text, not a new request.

- Bad: `Ricorda a Daniele di comprare il latte`
- Good: `Promemoria: comprare il latte.`

## Time Handling
- Convert natural language time to absolute ISO.
- If missing/ambiguous time, ask one concise clarification.

## Mute Behavior (Critical)
- `mute` sets `mutedUntil` on the job; it does NOT pause or delete the job.
- While `mutedUntil` is in the future, runtime skips execution/delivery for that job.
- For recurring jobs, schedule continues and next run is recalculated as usual.
- For one-shot/delayed jobs, a muted due run is marked as skipped (`skipped_muted`).
- When `mutedUntil` expires, the job is considered unmuted automatically.
- To inspect mute state:
  - use `ambrogioctl jobs list --json` or `ambrogioctl jobs list-recurring --json` and read `mutedUntil`,
  - use `ambrogioctl jobs list-muted --json` for active mutes only.

## Output Contract
- Confirm operation result in plain language.
- Include job id, schedule time/pattern, and status.
