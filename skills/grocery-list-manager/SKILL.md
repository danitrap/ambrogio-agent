---
name: grocery-list-manager
description: Manage and update the user's grocery list stored in the local file groceries.me (or groceries.md if that is the actual file). Use when the user asks to add, remove, update, or review items in their grocery list or pantry, or when they reference the groceries file.
---

# Grocery List Manager

## Workflow

- Locate the grocery list file in `/data`: prefer `groceries.md`;
- Preserve the existing format if the file already has structure.
- If no file exists, create `groceries.md` with a simple Markdown structure:
  - Title line: `# Groceries`
  - Section: `## To Buy`
  - Section: `## In Pantry`
  - Optional: `## Notes`
- Apply the user's requested changes (add, remove, rename, mark purchased).
- Keep items as Markdown bullet lines (`- item`).

## Editing Rules

- When marking an item as purchased, move it from `## To Buy` to `## In Pantry` unless the user asks for a different behavior.
- When removing, delete only the matching item line.
- When adding, keep items alphabetized within their section if the file is already alphabetized; otherwise append to the end of the section.
- Preserve comments, blank lines, and any extra sections that exist.

## Quick Checks

- If the user is ambiguous about which section to edit, ask a brief clarifying question.
- If the file uses a different format, follow that format and avoid reformatting the whole file.
