# Personal VPS Agent Design (Telegram + Codex ACP + Agent Skills)

Date: 2026-02-07

## Goals

Build a personal assistant agent that runs in Docker on a Hetzner VPS, receives input from Telegram, and can read/write files in a mounted host directory. The system should be secure by design, single-user only, and extensible with Agent Skills-style capabilities.

## Confirmed Decisions

- User scope: personal-only (single Telegram user)
- Transport: Telegram long polling
- Authz: strict Telegram `from.id` allowlist (single allowed ID)
- File model: model can edit files in mounted `/data`
- Runtime model: thin wrapper around Codex-compatible model access
- Snapshot safety: Git snapshot before each write
- Skills model: Agent Skills-compatible framework (`SKILL.md` based), Core v1 (no strict validator yet)
- Container hardening: read-only rootfs, only `/data` writable

## Architecture

Recommended approach: single container service with strict internal boundaries.

Pipeline:
1. Telegram adapter receives update via long polling.
2. Allowlist gate enforces single authorized Telegram user.
3. Model bridge forwards turn to local `codex-acp` process.
4. Skill resolver picks relevant Agent Skills from `/data/skills`.
5. Tool host executes only approved file tools inside `/data`.
6. On any write request, Git snapshot is created before mutation.
7. Reply returned to Telegram with operation summary and rollback reference.

## Core Components

- `telegram/adapter.ts`
  - Poll updates and send responses.
- `auth/allowlist.ts`
  - Deny all users except configured Telegram ID.
- `model/codex_acp_bridge.ts`
  - Spawn and communicate with local `codex-acp` over stdio.
- `skills/discovery.ts`
  - Discover `/data/skills/*/SKILL.md` and index metadata.
- `skills/resolver.ts`
  - Select relevant skills per message and hydrate only when needed.
- `tools/fs_tools.ts`
  - `list_files`, `read_file`, `write_file`, `search` rooted to `/data`.
- `snapshots/git.ts`
  - Ensure pre-write commit and return snapshot hash.
- `logging/audit.ts`
  - Structured logs for auth decisions, tool calls, writes, errors.

## Tool Contract (v1)

The model can use only:
- `list_files(path=".")`
- `read_file(path)`
- `write_file(path, content, expected_sha256?)`
- `search(query, path=".")`

Rules:
- All paths are canonicalized and must resolve under `/data`.
- Symlink escapes are rejected (`realpath` boundary check).
- Writes are atomic (`tmp -> fsync -> rename`).
- Snapshot must succeed before any write (fail closed).
- Size limits for reads/writes prevent abuse and accidental large payloads.

## Agent Skills-Compatible Design (Core v1)

Skill directory format:
- `/data/skills/<skill-name>/SKILL.md`
- Optional: `scripts/`, `references/`, `assets/`

Behavior:
- Startup loads lightweight index (name/description/frontmatter if present).
- Full skill content is loaded only when selected for a request.
- Skill-local resources are loaded only on demand.
- No strict schema validator in v1; malformed skills are skipped with warnings.

This delivers Agent Skills-like modularity now with minimal operational complexity.

## Security Model

Container-level:
- `read_only: true`
- writable bind mount only at `/data`
- `tmpfs: /tmp`
- run as non-root user
- `cap_drop: ["ALL"]`
- `no-new-privileges: true`
- memory/CPU limits
- restart policy `unless-stopped`

Application-level:
- Hard Telegram allowlist gate before model interaction.
- Filesystem tools strictly scoped to `/data`.
- No arbitrary shell execution tool in v1.
- Audit logging for traceability.

Operational-level:
- Secrets in environment (bot token, ACP runtime config).
- Optional outbound firewall restrictions (Telegram + required model endpoints only).

## Error Handling

- Unauthorized user: hard deny, no model/tool invocation.
- `codex-acp` unavailable: return temporary failure, keep process alive with retry/backoff.
- Snapshot failure: block write (fail closed).
- Git lock/contention: return busy response and retry guidance.
- Write failure: return structured error; never leave partial writes.
- Skill load failure: skip skill, continue with remaining skills.

## Testing Strategy

Unit tests:
- path traversal rejection
- symlink escape rejection
- atomic write guarantees
- snapshot-before-write invariant
- allowlist auth gate

Integration tests:
- Telegram message -> model -> write -> verify pre-write commit exists
- unauthorized Telegram ID denied
- skill discovery and lazy hydration from `/data/skills`

Security checks:
- container cannot write outside `/data`
- tool host rejects any path outside `/data`

## Deployment Notes

Required environment variables (initial):
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `DATA_ROOT=/data`
- `ACP_COMMAND=codex-acp`
- `ACP_ARGS` (optional)
- `LOG_LEVEL=info`

Mounted volumes:
- `/host/path/agent-data:/data:rw`

Future v2:
- Add `exec_utility` tool with explicit utility allowlist and argument schema validation.

## Build vs Borrow Outcome

Compared to `nanoclaw`, this design is intentionally narrower:
- Codex ACP-centric runtime
- Telegram-first
- single-user personal operation
- strict `/data` boundary
- Git pre-write snapshots as default recovery primitive

Decision: build from scratch with a thin wrapper + Agent Skills-compatible framework.
