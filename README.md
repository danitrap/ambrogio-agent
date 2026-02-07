# Personal VPS Agent (Telegram + Skills)

Personal-only agent wrapper for Telegram with a secure `/data` boundary and Agent Skills-style skill loading.

## Features (v1)

- Telegram long polling input
- Single-user allowlist (`TELEGRAM_ALLOWED_USER_ID`)
- File tools scoped to `/data` only:
  - `list_files`
  - `read_file`
  - `write_file`
  - `search`
- Git snapshot created before every write
- Agent Skills-compatible discovery from `/data/skills/*/SKILL.md`
- Docker hardening baseline (`read_only`, `cap_drop=ALL`, `no-new-privileges`)

## Local run

1. Install deps:
```bash
bun install
```

2. Create env:
```bash
cp .env.example .env
```

3. Fill `.env` values:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `ACP_COMMAND` (default: `codex-acp`)
- `ACP_ARGS` (optional)

4. Start:
```bash
bun run dev
```

## Docker run

```bash
cp .env.example .env
mkdir -p data

docker compose up -d --build
```

All writable state is under `./data` on the host, mounted to `/data` in the container.

## Model bridge contract (current)

The service runs the ACP command as a child process per request and writes one JSON line to stdin:

```json
{
  "type": "respond",
  "request": {
    "message": "user text",
    "skills": [{"id":"...","name":"...","description":"...","instructions":"..."}],
    "tools": ["list_files","read_file","write_file","search"]
  }
}
```

Expected stdout (JSON):

```json
{
  "text": "assistant response",
  "toolCalls": [
    {"tool": "read_file", "args": {"path": "grocery.md"}},
    {"tool": "write_file", "args": {"path": "grocery.md", "content": "..."}}
  ]
}
```

If stdout is not JSON, it is treated as plain text and no tools are called.

## Tests

```bash
bun test
bun run typecheck
```
