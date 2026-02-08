# Personal VPS Agent (Telegram + Skills)

Personal-only agent wrapper for Telegram with a secure `/data` boundary and Agent Skills-style skill loading.

## Features (v1)

- Telegram long polling input
- Telegram vocal message support with transcription (`gpt-4o-mini-transcribe`)
- Optional audio replies via ElevenLabs TTS when `ELEVENLABS_API_KEY` is set
- Single-user allowlist (`TELEGRAM_ALLOWED_USER_ID`)
- File tools scoped to `/data` only:
  - `list_files`
  - `read_file`
  - `write_file`
  - `search`
- Git snapshot created before every write
- Agent Skills-compatible discovery from `/data/skills/*/SKILL.md`
- Docker hardening baseline (`read_only`, `cap_drop=ALL`, `no-new-privileges`)
- Backend-tools-only mode via `codex exec` (no local fallback execution).

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
- `OPENAI_API_KEY`
- `ACP_COMMAND` (default: `codex-acp`)
- `ACP_ARGS` (default: `--dangerously-bypass-approvals-and-sandbox -c instructions=acp_fs` inside this containerized setup)

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

The Docker image builds and installs `codex-acp` from source during `docker compose build`.
The `codex` CLI is installed via npm (`@openai/codex`), so ChatGPT login is available without building Codex from source.
BuildKit cache is enabled in compose and persisted in `.docker-cache`, so later rebuilds are significantly faster.

## ChatGPT login (device auth)

When running in Docker, use device auth to avoid localhost callback issues:

```bash
docker exec -it ambrogio-agent sh -lc 'HOME=/data CODEX_HOME=/data/.codex codex login --device-auth'
docker compose restart agent
```

Auth data is persisted in the mounted `./data/.codex` directory.

All writable state is under `./data` on the host, mounted to `/data` in the container.

## Model bridge contract (current)

The service runs `codex exec` per request and passes the prompt via stdin.

- `--output-last-message` is used to capture the final assistant message.
- The bridge strips `<final>...</final>` tags before sending to Telegram.
- Tool execution is handled inside Codex runtime (`shell`/`apply_patch`), not by host-side tool calls.

## Tests

```bash
bun test
bun run typecheck
```

## Install ElevenLabs Text-to-Speech Skill

Install from host into the mounted skills directory:

```bash
python3 /Users/daniele/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo elevenlabs/skills \
  --path text-to-speech \
  --dest /Users/daniele/Code/agent/data/.codex/skills
```
