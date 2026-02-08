---
name: natural-scheduler
description: Manage runtime tasks in natural language by calling ambrogioctl over the local task RPC socket.
---

# Natural Scheduler

Handle runtime task operations directly from natural-language requests.

## Scope

- Runtime tasks only (`delayed/background` tasks handled by Ambrogio).
- For TODO list operations, delegate to the `todo-manager` skill.

## Hard Rules

- Do not output JSON to the user.
- Do not invent task IDs.
- Always execute task operations through `ambrogioctl`.
- If request is ambiguous between runtime task and TODO, ask explicit confirmation before executing.

## CLI Path Resolution

Use one of these commands (in order):

1. `bun run /app/src/cli/ambrogioctl.ts ...` (Docker runtime)
2. `bun run /data/../src/cli/ambrogioctl.ts ...` (local dev from `/data`)

Always append `--json` and parse results before replying.

## Supported Intents (Runtime Tasks)

- List tasks:
  - `... tasks list --json`
- Inspect task:
  - `... tasks inspect --id <taskId> --json`
- Create delayed task:
  - `... tasks create --run-at <ISO> --prompt "<text>" --user-id <id> --chat-id <id> --json`
- Cancel task:
  - `... tasks cancel --id <taskId> --json`
- Retry delivery:
  - `... tasks retry --id <taskId> --json`

## Time Handling

- Convert natural-time requests to absolute ISO timestamp before `tasks create`.
- If time is missing/ambiguous, ask for clarification.
- If user says "tra X minuti", compute from current local time and confirm the resolved schedule in response.

## Disambiguation Policy

- If user says generic "lista", "task", "promemoria", "todo" and domain is unclear:
  - Ask: "Vuole i task runtime o la TODO list?"
- Execute only after explicit user confirmation.

## Response Style

- Keep response concise and user-facing.
- Include task ID when action creates/cancels/retries a specific task.
- For list operations, summarize top entries and key statuses.
