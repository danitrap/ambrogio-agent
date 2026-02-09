---
name: screenshot-only
description: Capture deterministic webpage screenshots without autonomous navigation.
---

# Screenshot Only (Non-Agentic)

Use this skill when Signor Daniele asks for a screenshot of a URL.

## Workflow

- Require exactly one `http://` or `https://` URL.
- Run:

```bash
bash /data/.codex/skills/screenshot-only/scripts/screenshot-url.sh "<url>"
```

- The script stores output under `/data/generated/screenshots/YYYY/MM/DD/`.
- Return saved path and file size.
- If user asked delivery on Telegram, send the PNG via RPC:
  - `ambrogioctl telegram send-photo --path "<png-path>" --json`

## Guardrails

- No click, no fill, no submit, no login flow.
- One page load and one screenshot only.
- If `agent-browser` is missing, stop and report install hint.
- Never chain autonomous navigation steps.
