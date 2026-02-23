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

## Output Contract
- Confirm operation result in plain language.
- Include job id, schedule time/pattern, and status.
