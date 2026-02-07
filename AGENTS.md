# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `src/`, grouped by responsibility:
- `src/app/` service orchestration (`AgentService`)
- `src/auth/`, `src/tools/`, `src/skills/`, `src/model/`, `src/telegram/`, `src/logging/`
- `src/main.ts` process entrypoint

Tests live in `test/` as Bun test files (for example, `test/fs-tools.test.ts`). Runtime data, snapshots, and skill folders are mounted under `data/`. Design notes and planning docs are in `docs/plans/`.

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `bun run dev`: run the agent locally from `src/main.ts`.
- `bun run start`: production-style local start.
- `bun test`: run unit/integration tests in `test/`.
- `bun run typecheck`: run strict TypeScript checks without emit.
- `docker compose up -d --build`: build and run the containerized stack.

## Coding Style & Naming Conventions
Use TypeScript ES modules with strict compiler settings (`tsconfig.json`).
- Indentation: 2 spaces.
- Strings: double quotes.
- Naming: `PascalCase` for classes/types, `camelCase` for functions/variables, `kebab-case` for file names (for example, `agent-service.ts`).
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
Never commit secrets. Copy `.env.example` to `.env` locally and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`. Keep file operations inside the `/data` boundary and preserve snapshot-on-write behavior.
