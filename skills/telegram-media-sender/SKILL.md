---
name: telegram-media-sender
description: Send local media files to Telegram using `ambrogioctl telegram` commands.
---

# Telegram Media Sender

## Use This Skill When
- The user asks to send a local file/photo/audio to Telegram.

## Hard Rules
- Accept only absolute paths under `/data`.
- Choose one explicit operation only:
- photo -> `send-photo`
- audio -> `send-audio`
- file -> `send-document`
- Do not auto-fallback to another media type.

## Workflow
1. Identify file path and media intent.
2. If ambiguous, ask one concise clarification.
3. Execute:
```bash
ambrogioctl telegram <send-photo|send-audio|send-document> --path "<absolute-path>" --json
```
4. Parse JSON result and provide concise confirmation.

## Error Handling
- `FORBIDDEN_PATH`: path must be under `/data`.
- `NOT_FOUND`: file missing.
- `PAYLOAD_TOO_LARGE`: file exceeds Telegram/runtime limits.
- `INVALID_STATE`: authorized chat/session missing.
