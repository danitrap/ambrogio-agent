# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `src/`, grouped by responsibility:
- `src/app/` service orchestration (`AmbrogioAgentService`)
- `src/auth/`, `src/skills/`, `src/model/`, `src/telegram/`, `src/logging/`
- `src/main.ts` process entrypoint

Tests live in `test/` as Bun test files (for example, `test/ambrogio-agent-service.test.ts`). Runtime data is mounted under `data/`. Skills are discovered from both `data/skills/` and `data/.codex/skills/` (via `CODEX_HOME`). Design notes and planning docs are in `docs/plans/`.

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `bun run dev`: run the ambrogio-agent locally from `src/main.ts`.
- `bun run start`: production-style local start.
- `bun test`: run unit/integration tests in `test/`.
- `bun run typecheck`: run strict TypeScript checks without emit.
- `docker compose up -d --build`: build and run the containerized stack.

After code or configuration changes, rebuild and restart containers with `docker compose up -d --build` before validation.

## Coding Style & Naming Conventions
Use TypeScript ES modules with strict compiler settings (`tsconfig.json`).
- Indentation: 2 spaces.
- Strings: double quotes.
- Naming: `PascalCase` for classes/types, `camelCase` for functions/variables, `kebab-case` for file names (for example, `ambrogio-agent-service.ts`).
- Keep modules focused by domain folder; avoid cross-cutting utility dumps.

## Testing Guidelines
Use `bun:test` (`describe`, `test`, `expect`) and keep tests close to observable behavior. Name test files as `*.test.ts` under `test/`, mirroring source domains when possible. Cover authorization boundaries, filesystem safety, and model/tool interaction paths before merging. Run both `bun test` and `bun run typecheck` before opening a PR.

## Commit & Pull Request Guidelines
Follow Conventional Commit style seen in history: `feat: ...`, `fix: ...`, `docs: ...`. Keep commits scoped to one logical change.

PRs should include:
- concise summary of behavior changes,
- linked issue/task (if applicable),
- verification evidence (test/typecheck output),
- config or operational notes (`.env`, Docker, `data/` impacts).

## Security & Configuration Tips
Never commit secrets. Copy `.env.example` to `.env` locally and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`.

## Heartbeat Runtime Contract
- Heartbeat runs every 30 minutes in a dedicated loop in `src/main.ts`.
- Heartbeat context includes runtime status, local date/time + timezone, last heartbeat state, idle duration, recent Telegram messages, conversation context (last 8 turns), TODO path, and TODO open-item snapshot.
- Heartbeat instructions are read from `/data/HEARTBEAT.md` and should drive policy decisions (`skills > code`).
- Expected heartbeat model output:
  - `HEARTBEAT_OK` when no action is needed.
  - Otherwise compact JSON: `{"action":"checkin|alert","issue":"...","impact":"...","nextStep":"...","todoItems":["..."]}`.
- `checkin` and `alert` are distinct runtime outcomes:
  - `checkin` sends a check-in Telegram message.
  - `alert` sends an alert Telegram message.
- Heartbeat deduplicates repeated timer-triggered messages for 4 hours using SQLite runtime state.
- `/status` must report heartbeat interval/in-flight/last-run/last-result and idle data.
- `/heartbeat` forces an immediate heartbeat run and returns an explicit result summary.
- `/clear` must clear heartbeat runtime keys (last run/result + dedup keys) along with conversation runtime state and task state.

## Task Runtime Contract

- Long-running user requests use a soft timeout (60 seconds): if timeout is reached, the user receives an immediate "background task" confirmation with `Task ID`, and Codex execution continues in background.
- Background task state is persisted in SQLite and includes delivery status.
- Completed task delivery is retried automatically (heartbeat-driven) when immediate delivery fails.
- Delayed one-shot tasks are accepted via natural-language scheduling requests and persisted in SQLite with absolute run time (`runAt`).
- A scheduler loop executes due delayed tasks and delivers results through the same Telegram dispatch path.
- Natural-language task management must cover listing, inspection, retry, and cancellation of runtime tasks.
- If runtime-task intent vs TODO intent is ambiguous, runtime must ask explicit confirmation before executing.
- `/tasks`, `/task <id>`, `/retrytask <id>`, and `/canceltask <id>` are legacy debug commands and should not be required for normal operation.
- Runtime exposes a local task RPC control plane on Unix socket (`/tmp/ambrogio-agent.sock`, override with `AMBROGIO_SOCKET_PATH`) for tools/skills integration.
