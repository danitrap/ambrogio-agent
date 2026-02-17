---
name: todo-manager
description: Manage `/data/TODO.md` checklist tasks (add, complete, reopen, remove, list) with optional task metadata tracking.
---

# TODO Manager

## Use This Skill When
- The user asks to manage TODO items (add/check/reopen/remove/list).

## File Contract
- Target file: `/data/TODO.md`
- Open: `- [ ] Task`
- Completed: `- [x] Task`
- Preserve non-task lines and existing sections.

## If Missing
Create:
```md
# TODO

- [ ] First task
```

## Operations
- Add: append open task, avoid exact duplicates.
- Complete: convert matching open tasks to done.
- Reopen: convert matching done tasks to open.
- Remove: delete matching checklist lines only.
- List: show open first, then completed summary.

## Optional Metadata
- Key: `todo:meta:<sha256(task_text)>`
- Store timestamps (`created_at`, `completed_at`, `reopened_at`) for age/analytics.

## Output Contract
- Report what changed and match count.
- For list/show, include open and completed counts.

## Guardrails
- Never rewrite unrelated content.
- Never silently drop tasks when multiple matches exist; report count.
