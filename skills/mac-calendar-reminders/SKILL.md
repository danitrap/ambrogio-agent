---
name: mac-calendar-reminders
description: Use macOS Calendar and Reminders through `ambrogioctl mac ...` to answer planning, weekly review, and GTD task management requests.
---

# macOS Calendar + Reminders

## Use This Skill When
- The user asks about agenda, upcoming events, open reminders, completed reminders, priorities, or GTD next actions.
- The user asks to cross-check calendar commitments with reminders.
- The user asks to create or update Apple Reminders through chat.

## Data Sources and Commands
- Calendar:
```bash
ambrogioctl mac calendar upcoming --days <N> --limit <N> --json
```
- Reminder lists:
```bash
ambrogioctl mac reminders lists --json
```
- Open reminders:
```bash
ambrogioctl mac reminders open --limit <N> --include-no-due-date true --json
```
- Tag/list filtered reminders:
```bash
ambrogioctl mac reminders open --tag <#tag> --list "<List>" --json
```
- Completed reminders for weekly review:
```bash
ambrogioctl mac reminders open --state completed --days <N> --json
```
- Create reminder:
```bash
ambrogioctl mac reminders create --list "<List>" --title "<Title>" [--due <ISO>] [--status-tag <#tag>] [--area-tag <#tag>] [--tags "<#tag1,#tag2>"] [--notes "<text>"] --json
```
- Update reminder:
```bash
ambrogioctl mac reminders update --id <id> [--due <ISO>|none] [--status-tag <#tag>|none] [--area-tag <#tag>|none] [--tags "<#tag1,#tag2>"] --json
```
- Service health/permissions:
```bash
ambrogioctl mac info --json
```

## GTD Tag Model
- Status tags:
  - `#next`
  - `#waiting`
  - `#someday`
  - `#tickler`
- Area tags:
  - `#personal`
  - `#work`
  - `#home`
- The service accepts legacy `@tag` input but normalizes output to `#tag`.
- Reminder JSON always includes full notes in `notesFull`. There is no preview field.

## Workflow
1. Start with `ambrogioctl mac info --json`.
2. If permissions are not `authorized`, stop and return actionable instructions.
3. Fetch only the minimum scope needed:
- default calendar window: `--days 7 --limit 100`
- default reminders: `--limit 200 --include-no-due-date true`
- default weekly review: `--state completed --days 7`
4. For reminder triage:
- use `statusTag`, `areaTag`, `tags`, `dueInMinutes`, `isOverdue`, `completedAt`
- treat `dueAt` and `completedAt` as display timestamps, not urgency calculations
5. For write requests:
- discover valid lists first with `ambrogioctl mac reminders lists --json` unless the list name was already confirmed in the current context
- create with explicit `--status-tag` and `--area-tag` when classification is clear
- for updates requested via chat, first read the current reminder from JSON output (`ambrogioctl mac reminders open ... --json`) and identify its `id` before mutating anything
- when the user does not explicitly ask to change or clear the due date, preserve the existing `dueAt`; never infer a missing `dueAt` from text-mode output
- never build reminder updates from text-mode `ambrogioctl` output when JSON is available
- update with `--status-tag none` or `--area-tag none` to clear managed GTD slots
- use `--due none` to remove a due date
6. If the user asks for raw output, return JSON exactly as provided by `--json`.
7. Never pipe, truncate, or grep raw `--json` output. Narrow scope only through supported flags like `--limit`, `--days`, `--tag`, and `--list`.

## Response Contract
- Keep responses concise and operational.
- Always include concrete date/time when referencing "today", "tomorrow", or deadlines.
- For "what should I do now?" prefer `#next` reminders first, then urgent dated reminders.
- After any tool use, end with a user-facing final answer unless the user explicitly asked for raw JSON only.
- For weekly review, separate:
  - completed in the last window
  - still-open `#waiting`
  - upcoming `#tickler`
- If no items exist, say explicitly:
  - `No upcoming events in the selected window.`
  - `No open reminders.`
  - `No completed reminders in the selected window.`

## Error Handling
- If the command returns timeout/internal errors, retry once with narrower scope:
  - calendar: reduce days/limit
  - reminders: reduce limit or days
- If still failing, report failure with command context and next step.
- If permission denied/not determined, instruct:
1. Open `System Settings > Privacy & Security > Calendars/Reminders`
2. Enable access for the host process running mac-tools
3. Retry command

## Guardrails
- Do not invent events or reminders when command output is empty or failing.
- Prefer factual extraction over interpretation when uncertainty exists.
- When mutating reminders, change only what the user asked for.
