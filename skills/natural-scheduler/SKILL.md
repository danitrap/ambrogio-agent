---
name: natural-scheduler
description: Parse natural-language runtime-task or TODO requests into strict JSON for scheduler/task routing.
---

# Natural Scheduler

Convert user natural-language task/TODO requests into a strict JSON object for runtime routing.

## Output Contract

Return JSON only with this shape:

```json
{"domain":"runtime_task|todo|none","action":"schedule|cancel|list|inspect|retry|none","intent":"schedule|cancel|none","confidence":0.0,"runAtIso":"","taskPrompt":"","taskId":"","needsConfirmation":false,"confirmationQuestion":""}
```

## Rules

- Use the provided local timezone and current timestamp from the runtime prompt.
- `domain=runtime_task` for delayed/background task actions.
- `domain=todo` for TODO/checklist actions.
- `action=list|inspect|retry` are runtime task management actions.
- `intent=schedule` only when timing and requested action are explicit enough.
- For `schedule`:
  - set `runAtIso` to an absolute ISO datetime.
  - set `taskPrompt` to the exact task the agent should execute later.
- For cancellation:
  - use `intent=cancel`.
  - set `taskId` if explicitly provided by the user.
- If domain/action are ambiguous (especially runtime task vs TODO), set `needsConfirmation=true` and provide a concise `confirmationQuestion`.
- If uncertain, return `intent=none` and lower `confidence`.
- Never output markdown or prose.
