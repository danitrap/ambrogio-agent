---
name: mac-calendar-reminders
description: Use macOS Calendar and Reminders through `ambrogioctl mac ...` to answer planning, agenda, and GTD-style task queries.
---

# macOS Calendar + Reminders

## Use This Skill When
- The user asks about agenda, upcoming events, open reminders, priorities, or GTD next actions.
- The user asks to cross-check calendar commitments with reminders.

## Data Sources (Only)
- Calendar:
```bash
ambrogioctl mac calendar upcoming --days <N> --limit <N> --json
```
- Reminders:
```bash
ambrogioctl mac reminders open --limit <N> --include-no-due-date true --json
```
- Service health/permissions:
```bash
ambrogioctl mac info --json
```

## Workflow
1. Start with `ambrogioctl mac info --json`.
2. If permissions are not `authorized`, stop and return actionable instructions.
3. Fetch only the minimum data window needed:
- default calendar window: `--days 7 --limit 100`
- default reminders: `--limit 200 --include-no-due-date true`
4. Summarize results with clear sections:
- Upcoming events (ordered by date/time)
- Open reminders (due first, then no due date)
- Suggested next actions (max 3)
 - Use these fields for urgency/prioritization logic:
   - calendar: `startInMinutes`, `endInMinutes`, `isOngoing`, `isEnded`
   - reminders: `dueInMinutes`, `isOverdue`
 - Use `startAt`/`endAt`/`dueAt` only as display timestamps (not for urgency classification).
5. If the user asks for raw output, return JSON exactly as provided by `--json`.

## Response Contract
- Keep responses concise and operational.
- Always include concrete date/time when referencing "today", "tomorrow", or deadlines.
- If no items exist, say explicitly:
- `No upcoming events in the selected window.`
- `No open reminders.`

## Error Handling
- If command returns timeout/internal errors, retry once with narrower scope:
- calendar: reduce days/limit
- reminders: reduce limit
- If still failing, report failure with command context and next step.
- If permission denied/not determined, instruct:
1. Open `System Settings > Privacy & Security > Calendars/Reminders`
2. Enable access for the host process running mac-tools
3. Retry command

## Guardrails
- Read-only mode: never attempt create/update/delete events or reminders.
- Do not invent events/reminders when command output is empty or failing.
- Prefer factual extraction over interpretation when uncertainty exists.
