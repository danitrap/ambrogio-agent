---
name: heartbeat
description: Periodic autonomous runtime check that decides whether to stay silent, send a check-in, or send an alert.
---

# Heartbeat Responder

## Use This Skill When
- Invoked by heartbeat timer or forced heartbeat execution.

## Goal
- Evaluate runtime + conversation context and decide one action:
- no message
- check-in message
- alert message

## Required Context Sources
- `/data/HEARTBEAT.md` (policy first)
- `ambrogioctl status --json`
- `/data/TODO.md` (if present)
- optional runtime/job/conversation info as needed

## Workflow
1. Read `/data/HEARTBEAT.md` first.
2. Collect runtime health + activity context.
3. Evaluate policy thresholds and unresolved items.
4. Execute exactly one outcome:
- no-op (silent)
- send check-in
- send alert
5. If sending message:
```bash
ambrogioctl telegram send-message --text "<message>"
```

## Hourly Cadence Rules
- Cadence is hourly: optimize for signal over volume.
- `critical` issues: alert immediately and keep alerting on each hourly run while unresolved.
- `warning` issues: alert only if condition persists across consecutive runs (as defined in `/data/HEARTBEAT.md`).
- If multiple warnings exist in one run, send a single digest message.
- Check-in messages must be less frequent than alerts and only when policy idle thresholds are met.

## Output Contract
- Internally: include decision reason with evidence.
- User-facing delivery: concise, actionable message only.

## Guardrails
- Respect quiet-hours handling already enforced by runtime unless heartbeat is forced.
- Follow `/data/HEARTBEAT.md` thresholds strictly (severity, persistence, digesting).
- Never invent state; base decisions on current runtime data.
