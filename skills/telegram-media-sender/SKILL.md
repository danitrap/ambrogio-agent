---
name: telegram-media-sender
description: Send local files to Telegram through Ambrogio job RPC using ambrogioctl media commands.
---

# Telegram Media Sender

Use this skill when Signor Daniele asks to send a local file/photo/audio on Telegram.

## Hard Rules

- Do not use XML-like tags in assistant output.
- Do not invent file paths.
- Accept only absolute paths under `/data`.
- Choose exactly one explicit operation:
  - photo -> `send-photo`
  - audio -> `send-audio`
  - generic file -> `send-document`
- Do not fallback automatically between media types.

## Workflow

1. Identify target file path and intended media type.
2. If missing/ambiguous, ask one concise clarification.
3. Call the matching `ambrogioctl telegram <action> --path "<absolute-path>" --json`.

Where `<action>` is one of:
- `send-photo`
- `send-audio`
- `send-document`
4. Parse JSON result and report concise confirmation.

## Error Handling

- `FORBIDDEN_PATH`: explain that path must stay under `/data`.
- `NOT_FOUND`: report file not found and ask for valid path.
- `PAYLOAD_TOO_LARGE`: report size limit issue.
- `INVALID_STATE`: report no authorized chat available yet.
