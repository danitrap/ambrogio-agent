# Personal VPS Agent (Telegram + Skills)

Personal-only agent wrapper for Telegram with a secure `/data` boundary and Agent Skills-style skill loading.

## Features (v1)

- Telegram long polling input
- Telegram vocal message support with transcription (`gpt-4o-mini-transcribe`)
- Optional audio replies via ElevenLabs TTS with `/audio <prompt>` when `ELEVENLABS_API_KEY` is set
- Single-user allowlist (`TELEGRAM_ALLOWED_USER_ID`)
- Agent Skills-compatible discovery from `/data/.codex/skills/*/SKILL.md`
- Bootstrap automatico delle skill versionate in `./skills` verso `/data/.codex/skills` (missing + drift sync)
- Docker hardening baseline (`read_only`, `cap_drop=ALL`, `no-new-privileges`)
- Backend-tools-only mode via `codex exec` (no local fallback execution).
- Minimal heartbeat loop every 30 minutes with `HEARTBEAT_OK` silent mode, explicit `checkin|alert` actions, and Telegram delivery with dedup.
- Soft-timeout for long requests (60s): user gets immediate "background task" feedback while Codex continues.
- Background task lifecycle persisted in SQLite with delivery retry.
- Delayed tasks in natural language (for example, "fra 5 minuti ..."), executed by an internal scheduler.
- Natural-language runtime task management (`list`, `inspect`, `retry`, `cancel`) with explicit confirmation on ambiguity.

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
- `CODEX_COMMAND` (default: `codex`)
- `CODEX_ARGS` (default: `--dangerously-bypass-approvals-and-sandbox -c instructions=codex_fs` inside this containerized setup)
- `HEARTBEAT_QUIET_HOURS` (default suggested: `22:00-06:00`, local timezone; suppresses only timer check-ins)

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

## Heartbeat MVP

The agent runs a dedicated heartbeat every 30 minutes (fixed interval, no configuration flags).

- Reads optional `/data/HEARTBEAT.md` instructions.
- Runs a lightweight model check with a runtime status block.
- Runtime status includes local timezone/date-time, heartbeat last state, idle duration, recent Telegram messages, conversation context (last 8 turns), TODO path, and TODO open-item snapshot (max 10).
- Runtime status includes task metrics: pending background deliveries and scheduled delayed tasks.
- If the model replies exactly `HEARTBEAT_OK`, nothing is sent (unless `HEARTBEAT.md` explicitly asks for an always-on notice message).
- If action is needed, expected output is JSON:
  - `{"action":"checkin|alert","issue":"...","impact":"...","nextStep":"...","todoItems":["..."]}`
- `checkin` and `alert` are different outbound messages.
- Quiet hours can suppress timer-triggered `checkin` messages (alerts are never suppressed) via `HEARTBEAT_QUIET_HOURS`.
- Repeated timer-triggered heartbeat messages are deduplicated for 4 hours using persisted SQLite runtime keys.
- If heartbeat execution fails, it sends a Telegram alert.
- Alerts are sent to the most recent authorized chat seen at runtime.
- `/heartbeat` forces an immediate run and returns a summary of the outcome.
- `/status` reports heartbeat interval/running/last run/last result plus idle and latest Telegram summary.
- `/clear` resets conversation state, heartbeat runtime keys (including dedup keys), and task state.

## Task Management

Long operations automatically move to background after 60s timeout without killing Codex execution.

- Telegram immediately receives a message with `Task ID`.
- When the job finishes, the result is delivered automatically.
- If delivery fails, it is retried on the next heartbeat cycle.

Use natural language for task operations:

- "Mostra i task attivi"
- "Dammi i dettagli del task dl-..."
- "Ritenta il task dl-..."
- "Cancella il task precedente"
- "Tra 5 minuti mandami i top post di Hacker News"

When runtime tasks and TODO intents are ambiguous, the agent asks explicit confirmation before executing.

Legacy commands (`/tasks`, `/task <id>`, `/retrytask <id>`, `/canceltask <id>`) remain available for debugging.

Example `HEARTBEAT.md`:

```md
# Heartbeat

- Use Runtime status as source of truth.
- Review idle duration, recent messages, and TODO snapshot.
- If no action is needed, reply exactly HEARTBEAT_OK.
- If action is needed, reply with JSON only:
  {"action":"checkin|alert","issue":"...","impact":"...","nextStep":"...","todoItems":["..."]}
```

## Bootstrap skill locali (hosting migration-friendly)

Le skill che vuoi portare tra host vanno versionate nel repository:

- `skills/<skill-id>/SKILL.md`

All'avvio, il processo sincronizza automaticamente le skill da `./skills` a `/data/.codex/skills`:
- copia le skill mancanti;
- aggiorna le skill gia presenti quando `SKILL.md` diverge dalla versione nel repository;
- lascia inalterate le skill gia allineate.

Se serve, puoi cambiare sorgente con `PROJECT_SKILLS_ROOT`.

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
