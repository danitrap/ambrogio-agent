# Personal VPS ambrogio-agent (Telegram + Skills)

Personal-only ambrogio-agent wrapper for Telegram with a secure `/data` boundary and Agent Skills-style skill loading.

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
- Soft-timeout for long requests (60s): user gets immediate "background job" feedback while Codex continues.
- Background job lifecycle persisted in SQLite with delivery retry.
- Three background job types:
  - **Immediate jobs** (kind='background'): Long-running requests that timed out
  - **One-shot jobs** (kind='delayed'): Future execution at a specific time (e.g., "fra 5 minuti...")
  - **Recurring jobs** (kind='recurring'): Repeating scheduled execution (e.g., "ogni giorno alle 6")
- Natural-language job management (`list`, `inspect`, `retry`, `cancel`, `pause`, `resume`) with explicit confirmation on ambiguity.

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
docker compose restart ambrogio-agent
```

Auth data is persisted in the mounted `./data/.codex` directory.

All writable state is under `./data` on the host, mounted to `/data` in the container.

## Heartbeat MVP

The ambrogio-agent runs a dedicated heartbeat every 30 minutes (fixed interval, no configuration flags).

- Reads optional `/data/HEARTBEAT.md` instructions.
- Runs a lightweight model check with a runtime status block.
- Runtime status includes local timezone/date-time, heartbeat last state, idle duration, recent Telegram messages, conversation context (last 8 turns), TODO path, and TODO open-item snapshot (max 10).
- Runtime status includes job metrics: pending background deliveries, scheduled one-shot jobs, and active recurring jobs.
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

## Job Management

Long operations automatically move to background after 60s timeout without killing Codex execution.

- Telegram immediately receives a message with `Job ID`.
- When the job finishes, the result is delivered automatically.
- If delivery fails, it is retried on the next heartbeat cycle.

### Job Types

1. **Immediate jobs** (kind='background'): Chat requests that took too long
2. **One-shot jobs** (kind='delayed'): Execute once at a specific future time
3. **Recurring jobs** (kind='recurring'): Execute repeatedly on a schedule

### Natural Language Operations

**One-shot and immediate jobs:**
- "Mostra i task attivi"
- "Dammi i dettagli del task dl-..."
- "Ritenta il task dl-..."
- "Cancella il task precedente"
- "Tra 5 minuti mandami i top post di Hacker News"

**Recurring jobs:**
- "Dimmi se pioverà a Milano, ogni giorno alle 6 di mattina"
- "Check disk space every hour"
- "Mostra i job ricorrenti"
- "Metti in pausa il job rc-..."
- "Riprendi il job rc-..."
- "Cancella il job weather"

### Muted Reminders

Temporarily mute jobs to prevent notifications until a specified time. Useful when you're already doing what the reminder was for (e.g., "I'm on the tram, stop alerting me").

**Mute operations:**

- `ambrogioctl jobs mute --id <jobId> --until <ISO timestamp>` - Mute specific job
- `ambrogioctl jobs mute-pattern --pattern <text> --until <ISO timestamp>` - Mute jobs matching pattern
- `ambrogioctl jobs unmute --id <jobId>` - Unmute job
- `ambrogioctl jobs list-muted [--limit N]` - List currently muted jobs

**Natural language:**

- "I'm on the tram" → Mutes tram-related reminders until tomorrow morning
- "Stop bothering me about weather" → Mutes weather jobs
- "Show muted jobs" → Lists muted jobs
- "Unmute the tram reminders" → Clears mute on tram jobs

**Behavior:**

- One-shot jobs: Marked as `skipped_muted` when muted, never delivered
- Recurring jobs: Continue scheduling but skip execution until unmuted
- Jobs automatically unmute when `muted_until` time passes
- All job deliveries include "⏰ [Background Job]" prefix

When runtime jobs and TODO intents are ambiguous, the ambrogio-agent asks explicit confirmation before executing.

Legacy commands (`/tasks`, `/task <id>`, `/retrytask <id>`, `/canceltask <id>`) remain available for debugging.

## Skill Sync System

Skills can sync their SQLite state to human-readable markdown files for auditability.

### How It Works

Skills declare sync configuration in a `SYNC.json` manifest:

```json
{
  "version": "1",
  "outputFile": "/data/MEMORY.md",
  "patterns": ["memory:*"],
  "generator": "./scripts/sync.sh",
  "description": "Syncs semantic memory"
}
```

The generator script formats data from SQLite to markdown:

```bash
#!/usr/bin/env bash
# Environment variables provided:
# - SYNC_OUTPUT_FILE: target file path
# - SYNC_PATTERNS: comma-separated patterns
# - SKILL_DIR: skill directory path

ambrogioctl state list --pattern "$SYNC_PATTERNS" --json | \
  # ... format as markdown ...
  > "$SYNC_OUTPUT_FILE"
```

### Commands

```bash
# List skills with sync capability
ambrogioctl sync list

# Generate sync file for specific skill
ambrogioctl sync generate --skill memory-manager

# Generate for all skills
ambrogioctl sync generate --all

# Validate manifest
ambrogioctl sync validate --skill memory-manager
```

### Skills with Sync

- **memory-manager**: Syncs to `/data/MEMORY.md` - semantic memory with preferences, facts, and patterns
- **structured-notes**: Syncs to `/data/NOTES.md` - organized notes by type (project, decision, log) with tags

### Local Job RPC (for skills/tools)

Ambrogio exposes a local Unix-socket job RPC server:

- Socket path: `/tmp/ambrogio-agent.sock` (override with `AMBROGIO_SOCKET_PATH`)
- Protocol: one-line JSON request/response envelopes (`ok/result` or `ok=false/error`)

CLI client:

**One-shot and immediate jobs (tasks scope):**
```bash
bun run ctl -- tasks list --json
bun run ctl -- tasks inspect --id <task-id> --json
bun run ctl -- tasks create --run-at 2099-01-01T10:00:00.000Z --prompt "..." --user-id 123 --chat-id 123 --json
bun run ctl -- tasks cancel --id <task-id> --json
bun run ctl -- tasks retry --id <task-id> --json
```

**Recurring jobs (jobs scope):**
```bash
bun run ctl -- jobs create-recurring --run-at 2099-01-01T10:00:00.000Z --prompt "..." --user-id 123 --chat-id 123 --type interval --expression "1h" --json
bun run ctl -- jobs list-recurring --json
bun run ctl -- jobs pause --id <job-id> --json
bun run ctl -- jobs resume --id <job-id> --json
bun run ctl -- jobs update-recurrence --id <job-id> --expression "2h" --json
```

**Telegram media:**
```bash
bun run ctl -- telegram send-photo --path /data/path/to/image.png --json
bun run ctl -- telegram send-audio --path /data/path/to/audio.mp3 --json
bun run ctl -- telegram send-document --path /data/path/to/file.pdf --json
```

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
- File/photo/audio delivery is performed through local RPC (`ambrogioctl telegram ...`), not XML-like output tags.
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
  --dest /Users/daniele/Code/ambrogio-agent/data/.codex/skills
```
