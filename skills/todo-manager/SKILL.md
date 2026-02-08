---
name: todo-manager
description: Manage TODO tasks in /data/TODO.md with minimal CRUD operations (add, complete, remove, show) using simple markdown checkboxes.
---

# TODO Manager

Manage tasks in `/data/TODO.md` using a minimal checklist format.

## File contract

- Target file: `/data/TODO.md`
- Format: markdown checklist only
  - Open task: `- [ ] Task text`
  - Completed task: `- [x] Task text`
- Keep a single section unless the file already has additional sections.
- Preserve existing lines that are not task lines.

## If file is missing

Create `/data/TODO.md` with:

```md
# TODO

- [ ] First task
```

## Supported operations

- Add task:
  - Append as `- [ ] ...`.
  - Avoid exact duplicates (case-insensitive trimmed match).
- Complete task:
  - Convert matching `- [ ]` to `- [x]`.
  - If multiple matches, update all obvious matches and report count.
- Reopen task:
  - Convert matching `- [x]` to `- [ ]` when user asks to reopen/riaprire.
- Remove task:
  - Remove matching checklist lines only.
- Show/list tasks:
  - Summarize open and completed counts.
  - Show open tasks first.

## Matching rules

- Prefer exact text match (normalized whitespace, case-insensitive).
- If user references an index (e.g. "task 2"), map to visible open-task order unless user says otherwise.
- If ambiguous, ask one concise clarifying question.

## Response style

- Be concise and operational.
- After modifications, report:
  - action performed,
  - affected task(s),
  - updated open/completed totals.
