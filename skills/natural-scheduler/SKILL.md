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
- Always append `--json` to ambrogioctl commands and parse results before replying.

## Supported Intents (Runtime Tasks)

- List tasks:
  - `ambrogioctl tasks list --json`
- Inspect task:
  - `ambrogioctl tasks inspect --id <taskId> --json`
- Create delayed task:
  - `ambrogioctl tasks create --run-at <ISO> --prompt "<text>" --user-id <id> --chat-id <id> --json`
- Cancel task:
  - `ambrogioctl tasks cancel --id <taskId> --json`
- Retry delivery:
  - `ambrogioctl tasks retry --id <taskId> --json`

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
