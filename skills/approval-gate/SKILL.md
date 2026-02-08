---
name: approval-gate
description: Enforce explicit user confirmation before running sensitive or state-changing commands.
---

# Approval Gate

Use this skill before actions that are risky, state-changing, or irreversible.

## Workflow

1. Queue the action first:

```bash
bash /data/.codex/skills/approval-gate/scripts/queue-action.sh "<description>" "<command>"
```

2. Reply with the generated approval id and ask for explicit confirmation.
3. Only after user confirms, run:

```bash
bash /data/.codex/skills/approval-gate/scripts/run-action.sh "<approval-id>"
```

4. Report command output and status.

## Guardrails

- Never run queued commands without explicit user confirmation.
- If user asks to modify queued command, create a new approval id.
- Do not queue destructive commands (`rm -rf`, `git reset --hard`) unless user explicitly asks and confirms.
- Keep all queue files under `/data/runtime/approval-gate/`.
