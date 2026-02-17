---
name: grocery-list-manager
description: Manage grocery checklist state in `/data/groceries.md` (add, remove, move purchased items, review list).
---

# Grocery List Manager

## Use This Skill When
- The user asks to add/remove/update items in groceries/pantry lists.

## File Contract
- Target file: `/data/groceries.md`.
- If missing, create:
```md
# Groceries

## To Buy

## In Pantry

## Notes
```

## Workflow
1. Read current file.
2. Apply requested mutation:
- add item
- remove item
- rename item
- mark purchased (move `To Buy` -> `In Pantry` unless user says otherwise)
3. Preserve existing sections/comments/format.
4. Save file and report changed entries.

## Optional Metadata Tracking
- On purchase, update `ambrogioctl state` key:
- `grocery:frequency:<normalized_item_name>`
- Store count and timestamps for future suggestions.

## Output Contract
- List exactly what changed.
- Show resulting item location (`To Buy` or `In Pantry`).

## Guardrails
- Do not delete unrelated sections.
- Do not rewrite whole file if a minimal edit is enough.
- Avoid duplicate lines (case-insensitive match).
