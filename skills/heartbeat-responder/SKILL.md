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
- `ambrogioctl mac calendar upcoming --days 1 --json` (next 24h events)
- `ambrogioctl mac reminders open --include-no-due-date false --json` (reminders with due date)
- optional runtime/job/conversation info as needed

## Workflow
1. Read `/data/HEARTBEAT.md` first.
2. Collect runtime health + activity context:
   - `ambrogioctl status --json`
   - `ambrogioctl mac calendar upcoming --days 1 --json`
   - `ambrogioctl mac reminders open --include-no-due-date false --json`
3. Evaluate:
   - Runtime/job health (critical/warning)
   - TODO.md backlog state
   - Calendar events in the next 2h → warning; next 30min → critical
   - Reminders due today or overdue → warning; due in 30min → critical
   - Use numeric relative fields from JSON:
     - calendar: `startInMinutes`, `isOngoing`, `isEnded`
     - reminders: `dueInMinutes`, `isOverdue`
   - Do not classify urgency by parsing `startAt` or `dueAt` strings.
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
