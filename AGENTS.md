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
- Heartbeat runs every 30 minutes via timer in `src/main.ts`.
- Heartbeat executes the `heartbeat` skill as a **full agent execution** with access to all tools (Read, Bash, Grep, Glob, ambrogioctl, etc.).
- **Quiet hours** are checked BEFORE execution (in `heartbeat-runner.ts`) to avoid wasting tokens during configured silent periods (e.g., 22:00-06:00).
- The skill reads `/data/HEARTBEAT.md` for policy guidance and uses runtime context to decide whether to send messages.
- The skill sends messages directly via `ambrogioctl telegram send-message --text "..."` when necessary.
- If no action is needed, the skill simply completes without sending messages.
- **No deduplication** - The skill will notify every 30 minutes if there are issues or important updates.
- Available runtime status via `ambrogioctl status --json` includes: idle duration, recent messages, conversation context, TODO snapshot, last heartbeat state, model execution summary, and more.
- `/status` reports heartbeat interval/in-flight/last-run/last-result and idle data.
- `/heartbeat` forces an immediate heartbeat run (bypassing quiet hours) and returns a result summary.
- `/clear` clears heartbeat runtime keys (last run/result) along with conversation runtime state and task state.

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
