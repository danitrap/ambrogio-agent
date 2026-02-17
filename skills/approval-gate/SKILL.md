---
name: approval-gate
description: Enforce explicit user confirmation before running sensitive, irreversible, or state-changing shell commands.
---

# Approval Gate

## Use This Skill When
- A command is risky, destructive, expensive, or changes persistent state.
- You need an explicit approval checkpoint.

## Do Not Use This Skill When
- The action is read-only and safe.

## Workflow
1. Queue proposed action:
```bash
bash /data/.codex/skills/approval-gate/scripts/queue-action.sh "<description>" "<command>"
```
2. Return the generated approval id and ask for explicit confirmation.
3. Only after explicit confirmation, execute:
```bash
bash /data/.codex/skills/approval-gate/scripts/run-action.sh "<approval-id>"
```
4. Report command exit status and meaningful output.

## Output Contract
- Before approval: include `approval-id`, command summary, and waiting state.
- After execution: include status (`success`/`failed`) and key output.

## Guardrails
- Never run queued commands without explicit confirmation.
- If command changes, queue a new approval id.
- Treat `rm -rf`, force resets, and credential changes as high risk.
- Keep queue files under `/data/runtime/approval-gate/`.
