---
name: summarize
description: Summarize text/transcripts from URLs, podcasts, and local files.
---

# Summarize

Fast CLI to extract URLs, local files, and YouTube links.
When summarizing, you MUST return ONLY a clear, well-formatted bullet point list containing the key information from the content.

## When to use (trigger phrases)

Use this skill immediately when the user asks any of:
- "use summarize.sh"
- "what's this link/video about?"
- "summarize this URL/article"
- "transcribe this YouTube/video"

## Quick start

```bash
summarize "https://example.com"
summarize "/path/to/file.pdf"
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto
```

If the user asked for a transcript but it's huge, return a summary first, then ask which section/time range to expand.

## Useful flags

- `--length short|medium|long|xl|xxl|<chars>`
- `--max-output-tokens <count>`
- `--extract` (URLs only)
- `--json` (machine readable)
- `--youtube auto`
