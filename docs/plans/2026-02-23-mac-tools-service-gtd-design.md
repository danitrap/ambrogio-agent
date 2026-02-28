# macOS Native Tools Service (GTD) Design

**Date:** 2026-02-23
**Status:** Proposed
**Type:** Feature Enhancement

## Overview

This design introduces a dedicated native macOS service (`mac-tools-service`) that exposes read-only Calendar and Reminders capabilities to the agent via local JSON-RPC over Unix socket.

The goal is to preserve bridge isolation (Codex/Claude can keep running in containers) while enabling controlled access to Apple frameworks for personal productivity workflows, especially GTD-oriented Reminders usage.

## Goals

1. Add native macOS access to Calendar and Reminders through a dedicated host service
2. Keep model bridge runtimes isolated from direct Apple framework access
3. Expose a minimal read-only MVP with high utility:
- upcoming calendar events (next 7 days)
- open reminders (including GTD tags)
4. Use existing operational patterns: Unix socket RPC + `ambrogioctl`
5. Return explicit, structured permission errors when TCC access is missing

## Non-Goals (MVP)

- Create/update/delete events
- Create/update/delete reminders
- Multi-user or remote network access
- Full EventKit object passthrough
- Replacing existing realtime tool update flow

## Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         macOS Host                          │
│                                                             │
│  ┌──────────────────────┐    JSON-RPC (Unix socket)        │
│  │  Ambrogio Agent      │ <──────────────────────────────┐  │
│  │  (native process)    │                                │  │
│  └──────────┬───────────┘                                │  │
│             │                                            │  │
│             │ spawns bridge runtime (native or container)│  │
│             ▼                                            │  │
│  ┌──────────────────────┐                                │  │
│  │ Codex / Claude bridge│ -- ambrogioctl mac ... ------ │  │
│  └──────────────────────┘                                │  │
│                                                          ▼  │
│                                           ┌────────────────┐│
│                                           │ mac-tools-     ││
│                                           │ service        ││
│                                           │ (native only)  ││
│                                           ├────────────────┤│
│                                           │ EventKit       ││
│                                           │ Calendar       ││
│                                           │ Reminders      ││
│                                           └────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

**mac-tools-service (new)**
- Native host process (no container)
- Binds Unix socket (default `/tmp/ambrogio-mac-tools.sock`)
- Validates and handles allowlisted JSON-RPC methods
- Calls EventKit/Apple APIs and maps results to stable DTOs
- Returns structured errors (`permission_denied`, `invalid_params`, `timeout`, `internal_error`)

**ambrogioctl (extended)**
- Adds `mac` command scope for invoking the service
- Performs JSON-RPC request/response over socket
- Supports machine-readable JSON output and human-readable output

**Ambrogio Agent (existing)**
- Starts/stops service lifecycle (or checks it if already running)
- Keeps bridge flow unchanged (realtime updates remain in bridge logic)
- Uses service only through `ambrogioctl` invocations

## API Contract (JSON-RPC)

Transport:
- Unix domain socket
- Request/response JSON-RPC 2.0 style envelope

### Request Envelope

```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "method": "calendar.upcoming",
  "params": {
    "days": 7,
    "limit": 100,
    "timezone": "Europe/Rome"
  }
}
```

### Success Envelope

```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "result": {
    "...": "method-specific payload"
  }
}
```

### Error Envelope

```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "error": {
    "code": "permission_denied",
    "message": "Reminders access not granted",
    "data": {
      "service": "reminders",
      "instructions": [
        "Open System Settings > Privacy & Security > Reminders",
        "Enable access for Ambrogio/mac-tools-service",
        "Retry the command"
      ]
    }
  }
}
```

## MVP Methods

### `system.ping`

**Purpose:** health check

**Params:** none

**Result:**
```json
{ "ok": true, "service": "mac-tools-service", "version": "1.0.0" }
```

### `system.info`

**Purpose:** runtime and permission visibility

**Params:** none

**Result:**
```json
{
  "service": "mac-tools-service",
  "version": "1.0.0",
  "uptimeMs": 12345,
  "socketPath": "/tmp/ambrogio-mac-tools.sock",
  "permissions": {
    "calendar": "authorized|denied|not_determined|restricted",
    "reminders": "authorized|denied|not_determined|restricted"
  }
}
```

### `calendar.upcoming`

**Purpose:** upcoming events window (default 7 days)

**Params:**
- `days?: number` (default `7`, max `30`)
- `limit?: number` (default `100`, max `500`)
- `timezone?: string` (default host local timezone)

**Result:**
```json
{
  "window": {
    "from": "2026-02-23T09:00:00.000Z",
    "to": "2026-03-02T09:00:00.000Z",
    "timezone": "Europe/Rome"
  },
  "events": [
    {
      "id": "evt_123",
      "calendarName": "Personal",
      "title": "Weekly Review",
      "startAt": "2026-02-24T17:00:00.000Z",
      "endAt": "2026-02-24T18:00:00.000Z",
      "allDay": false,
      "location": "Office",
      "notesPreview": "GTD weekly review checklist..."
    }
  ],
  "count": 1
}
```

### `reminders.open`

**Purpose:** list open reminders for GTD workflows

**Params:**
- `limit?: number` (default `200`, max `1000`)
- `includeNoDueDate?: boolean` (default `true`)

**Result:**
```json
{
  "generatedAt": "2026-02-23T10:00:00.000Z",
  "items": [
    {
      "id": "rem_123",
      "listName": "Inbox",
      "title": "Chiamare commercialista",
      "dueAt": "2026-02-25T08:00:00.000Z",
      "priority": 5,
      "isFlagged": true,
      "tags": ["@calls", "next"],
      "notesPreview": "Portare numeri Q1"
    }
  ],
  "count": 1
}
```

## Error Model

Shared error codes:
- `permission_denied`: TCC permission missing/denied
- `invalid_params`: validation failure on method params
- `timeout`: operation exceeded timeout budget
- `internal_error`: unexpected processing error
- `method_not_found`: method not allowlisted

### TCC Error Behavior

If macOS permission is not granted:
- return `permission_denied`
- include `data.service` (`calendar` or `reminders`)
- include actionable `data.instructions`
- do not silently return empty results

## Security Model

1. Dedicated Unix socket with strict filesystem permissions (`0600`)
2. Local-only communication (no TCP listener)
3. Deny-by-default RPC router (explicit allowlist)
4. Strict param validation and bounded limits
5. Per-request timeout and cancellation
6. Redacted logging (no full notes payloads)

## Lifecycle and Operations

- Default socket path: `/tmp/ambrogio-mac-tools.sock`
- Config override: `AMBROGIO_MAC_TOOLS_SOCKET_PATH`
- Service enable flag: `MAC_TOOLS_ENABLED` (default `false`)
- Agent startup path:
1. If enabled, start service process
2. Run `system.ping` health check
3. Log permission state via `system.info`
- Agent shutdown path:
1. Graceful service stop
2. Socket cleanup
- Crash handling:
- restart with capped exponential backoff
- emit structured logs for each crash/restart

## CLI Integration

Extend `ambrogioctl` with:

- `ambrogioctl mac ping [--json]`
- `ambrogioctl mac info [--json]`
- `ambrogioctl mac calendar upcoming [--days 7 --limit 100 --timezone Europe/Rome --json]`
- `ambrogioctl mac reminders open [--limit 200 --include-no-due-date true --json]`

Output modes:
- `--json`: raw RPC result
- default text mode: concise formatted list suitable for terminal and bridge consumption

## Realtime Compatibility with Codex/Claude

This design does not replace bridge streaming logic.

- Realtime tool-call updates currently come from bridge stderr/stdout parsing and `onToolCallEvent` callbacks.
- The mac tools service is invoked through normal bridge tool usage (`ambrogioctl`), so existing realtime updates remain compatible.
- No change is required to `ModelToolCallEvent` contract for MVP.

## Data Mapping Notes (GTD)

For reminders, include both organizational dimensions:
- `listName` (project/list context)
- `tags` (e.g., `@next`, `@waiting`, `@errands`)

Recommended stable sorting in service responses:
1. due date ascending (nulls last if included)
2. flagged first within same due date
3. title lexical fallback

## Testing Strategy

### Unit

- Param validation (`days`, `limit`, booleans)
- DTO mapping for calendar events and reminders (`tags`, `isFlagged`)
- Error mapping (`permission_denied`, `invalid_params`, `timeout`)

### Integration

- Socket server request/response contract tests
- `ambrogioctl mac ...` end-to-end to service mock
- Healthcheck and lifecycle tests (start/stop/socket cleanup)

### Manual/E2E (host)

1. Start agent with `MAC_TOOLS_ENABLED=true`
2. Run `ambrogioctl mac ping`
3. Run `ambrogioctl mac info`
4. Validate TCC denial path (if not authorized)
5. Authorize in macOS settings
6. Re-run `calendar upcoming` and `reminders open`
7. Validate reminders include `tags`

## Rollout Plan

1. Implement service + RPC methods behind feature flag
2. Add CLI commands and integration tests
3. Enable in dev only and validate TCC behavior
4. Observe logs/latency/error rates
5. Enable by default after stability validation

## Open Questions

- Should tags be normalized (lowercase/trim) at service layer or preserved raw?
- Should `notesPreview` be disabled by default for privacy-sensitive setups?
- Is launchd-managed service preferred over in-process lifecycle management for production?

## References

- Existing RPC control plane: `src/runtime/job-rpc-server.ts`
- Existing CLI transport patterns: `src/cli/ambrogioctl.ts`
- Existing bridge event flow: `src/model/codex-bridge.ts`, `src/model/claude-bridge.ts`
