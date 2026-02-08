# Refactor Main Orchestration + Heartbeat Quiet Hours + Correlation Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ridurre il rischio di regressioni separando l’orchestrazione runtime da `main.ts`, rimuovere codice orfano, introdurre quiet hours per heartbeat check-in e uniformare i correlation ID nei log.

**Architecture:** Estrarre responsabilita' da `src/main.ts` in moduli runtime dedicati senza cambiare il comportamento funzionale. Aggiungere una policy heartbeat con quiet hours applicata solo ai check-in (non agli alert) e una utility centralizzata per campi log di correlazione (`updateId`, `userId`, `chatId`, `requestId`, `command`).

**Tech Stack:** TypeScript (Bun), `bun:test`, `bun:sqlite`, Telegram Bot API.

---

### Task 1: Baseline Safety Net (No Behavior Change)

**Files:**
- Modify: `/Users/daniele/Code/ambrogio-agent/test/heartbeat.test.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/test/command-handlers.test.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/test/ambrogio-agent-request.test.ts`

**Step 1: Write failing tests for quiet-hours policy entry points**

Add test cases that currently fail because quiet-hours behavior is not implemented:
- timer check-in inside quiet hours -> dropped/suppressed
- timer alert inside quiet hours -> still sent
- manual `/heartbeat` check-in inside quiet hours -> still sent

**Step 2: Write failing test for correlation fields helper usage**

Add a test that expects standardized fields composition for at least one runtime path (`runAmbrogioAgentRequestWithTimeout` or `sendTelegramTextReply`), initially failing because helper does not exist.

**Step 3: Run targeted tests to verify failures**

Run: `bun test test/heartbeat.test.ts test/ambrogio-agent-request.test.ts`
Expected: FAIL on new assertions.

**Step 4: Commit baseline tests**

```bash
git add test/heartbeat.test.ts test/command-handlers.test.ts test/ambrogio-agent-request.test.ts
git commit -m "test: add failing specs for quiet hours and correlation logging"
```

### Task 2: Refactor 2 - Extract Runtime Orchestrators from `main.ts`

**Files:**
- Create: `/Users/daniele/Code/ambrogio-agent/src/runtime/reply-dispatcher.ts`
- Create: `/Users/daniele/Code/ambrogio-agent/src/runtime/heartbeat-runner.ts`
- Create: `/Users/daniele/Code/ambrogio-agent/src/runtime/telegram-update-loop.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/main.ts`
- Test: `/Users/daniele/Code/ambrogio-agent/test/message-sender.test.ts`
- Test: `/Users/daniele/Code/ambrogio-agent/test/heartbeat.test.ts`

**Step 1: Extract `dispatchAssistantReply` to `reply-dispatcher.ts`**

Move parsing (`parseTelegramResponse`), document sending, audio fallback, and text fallback logic as pure exported functions with injected deps.

**Step 2: Extract `runScheduledHeartbeat` and related state wiring to `heartbeat-runner.ts`**

Encapsulate:
- in-flight guard
- last-run/result updates
- dedup handling
- status mapping (`ok`, `checkin_sent`, etc.)

**Step 3: Extract Telegram polling loop to `telegram-update-loop.ts`**

Encapsulate the `while(true)` update loop and command-vs-message branch handling; keep `main.ts` as composition root only.

**Step 4: Keep behavior parity**

Do not change command semantics, message formats, timeout values, or dedup windows.

**Step 5: Run tests**

Run: `bun test`
Expected: PASS.

**Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/main.ts src/runtime/reply-dispatcher.ts src/runtime/heartbeat-runner.ts src/runtime/telegram-update-loop.ts
git commit -m "refactor: split runtime orchestration out of main entrypoint"
```

### Task 3: Refactor 3 - Remove Orphan Recent History JSON Module

**Files:**
- Delete: `/Users/daniele/Code/ambrogio-agent/src/runtime/recent-telegram-history.ts`
- Delete: `/Users/daniele/Code/ambrogio-agent/test/recent-telegram-history.test.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/README.md`

**Step 1: Confirm no production imports**

Run: `rg -n "recent-telegram-history" src test`
Expected: only orphan module + test references.

**Step 2: Remove orphan module and obsolete tests**

Delete JSON-based history module and its test file; runtime already persists history via `StateStore`.

**Step 3: Update docs**

Adjust README if it implies file-based recent history persistence instead of SQLite-backed runtime state.

**Step 4: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove unused file-based recent telegram history module"
```

### Task 4: Feature 3 - Heartbeat Quiet Hours (Check-in Only)

**Files:**
- Create: `/Users/daniele/Code/ambrogio-agent/src/runtime/heartbeat-quiet-hours.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/runtime/heartbeat.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/main.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/config/env.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/.env.example`
- Modify: `/Users/daniele/Code/ambrogio-agent/README.md`
- Test: `/Users/daniele/Code/ambrogio-agent/test/heartbeat.test.ts`

**Step 1: Write/adjust failing tests for policy behavior**

Required matrix:
- `trigger=timer`, action=`checkin`, inside quiet hours -> dropped
- `trigger=timer`, action=`alert`, inside quiet hours -> sent
- `trigger=manual`, action=`checkin`, inside quiet hours -> sent
- outside quiet hours -> unchanged

**Step 2: Implement quiet-hours parser**

Add env config:
- `HEARTBEAT_QUIET_HOURS=23:00-08:00` (optional, local timezone)
- robust validation, fail-fast on invalid format

**Step 3: Implement policy gate**

In heartbeat dispatch path, apply suppression only when:
- trigger is `timer`
- action is `checkin`
- current local time is inside quiet window

Do not suppress alerts.

**Step 4: Add explicit runtime status visibility**

Expose in `/status`:
- quiet-hours configured yes/no
- current in-quiet-hours yes/no

**Step 5: Update docs**

Describe semantics clearly in README and `.env.example`.

**Step 6: Verify**

Run: `bun test test/heartbeat.test.ts && bun run typecheck`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/runtime/heartbeat-quiet-hours.ts src/runtime/heartbeat.ts src/main.ts src/config/env.ts .env.example README.md test/heartbeat.test.ts
git commit -m "feat: add heartbeat quiet hours for timer check-ins only"
```

### Task 5: Feature 4 - End-to-End Correlation IDs in Logs

**Files:**
- Create: `/Users/daniele/Code/ambrogio-agent/src/logging/correlation.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/runtime/ambrogio-agent-request.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/runtime/message-sender.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/model/exec-bridge.ts`
- Modify: `/Users/daniele/Code/ambrogio-agent/src/main.ts`
- Test: `/Users/daniele/Code/ambrogio-agent/test/ambrogio-agent-request.test.ts`
- Test: `/Users/daniele/Code/ambrogio-agent/test/message-sender.test.ts`

**Step 1: Create correlation helper**

Utility that returns canonical fields:
- `updateId`, `userId`, `chatId`, `requestId`, `command`
and avoids repeated ad-hoc object spread logic.

**Step 2: Apply helper in hot paths**

At minimum:
- request timeout/failure logs in `runAmbrogioAgentRequestWithTimeout`
- outbound message logs in `sendTelegramTextReply`
- exec lifecycle logs in `ExecBridge.respond`
- command/action logs in `main.ts`

**Step 3: Ensure backward-compatible log schema**

Keep existing keys and messages when possible; add missing correlation fields, do not remove existing ones.

**Step 4: Add/adjust tests**

Validate logger receives correlation fields in at least:
- timeout path
- successful outbound message path

**Step 5: Verify**

Run: `bun test test/ambrogio-agent-request.test.ts test/message-sender.test.ts && bun run typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/logging/correlation.ts src/runtime/ambrogio-agent-request.ts src/runtime/message-sender.ts src/model/exec-bridge.ts src/main.ts test/ambrogio-agent-request.test.ts test/message-sender.test.ts
git commit -m "feat: standardize correlation ids across runtime logging"
```

### Task 6: Final Validation + Container Rebuild Contract

**Files:**
- Modify: `/Users/daniele/Code/ambrogio-agent/docs/plans/2026-02-08-refactor-heartbeat-observability-plan.md` (checklist tick)

**Step 1: Full verification**

Run:
- `bun test`
- `bun run typecheck`

Expected: all green.

**Step 2: Rebuild/restart container (repo contract)**

Run: `docker compose up -d --build`
Expected: container `ambrogio-agent` healthy/running.

**Step 3: Smoke checks**

Execute manually via Telegram:
- `/status`
- `/heartbeat`
- normal user message
- `/clear`

Verify expected behavior and logging fields.

**Step 4: Commit final polish**

```bash
git add docs/plans/2026-02-08-refactor-heartbeat-observability-plan.md
git commit -m "docs: finalize implementation checklist for runtime refactor and observability"
```

