# macOS Native Tools Service (GTD) Implementation Plan

> **Goal:** Implement a native macOS read-only tools service for Calendar and Reminders (with GTD tags), exposed via Unix socket JSON-RPC and consumable through `ambrogioctl`.

**Date:** 2026-02-23
**Status:** Proposed
**Depends on:** `docs/plans/2026-02-23-mac-tools-service-gtd-design.md`

## Task 1: Define Types and RPC Contracts

**Files:**
- Create: `src/mac-tools/types.ts`

**Steps:**
1. Add shared request/response envelope types (`RpcRequest`, `RpcSuccess`, `RpcError`).
2. Add method-specific params/results:
- `SystemPingResult`
- `SystemInfoResult`
- `CalendarUpcomingParams`, `CalendarUpcomingResult`
- `RemindersOpenParams`, `RemindersOpenResult`
3. Add error code union:
- `"permission_denied" | "invalid_params" | "timeout" | "internal_error" | "method_not_found"`

**Verification:**
- `bun run typecheck`

## Task 2: Build mac-tools Service Skeleton

**Files:**
- Create: `src/mac-tools/mac-tools-service.ts`

**Steps:**
1. Create Unix socket server (default `/tmp/ambrogio-mac-tools.sock`, configurable via `AMBROGIO_MAC_TOOLS_SOCKET_PATH`).
2. Parse JSON input as RPC request envelope.
3. Add deny-by-default method router.
4. Implement methods:
- `system.ping`
- `system.info`
5. Add structured error responses with stable codes.
6. Enforce socket permissions (`0600`) after bind.

**Verification:**
- unit test socket request/response with mock handlers
- `bun run typecheck`

## Task 3: Implement Calendar Provider (Read-Only)

**Files:**
- Create: `src/mac-tools/providers/calendar-provider.ts`

**Steps:**
1. Implement adapter that retrieves events for a bounded window.
2. Validate params:
- `days` default `7`, max `30`
- `limit` default `100`, max `500`
3. Map native objects to DTO (`id`, `calendarName`, `title`, `startAt`, `endAt`, `allDay`, optional fields).
4. Add timeout guard.
5. Map permission failures to `permission_denied` with instructions.

**Verification:**
- provider unit tests (mapping and param bounds)
- `bun run typecheck`

## Task 4: Implement Reminders Provider (Read-Only + GTD Fields)

**Files:**
- Create: `src/mac-tools/providers/reminders-provider.ts`

**Steps:**
1. Implement open reminders retrieval.
2. Validate params:
- `limit` default `200`, max `1000`
- `includeNoDueDate` default `true`
3. Map DTO with GTD-relevant fields:
- `id`, `listName`, `title`, `dueAt`, `priority`, `isFlagged`, `tags`, `notesPreview`
4. Add stable sorting:
1. due date ascending (nulls last if included)
2. flagged first within same due date
3. title lexical fallback
5. Map permission failures to `permission_denied` with instructions.

**Verification:**
- provider unit tests (tags extraction, sorting, no-due behavior)
- `bun run typecheck`

## Task 5: Wire Service Methods to Providers

**Files:**
- Modify: `src/mac-tools/mac-tools-service.ts`

**Steps:**
1. Register `calendar.upcoming` and `reminders.open` routes.
2. Add method-level param validation and response shaping.
3. Ensure all errors are converted to standard RPC error envelope.

**Verification:**
- integration tests for all 4 methods (`ping`, `info`, `calendar.upcoming`, `reminders.open`)
- `bun test`

## Task 6: Extend `ambrogioctl` with `mac` Scope

**Files:**
- Modify: `src/cli/ambrogioctl.ts`

**Steps:**
1. Add top-level command scope: `mac`.
2. Add subcommands:
- `ambrogioctl mac ping [--json]`
- `ambrogioctl mac info [--json]`
- `ambrogioctl mac calendar upcoming [--days N --limit N --timezone TZ --json]`
- `ambrogioctl mac reminders open [--limit N --include-no-due-date true|false --json]`
3. Reuse existing socket transport style and output patterns.
4. Keep default text output concise; `--json` for raw result.

**Verification:**
- add CLI tests in `test/ambrogioctl.test.ts`
- `bun test test/ambrogioctl.test.ts`
- `bun run typecheck`

## Task 7: Integrate Service Lifecycle in Main App

**Files:**
- Modify: `src/main.ts`
- (Optional) Create: `src/runtime/mac-tools-lifecycle.ts`

**Steps:**
1. Add config gates:
- `MAC_TOOLS_ENABLED` (default `false`)
- `AMBROGIO_MAC_TOOLS_SOCKET_PATH` (default `/tmp/ambrogio-mac-tools.sock`)
2. Start service on app boot when enabled.
3. Run startup healthcheck (`system.ping`, then `system.info`).
4. Add graceful shutdown and socket cleanup.
5. Add crash restart with capped exponential backoff.

**Verification:**
- lifecycle integration tests
- `bun test`
- `bun run typecheck`

## Task 8: Add Tests for Contract and Error Behavior

**Files:**
- Create: `test/mac-tools-service.test.ts`
- Create: `test/mac-tools-providers.test.ts`
- Modify: `test/ambrogioctl.test.ts`

**Coverage:**
1. method allowlist and `method_not_found`
2. invalid params -> `invalid_params`
3. simulated denied permissions -> `permission_denied` with instructions
4. timeout -> `timeout`
5. successful reminders payload includes `tags` and `isFlagged`

**Verification:**
- `bun test`
- `bun run typecheck`

## Task 9: Documentation and Environment Updates

**Files:**
- Modify: `.env.example`
- (Optional) Modify: `README.md`

**Steps:**
1. Add:
- `MAC_TOOLS_ENABLED=false`
- `AMBROGIO_MAC_TOOLS_SOCKET_PATH=/tmp/ambrogio-mac-tools.sock`
2. Add quick usage examples for `ambrogioctl mac ...`.
3. Document TCC permission troubleshooting with explicit steps.

**Verification:**
- manual smoke run on host

## Suggested Delivery Sequence

1. Tasks 1-2 (contracts + skeleton)
2. Tasks 3-4 (providers)
3. Task 5 (routing)
4. Task 6 (CLI)
5. Task 7 (lifecycle)
6. Tasks 8-9 (tests + docs)

## Rollout and Safety

1. Ship behind `MAC_TOOLS_ENABLED=false`.
2. Enable in dev and validate:
- TCC denial path
- successful calendar/reminders reads
- reminders tags presence for GTD flows
3. Observe logs and latency.
4. Enable by default only after stability window.

## Final Verification Checklist

- `bun run typecheck` passes
- `bun test` passes
- `ambrogioctl mac ping` works when enabled
- `ambrogioctl mac info` reports permission state
- `ambrogioctl mac reminders open --json` includes `tags`
- Realtime tool updates still work in Codex/Claude flows
