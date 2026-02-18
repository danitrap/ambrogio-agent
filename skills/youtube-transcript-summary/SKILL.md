---
name: youtube-transcript-summary
description: Use when the user explicitly asks to summarize a YouTube video and provides a YouTube URL; extract transcript with yt-dlp, then summarize it.
---

# YouTube Transcript Summary

## Use This Skill When
- The user explicitly asks to summarize/synthesize a YouTube video.
- The request includes at least one YouTube URL (`youtube.com` or `youtu.be`).

## Do Not Use This Skill When
- The user shares a YouTube URL without asking for a summary.
- The user asks for tasks unrelated to transcript extraction or summary.

## Required Inputs
- Exactly one YouTube URL per run.

## Workflow
1. Extract transcript with:
```bash
bash /data/.codex/skills/youtube-transcript-summary/scripts/get-youtube-transcript.sh "<youtube-url>"
```
2. Parse script output fields:
- `STATUS`
- `TRANSCRIPT_PATH`
- `LANGUAGE`
- `SOURCE`
- `ERROR` (only on failure)
3. Read transcript from `TRANSCRIPT_PATH`.
4. Produce a concise summary in the user language.

## Output Contract
- Confirm extracted language/source (`manual` or `auto`).
- Provide the requested summary.
- On failure, report exact reason from `ERROR` and stop.

## Guardrails
- Never attempt account login, cookies export, or bypass techniques.
- Never claim transcript extraction succeeded if `STATUS` is not `ok`.
- If transcript is unavailable, ask user for manual transcript text as fallback.
