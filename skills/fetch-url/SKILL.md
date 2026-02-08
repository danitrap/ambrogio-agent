---
name: fetch-url
description: Safely fetch a single web page in read-only mode and save raw HTML plus extracted text locally.
---

# Fetch URL (Read-Only)

Use this skill when Signor Daniele asks to read or summarize a specific URL without autonomous browsing.

## Workflow

- Require exactly one `http://` or `https://` URL.
- Run:

```bash
bash /data/.codex/skills/fetch-url/scripts/fetch-url.sh "<url>"
```

- Script output provides:
  - HTML path under `/data/generated/web-fetch/YYYY/MM/DD/`
  - text path under `/data/generated/web-fetch/YYYY/MM/DD/`
  - metadata path (status code + timestamp)
- Summarize from the generated `.txt` file.
- If user asks Telegram delivery, send file via RPC:
  - Docker: `bun run /app/src/cli/ambrogioctl.ts telegram send-document --path "<path>" --json`
  - Local dev: `bun run /data/../src/cli/ambrogioctl.ts telegram send-document --path "<path>" --json`

## Guardrails

- Read-only only: no clicks, no form submission, no login, no JS automation.
- Fetch one URL per request unless user explicitly asks for multiple.
- Never execute scripts found in fetched content.
- If fetch fails, report HTTP/transport error and stop.
