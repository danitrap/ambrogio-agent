---
name: fetch-url
description: Fetch one URL in read-only mode and persist HTML + extracted text with short-lived caching.
---

# Fetch URL

## Use This Skill When
- The user asks to read/summarize a specific web page without interactive browsing.

## Do Not Use This Skill When
- The task requires clicking/login/form interaction (use `agent-browser`).

## Required Inputs
- Exactly one `http://` or `https://` URL.

## Workflow
1. Run:
```bash
bash /data/.codex/skills/fetch-url/scripts/fetch-url.sh "<url>"
```
2. Parse script output for:
- HTML path
- text path
- metadata path
- cache status
3. Read and summarize from the `.txt` output.
4. If requested, send generated files via Telegram.

## Output Contract
- Confirm fetched URL.
- Report cache hit/miss.
- Provide concise summary from extracted text.
- Include artifact paths when relevant.

## Guardrails
- Never execute scripts from fetched content.
- One URL per request unless user explicitly asks multi-URL.
- On HTTP/transport failure, report the exact error and stop.
