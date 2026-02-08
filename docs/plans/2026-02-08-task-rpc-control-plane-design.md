# Task RPC Control Plane Design

Date: 2026-02-08
Status: Validated (brainstorming)
Scope: Runtime task control plane only (no TODO mutation in v1)

## Context

The current system supports runtime/background/delayed tasks and natural-language scheduling. Task operations are available through runtime internals and legacy Telegram slash commands. We want a robust integration path so skills can invoke task operations without duplicating business logic in prompts.

The goal is to let Codex skills call a local interface (`ambrogioctl`) that talks to the running Ambrogio process, while Ambrogio remains the source of truth for task state, transitions, and audit logging.

## Decisions

- Transport: Unix Domain Socket (UDS)
- Security model: filesystem ACL only (no application token in v1)
- Scope v1: runtime tasks only
- API style: line-delimited JSON RPC
- UX rule: ambiguous runtime-task vs TODO intent requires explicit confirmation before mutation

## Why This Approach

This design centralizes state and invariants in Ambrogio and keeps skills thin. Skills and CLI become adapters rather than owners of domain logic. That avoids drift and conflicting behavior across prompt-driven workflows.

UDS keeps the control plane local and non-network exposed by default. JSONL RPC avoids HTTP boilerplate and is easy to test in Bun with deterministic request/response envelopes.

## Architecture

### Components

- `TaskRpcServer` (new): lives in Ambrogio runtime process and handles RPC operations.
- `StateStore` (existing): remains source of truth for task persistence and transitions.
- `ambrogioctl` (new CLI): thin UDS client used by skills and operators.
- `Skill orchestrator` (existing/new prompt contract): interprets natural language, asks confirmation when ambiguous, calls `ambrogioctl` only after disambiguation.

### Socket

- Path: `/tmp/ambrogio-agent.sock` (override via `AMBROGIO_SOCKET_PATH`)
- Lifecycle:
  - remove stale socket on startup
  - bind and listen during runtime
  - close/unlink on shutdown
- Permissions: restrictive owner-only ACL (`0600` target)

## RPC Contract (v1)

One JSON request per line, one JSON response per line.

### Request Envelope

```json
{"op":"tasks.list","args":{"limit":20}}
```

### Response Envelope

Success:

```json
{"ok":true,"result":{}}
```

Failure:

```json
{"ok":false,"error":{"code":"NOT_FOUND","message":"Task non trovato"}}
```

### Operations

- `tasks.list`
  - args: `{ "limit"?: number, "status"?: string[] }`
  - result: task summary list
- `tasks.inspect`
  - args: `{ "taskId": string }`
  - result: full task details
- `tasks.create`
  - args: `{ "runAtIso": string, "prompt": string, "requestPreview"?: string, "chatId": number, "userId": number }`
  - result: created task metadata
- `tasks.cancel`
  - args: `{ "taskId": string }`
  - result: cancellation outcome
- `tasks.retry`
  - args: `{ "taskId": string }`
  - result: delivery retry outcome

### Error Codes

- `BAD_REQUEST`: malformed JSON, missing args, unknown op
- `NOT_FOUND`: task id missing in store
- `INVALID_STATE`: transition not allowed for current status
- `INVALID_TIME`: invalid/past `runAtIso`
- `INTERNAL`: unexpected runtime/database/server failure

## CLI: `ambrogioctl`

Subcommands (v1):

- `ambrogioctl tasks list [--limit N] [--json]`
- `ambrogioctl tasks inspect --id <taskId> [--json]`
- `ambrogioctl tasks create --run-at <ISO> --prompt <text> --chat-id <id> --user-id <id> [--json]`
- `ambrogioctl tasks cancel --id <taskId> [--json]`
- `ambrogioctl tasks retry --id <taskId> [--json]`

Exit codes:

- `0` success
- `2` bad request / invalid input
- `3` not found
- `4` invalid state/time
- `10` internal/transient failure

## Disambiguation Policy (Runtime Tasks vs TODO)

Even with runtime-task-only control plane, intent parsing can overlap with TODO language. Policy:

- If intent is ambiguous, do not mutate state.
- Ask explicit confirmation first.
- Only call `ambrogioctl` after user confirms runtime-task action.
- Route confirmed TODO requests to TODO-specific workflow/skill (outside this API scope).

This keeps task control deterministic and prevents accidental mutation.

## Observability and Audit

Every RPC call should emit structured logs:

- `task_rpc_request` (op, caller, correlation id)
- `task_rpc_result` (op, ok/error code, duration, task id when present)

Do not log full sensitive payloads when avoidable; include normalized previews.

## Backward Compatibility

Legacy slash commands (`/tasks`, `/task`, `/retrytask`, `/canceltask`) remain available for debugging in short term. Over time, internal command handlers can migrate to the same RPC handlers to reduce duplicate logic.

## TDD Implementation Plan

1. Contract-first tests for RPC server (`test/task-rpc-server.test.ts`)
2. Implement minimal `TaskRpcServer` with envelope/error mapping
3. CLI tests (`test/ambrogioctl.test.ts`)
4. Implement `ambrogioctl` client against UDS
5. Integrate server startup/shutdown in `src/main.ts`
6. Add integration tests for create/list/cancel/retry flows
7. Update skills to call `ambrogioctl`
8. Update docs and operational notes

## Out of Scope (v1)

- TODO CRUD via RPC
- Remote network access to control plane
- Multi-user auth model beyond current single allowlisted user
- Streaming/multipart RPC operations

## Ready for Implementation

The design is intentionally narrow (YAGNI) and suitable for TDD-first execution in incremental milestones.
