# Heartbeat MVP Design

## Goal
Add a minimal heartbeat mechanism aligned with OpenClaw heartbeat semantics, with no runtime configuration surface.

## Decisions
- Heartbeat runs on a dedicated loop in `src/main.ts`.
- Fixed interval: 30 minutes (`1800000ms`).
- `HEARTBEAT.md` is optional and loaded from `/data/HEARTBEAT.md`.
- Heartbeat is silent when model reply is exactly `HEARTBEAT_OK`.
- Any non-`HEARTBEAT_OK` reply, empty reply, or execution failure triggers a Telegram alert.
- Alerts are sent only to the most recent authorized chat observed at runtime.
- If no authorized chat is known yet, alert is logged and dropped.

## Scope
Included:
- heartbeat loop scheduling
- prompt construction with optional `HEARTBEAT.md`
- alert routing and logging
- unit tests for heartbeat behavior

Excluded (YAGNI for MVP):
- custom intervals
- env flags
- parser/validation for `HEARTBEAT.md`
- persistence for target chat across restarts
- dedicated Telegram commands for heartbeat

## Data Flow
1. Timer fires every 30 minutes.
2. Runtime reads optional `/data/HEARTBEAT.md`.
3. Runtime builds heartbeat prompt and executes model request.
4. Runtime evaluates reply:
   - `HEARTBEAT_OK` => no Telegram message.
   - otherwise => send alert to last authorized chat (if available).

## Error Handling
- Missing `HEARTBEAT.md`: continue heartbeat with base prompt.
- Read failure: warn in logs and continue with base prompt.
- Model timeout/error: send failure alert when possible.
- Overlap protection: skip tick when previous heartbeat is still running.

## Testing
- Unit tests for:
  - prompt content with/without `HEARTBEAT.md`
  - silent path on `HEARTBEAT_OK`
  - alert path on non-OK
  - dropped alert without target chat
  - alert path on execution error
