---
name: structured-notes
description: Create, update, search, and summarize structured notes with metadata using `ambrogioctl state`.
---

# Structured Notes

## Use This Skill When
- The user asks to create/search/update project notes, decision logs, or quick logs.

## Data Model
- Key: `notes:entry:<note_id>`
- JSON value fields:
- `id`, `type`, `title`, `body`, `tags`, `project`, `created_at`, `updated_at`, `status`, `links`

## Workflow
1. Create note id and timestamps.
2. Write JSON into `ambrogioctl state set`.
3. For updates, read existing entry, mutate requested fields, refresh `updated_at`.
4. For search, list keys and filter by keyword/tag/project/time.

## Note Types
- `project`
- `decision` (must include context, decision, alternatives, impacts)
- `log` (short operational event)

## Output Contract
- Return note id and concise change summary.
- For searches, return matching ids/titles and why they matched.

## Guardrails
- Keep schemas consistent across entries.
- Do not drop existing metadata unless requested.
- Use ISO-8601 timestamps.
