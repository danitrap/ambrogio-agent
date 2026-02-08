---
name: heartbeat-responder
description: Handle periodic heartbeat checks by reading HEARTBEAT.md policy and runtime status, then deciding whether to report OK or raise an alert.
---

# Heartbeat Responder

Respond to periodic heartbeat check requests from the Ambrogio runtime.

## Workflow

1. Read `/data/HEARTBEAT.md` for the active heartbeat policy.
2. Run `ambrogioctl status --json` (see CLI path resolution below) to obtain current runtime status.
3. Evaluate the policy against the runtime status.
4. Reply with the appropriate response (see Response Protocol).

## CLI Path Resolution

Use one of these commands (in order):

1. `bun run /app/src/cli/ambrogioctl.ts status --json` (Docker runtime)
2. `bun run /data/../src/cli/ambrogioctl.ts status --json` (local dev from `/data`)

## Response Protocol

- If there is nothing actionable, reply with exactly `HEARTBEAT_OK`.
- If action is needed, reply with compact JSON only:

```json
{"action":"checkin|alert","issue":"...","impact":"...","nextStep":"...","todoItems":["optional item 1","optional item 2"]}
```

## Hard Rules

- Use action values as defined by the HEARTBEAT.md policy.
- Do not resurrect stale tasks unless HEARTBEAT.md explicitly asks for it.
- Do not output anything other than `HEARTBEAT_OK` or the compact JSON object.
- Do not wrap the response in code fences or additional text.
