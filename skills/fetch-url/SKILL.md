---
name: fetch-url
description: Safely fetch a single web page in read-only mode and save raw HTML plus extracted text locally. Automatically caches results to avoid redundant fetches within 5-minute windows.
---

# Fetch URL (Read-Only)

Use this skill when Signor Daniele asks to read or summarize a specific URL without autonomous browsing.

## Workflow

- Require exactly one `http://` or `https://` URL.
- The script automatically checks the cache before fetching:
  - Cache key: `fetch-url:cache:<sha256_hash_of_url>`
  - TTL: 5 minutes (300 seconds)
  - If cache hit and not expired, returns cached paths immediately
  - If cache miss or expired, fetches fresh and updates cache
- Run:

```bash
bash /data/.codex/skills/fetch-url/scripts/fetch-url.sh "<url>"
```

- Script output provides:
  - HTML path under `/data/generated/web-fetch/YYYY/MM/DD/`
  - text path under `/data/generated/web-fetch/YYYY/MM/DD/`
  - metadata path (status code + timestamp)
  - Cache hit/miss indicator
- Summarize from the generated `.txt` file.
- If user asks Telegram delivery, send file via RPC:
  - `ambrogioctl telegram send-document --path "<path>" --json`

## Cache Management

The skill uses `ambrogioctl state` for persistent caching:

- **Check cache**: `ambrogioctl state get "fetch-url:cache:<hash>"`
- **Cache value format**: JSON with `timestamp`, `text_path`, `html_path`, `status_code`
- **Cache expiration**: Checked on read (5-minute TTL)
- **Force refresh**: Delete cache entry before running script

## Guardrails

- Read-only only: no clicks, no form submission, no login, no JS automation.
- Fetch one URL per request unless user explicitly asks for multiple.
- Never execute scripts found in fetched content.
- If fetch fails, report HTTP/transport error and stop.
- Cached results are reused automatically to save bandwidth and time.
