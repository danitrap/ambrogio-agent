# Job RPC Control Plane Design

Date: 2026-02-08
Status: Validated (brainstorming)
Scope: Runtime job control plane only (no TODO mutation in v1)

## Context

The current system supports runtime/background/delayed jobs and natural-language scheduling. Job operations are available through runtime internals and legacy Telegram slash commands. We want a robust integration path so skills can invoke job operations without duplicating business logic in prompts.

The goal is to let Codex skills call a local interface (`ambrogioctl`) that talks to the running Ambrogio process, while Ambrogio remains the source of truth for job state, transitions, and audit logging.

## Decisions

- Transport: Unix Domain Socket (UDS)
- Security model: filesystem ACL only (no application token in v1)
- Scope v1: runtime jobs only
- API style: line-delimited JSON RPC
- UX rule: ambiguous runtime-job vs TODO intent requires explicit confirmation before mutation

## Why This Approach

This design centralizes state and invariants in Ambrogio and keeps skills thin. Skills and CLI become adapters rather than owners of domain logic. That avoids drift and conflicting behavior across prompt-driven workflows.

UDS keeps the control plane local and non-network exposed by default. JSONL RPC avoids HTTP boilerplate and is easy to test in Bun with deterministic request/response envelopes.

## Architecture

### Components

- `JobRpcServer` (new): lives in Ambrogio runtime process and handles RPC operations.
- `StateStore` (existing): remains source of truth for job persistence and transitions.
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
{"op":"jobs.list","args":{"limit":20}}
```

### Response Envelope

Success:

```json
{"ok":true,"result":{}}
```

Failure:

```json
{"ok":false,"error":{"code":"NOT_FOUND","message":"Job non trovato"}}
```

### Operations

- `jobs.list`
  - args: `{ "limit"?: number, "status"?: string[] }`
  - result: job summary list
- `jobs.inspect`
  - args: `{ "jobId": string }`
  - result: full job details
- `jobs.create`
  - args: `{ "runAtIso": string, "prompt": string, "requestPreview"?: string, "chatId": number, "userId": number }`
  - result: created job metadata
- `jobs.cancel`
  - args: `{ "jobId": string }`
  - result: cancellation outcome
- `jobs.retry`
  - args: `{ "jobId": string }`
  - result: delivery retry outcome

### Error Codes

- `BAD_REQUEST`: malformed JSON, missing args, unknown op
- `NOT_FOUND`: job id missing in store
- `INVALID_STATE`: transition not allowed for current status
- `INVALID_TIME`: invalid/past `runAtIso`
- `INTERNAL`: unexpected runtime/database/server failure

## CLI: `ambrogioctl`

Subcommands (v1):

- `ambrogioctl jobs list [--limit N] [--json]`
- `ambrogioctl jobs inspect --id <jobId> [--json]`
- `ambrogioctl jobs create --run-at <ISO> --prompt <text> --chat-id <id> --user-id <id> [--json]`
- `ambrogioctl jobs cancel --id <jobId> [--json]`
- `ambrogioctl jobs retry --id <jobId> [--json]`

Exit codes:

- `0` success
- `2` bad request / invalid input
- `3` not found
- `4` invalid state/time
- `10` internal/transient failure

## Disambiguation Policy (Runtime Jobs vs TODO)

Even with runtime-job-only control plane, intent parsing can overlap with TODO language. Policy:

- If intent is ambiguous, do not mutate state.
- Ask explicit confirmation first.
- Only call `ambrogioctl` after user confirms runtime-job action.
- Route confirmed TODO requests to TODO-specific workflow/skill (outside this API scope).

This keeps job control deterministic and prevents accidental mutation.

## Observability and Audit

Every RPC call should emit structured logs:

- `job_rpc_request` (op, caller, correlation id)
- `job_rpc_result` (op, ok/error code, duration, job id when present)

Do not log full sensitive payloads when avoidable; include normalized previews.

## Backward Compatibility

Legacy slash commands remain available for debugging in short term. The `tasks` scope in CLI is deprecated but supported (mapped to `jobs` internally).

## TDD Implementation Plan

1. Contract-first tests for RPC server (`test/job-rpc-server.test.ts`)
2. Implement minimal `JobRpcServer` with envelope/error mapping
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
