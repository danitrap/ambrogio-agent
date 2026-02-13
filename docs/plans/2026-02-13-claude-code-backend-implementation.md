# Claude Code Backend Alternative Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Claude Code CLI as an alternative backend alongside Codex, selectable via environment variable at startup.

**Architecture:** Factory pattern creates either CodexBridge or ClaudeBridge based on BACKEND env var. Refactor existing ExecBridge into CodexBridge (minimal changes). Create new ClaudeBridge that uses Claude CLI with JSON output. Update config, main.ts, skills bootstrap, and Docker setup.

**Tech Stack:** TypeScript, Bun, Docker, Claude Code CLI, existing ModelBridge interface

---

## Task 1: Add Configuration for Backend Selection

**Files:**
- Modify: `src/config/env.ts`
- Test: Manual verification (no unit tests for config loader currently)

**Step 1: Add backend and Claude config fields to AppConfig type**

In `src/config/env.ts`, update the `AppConfig` type:

```typescript
export type AppConfig = {
  telegramBotToken: string;
  telegramAllowedUserId: number;
  openaiApiKey: string;
  elevenLabsApiKey: string | null;
  dataRoot: string;
  codexCommand: string;
  codexArgs: string[];
  backend: 'codex' | 'claude';  // NEW
  claudeCommand: string;  // NEW
  claudeArgs: string[];  // NEW
  logLevel: LogLevel;
  telegramPollTimeoutSeconds: number;
  heartbeatQuietHours: string | null;
};
```

**Step 2: Load new environment variables in loadConfig()**

In `src/config/env.ts`, update the `loadConfig()` function to parse new env vars:

```typescript
export function loadConfig(): AppConfig {
  const logLevel = (Bun.env.LOG_LEVEL ?? "info") as LogLevel;
  const codexArgsRaw = Bun.env.CODEX_ARGS;
  const codexArgs = codexArgsRaw
    ? codexArgsRaw.split(" ").map((part) => part.trim()).filter(Boolean)
    : ["--dangerously-bypass-approvals-and-sandbox"];

  const backend = (Bun.env.BACKEND?.toLowerCase() ?? 'codex') as 'codex' | 'claude';
  const claudeArgsRaw = Bun.env.CLAUDE_ARGS;
  const claudeArgs = claudeArgsRaw
    ? claudeArgsRaw.split(" ").map((part) => part.trim()).filter(Boolean)
    : [];

  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserId: parseNumber(requireEnv("TELEGRAM_ALLOWED_USER_ID"), "TELEGRAM_ALLOWED_USER_ID"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    elevenLabsApiKey: Bun.env.ELEVENLABS_API_KEY ?? null,
    dataRoot: Bun.env.DATA_ROOT ?? "/data",
    codexCommand: Bun.env.CODEX_COMMAND ?? "codex",
    codexArgs,
    backend,
    claudeCommand: Bun.env.CLAUDE_COMMAND ?? "claude",
    claudeArgs,
    logLevel,
    telegramPollTimeoutSeconds: parseNumber(Bun.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? "20", "TELEGRAM_POLL_TIMEOUT_SECONDS"),
    heartbeatQuietHours: Bun.env.HEARTBEAT_QUIET_HOURS?.trim() || null,
  };
}
```

**Step 3: Verify config loads correctly**

Run: `bun run typecheck`
Expected: No TypeScript errors

**Step 4: Update .env.example with new variables**

Add to `.env.example`:

```bash
# Backend selection (codex or claude, default: codex)
BACKEND=codex
# Claude Code CLI configuration (only used when BACKEND=claude)
CLAUDE_COMMAND=claude
CLAUDE_ARGS=
```

**Step 5: Commit config changes**

```bash
git add src/config/env.ts .env.example
git commit -m "feat: add backend selection config for Codex/Claude"
```

---

## Task 2: Refactor ExecBridge to CodexBridge

**Files:**
- Create: `src/model/codex-bridge.ts`
- Modify: `src/model/exec-bridge.ts` (add deprecation notice)

**Step 1: Copy ExecBridge to CodexBridge**

```bash
cp src/model/exec-bridge.ts src/model/codex-bridge.ts
```

**Step 2: Rename class in CodexBridge**

In `src/model/codex-bridge.ts`, rename the class:

```typescript
export class CodexBridge implements ModelBridge {
  // ... rest of implementation stays the same
}
```

**Step 3: Add deprecation comment to ExecBridge**

At the top of `src/model/exec-bridge.ts`, add:

```typescript
/**
 * @deprecated Use CodexBridge instead. This file is kept temporarily for reference.
 * Will be removed in a future release.
 */
```

**Step 4: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: No errors

**Step 5: Commit CodexBridge creation**

```bash
git add src/model/codex-bridge.ts src/model/exec-bridge.ts
git commit -m "refactor: extract CodexBridge from ExecBridge"
```

---

## Task 3: Create ClaudeBridge with JSON Response Type

**Files:**
- Create: `src/model/claude-bridge.ts`
- Test: Will add in next task

**Step 1: Create ClaudeBridge file with imports and types**

Create `src/model/claude-bridge.ts`:

```typescript
import type { Logger } from "../logging/audit";
import { correlationFields } from "../logging/correlation";
import type { ModelBridge, ModelExecutionSummary, ModelRequest, ModelResponse } from "./types";

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

type ClaudeJsonResponse = {
  type: "result";
  subtype?: "success" | "error";
  is_error?: boolean;
  result: string;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: {
      web_search_requests?: number;
      web_fetch_requests?: number;
    };
  };
  session_id?: string;
  total_cost_usd?: number;
  stop_reason?: string | null;
};

type ClaudeAuditAction = {
  type: "web_search" | "web_fetch";
  detail: string;
};

function previewLogText(value: string, max = 240): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function buildPromptText(request: ModelRequest): string {
  return request.message;
}
```

**Step 2: Add audit action extraction function**

In `src/model/claude-bridge.ts`, add:

```typescript
export function extractClaudeAuditActions(jsonResponse: ClaudeJsonResponse): ClaudeAuditAction[] {
  const actions: ClaudeAuditAction[] = [];
  const usage = jsonResponse.usage;

  if (!usage || !usage.server_tool_use) {
    return actions;
  }

  const searches = usage.server_tool_use.web_search_requests ?? 0;
  const fetches = usage.server_tool_use.web_fetch_requests ?? 0;

  if (searches > 0) {
    actions.push({
      type: "web_search",
      detail: `${searches} search${searches === 1 ? '' : 'es'}`,
    });
  }

  if (fetches > 0) {
    actions.push({
      type: "web_fetch",
      detail: `${fetches} fetch${fetches === 1 ? '' : 'es'}`,
    });
  }

  return actions;
}
```

**Step 3: Add ClaudeBridge class skeleton**

```typescript
export class ClaudeBridge implements ModelBridge {
  private readonly cwd?: string;
  private readonly rootDir: string;
  private readonly envOverrides?: Record<string, string>;
  private lastExecutionSummary: ModelExecutionSummary | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    options: BridgeOptions = {},
  ) {
    this.cwd = options.cwd;
    this.rootDir = path.resolve(options.cwd ?? process.cwd());
    this.envOverrides = options.env;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    // Will implement in next step
    throw new Error("Not implemented");
  }

  getLastExecutionSummary(): ModelExecutionSummary | null {
    return this.lastExecutionSummary;
  }
}
```

**Step 4: Add missing import**

At top of file:

```typescript
import { resolve } from "node:path";
```

**Step 5: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: No errors

**Step 6: Commit ClaudeBridge skeleton**

```bash
git add src/model/claude-bridge.ts
git commit -m "feat: add ClaudeBridge skeleton with types"
```

---

## Task 4: Implement ClaudeBridge.respond() Method

**Files:**
- Modify: `src/model/claude-bridge.ts`

**Step 1: Implement respond() method with process spawning**

Replace the `respond()` method in `src/model/claude-bridge.ts`:

```typescript
async respond(request: ModelRequest): Promise<ModelResponse> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const requestId = request.requestId;
  const prompt = buildPromptText(request);

  const hasDangerFlag = this.args.includes("--dangerously-skip-permissions");
  const execArgs = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--add-dir",
    this.cwd ?? this.rootDir,
    ...(hasDangerFlag ? this.args : ["--dangerously-skip-permissions", ...this.args]),
  ];
  const execCommand = this.command;
  this.lastExecutionSummary = {
    requestId,
    command: execCommand,
    startedAt: startedAtIso,
    status: "running",
    promptLength: prompt.length,
  };
  this.logger.info("claude_exec_started", {
    ...correlationFields({ requestId }),
    command: execCommand,
    args: execArgs,
    cwd: this.cwd ?? this.rootDir,
    promptLength: prompt.length,
  });

  const process = Bun.spawn([execCommand, ...execArgs], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: this.cwd,
    env: {
      ...Bun.env,
      ...(this.envOverrides ?? {}),
      NO_COLOR: Bun.env.NO_COLOR ?? "1",
    },
  });
  const abortSignal = request.signal;
  const abortHandler = () => {
    try {
      process.kill();
    } catch {
      // Ignore kill issues when process already ended.
    }
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      abortHandler();
    } else {
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const stdinSink = process.stdin;
  const stdoutStream = process.stdout;
  const stderrStream = process.stderr;
  if (!stdinSink || typeof stdinSink === "number" || !(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
    this.logger.error("exec_pipe_setup_failed", { requestId, command: execCommand });
    this.lastExecutionSummary = {
      requestId,
      command: execCommand,
      startedAt: startedAtIso,
      status: "error",
      promptLength: prompt.length,
      errorMessage: "exec_pipe_setup_failed",
    };
    return { text: "Model backend unavailable right now." };
  }

  const stderrPromise = new Response(stderrStream).text();
  const stdoutPromise = new Response(stdoutStream).text();

  try {
    stdinSink.write(prompt);
    stdinSink.end();
    const exitCode = await process.exited;
    const stderr = (await stderrPromise).trim();
    const stdout = (await stdoutPromise).trim();

    this.logger.info("claude_exec_streams", {
      ...correlationFields({ requestId }),
      command: execCommand,
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });

    let text = "";
    let jsonResponse: ClaudeJsonResponse | null = null;

    // Try parsing JSON response
    try {
      jsonResponse = JSON.parse(stdout) as ClaudeJsonResponse;
      text = jsonResponse.result ?? "";

      const auditActions = extractClaudeAuditActions(jsonResponse);
      if (auditActions.length > 0) {
        this.logger.info("claude_exec_audit", {
          ...correlationFields({ requestId }),
          command: execCommand,
          exitCode,
          auditActionCount: auditActions.length,
          auditActions,
        });
      }
    } catch {
      // JSON parse failed - fall back to raw stdout
      this.logger.warn("claude_json_parse_failed", {
        ...correlationFields({ requestId }),
        command: execCommand,
        stdoutLength: stdout.length,
        stdoutPreview: previewLogText(stdout),
      });
      text = stdout;
    }

    if (exitCode !== 0) {
      this.logger.error("exec_command_failed", {
        ...correlationFields({ requestId }),
        command: execCommand,
        exitCode,
        stderr,
      });
    }

    if (!text) {
      const durationMs = Date.now() - startedAt;
      this.logger.warn("claude_exec_empty_output", {
        ...correlationFields({ requestId }),
        command: execCommand,
        exitCode,
        durationMs,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stdoutPreview: previewLogText(stdout),
        stderrPreview: previewLogText(stderr),
      });
      this.lastExecutionSummary = {
        requestId,
        command: execCommand,
        startedAt: startedAtIso,
        durationMs,
        status: "empty_output",
        exitCode,
        promptLength: prompt.length,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stdoutPreview: previewLogText(stdout),
        stderrPreview: previewLogText(stderr),
      };
      return { text: "Model backend unavailable right now." };
    }

    const responseText = text.trim();
    const durationMs = Date.now() - startedAt;
    this.logger.info("claude_exec_completed", {
      ...correlationFields({ requestId }),
      command: execCommand,
      exitCode,
      durationMs,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      outputLength: responseText.length,
      stdoutPreview: previewLogText(stdout),
      stderrPreview: previewLogText(stderr),
      outputPreview: previewLogText(responseText),
    });
    this.lastExecutionSummary = {
      requestId,
      command: execCommand,
      startedAt: startedAtIso,
      durationMs,
      status: "completed",
      exitCode,
      promptLength: prompt.length,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      outputLength: responseText.length,
      stdoutPreview: previewLogText(stdout),
      stderrPreview: previewLogText(stderr),
      outputPreview: previewLogText(responseText),
    };

    return { text: responseText };
  } catch (error) {
    const stderr = (await stderrPromise).trim();
    const stdout = (await stdoutPromise).trim();
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("claude_exec_streams_error", {
      ...correlationFields({ requestId }),
      command: execCommand,
      stdout,
      stderr,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });
    this.logger.error("exec_command_error", {
      ...correlationFields({ requestId }),
      command: execCommand,
      message,
      stderr,
      durationMs,
    });
    this.lastExecutionSummary = {
      requestId,
      command: execCommand,
      startedAt: startedAtIso,
      durationMs,
      status: "error",
      promptLength: prompt.length,
      stderrLength: stderr.length,
      stderrPreview: previewLogText(stderr),
      errorMessage: message,
    };
    return { text: "Model backend unavailable right now." };
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Commit ClaudeBridge implementation**

```bash
git add src/model/claude-bridge.ts
git commit -m "feat: implement ClaudeBridge.respond() with JSON parsing"
```

---

## Task 5: Create Bridge Factory

**Files:**
- Create: `src/model/bridge-factory.ts`

**Step 1: Create factory with types and imports**

Create `src/model/bridge-factory.ts`:

```typescript
import type { Logger } from "../logging/audit";
import { CodexBridge } from "./codex-bridge";
import { ClaudeBridge } from "./claude-bridge";
import type { ModelBridge } from "./types";

export type BridgeConfig = {
  codexCommand: string;
  codexArgs: string[];
  claudeCommand: string;
  claudeArgs: string[];
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  };
};
```

**Step 2: Add factory function**

```typescript
export function createModelBridge(
  backend: 'codex' | 'claude',
  config: BridgeConfig,
  logger: Logger
): ModelBridge {
  switch (backend) {
    case 'codex':
      return new CodexBridge(
        config.codexCommand,
        config.codexArgs,
        logger,
        config.options
      );
    case 'claude':
      return new ClaudeBridge(
        config.claudeCommand,
        config.claudeArgs,
        logger,
        config.options
      );
    default:
      // TypeScript exhaustiveness check
      const _exhaustive: never = backend;
      throw new Error(`Unknown backend: ${_exhaustive}`);
  }
}
```

**Step 3: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: No errors

**Step 4: Commit bridge factory**

```bash
git add src/model/bridge-factory.ts
git commit -m "feat: add model bridge factory for backend selection"
```

---

## Task 6: Update main.ts to Use Factory

**Files:**
- Modify: `src/main.ts`

**Step 1: Add factory import and update bridge creation**

In `src/main.ts`, replace the ExecBridge import and instantiation:

Find:
```typescript
import { ExecBridge } from "./model/exec-bridge";
```

Replace with:
```typescript
import { createModelBridge } from "./model/bridge-factory";
```

**Step 2: Update modelBridge instantiation**

Find:
```typescript
const modelBridge = new ExecBridge(config.codexCommand, config.codexArgs, logger, {
  cwd: config.dataRoot,
  env: {
    CODEX_HOME: codexHome,
    HOME: homeDir,
    NO_COLOR: Bun.env.NO_COLOR ?? "1",
  },
});
```

Replace with:
```typescript
const claudeHome = Bun.env.CLAUDE_HOME ?? `${config.dataRoot}/.claude`;
await mkdir(claudeHome, { recursive: true });

const modelBridge = createModelBridge(
  config.backend,
  {
    codexCommand: config.codexCommand,
    codexArgs: config.codexArgs,
    claudeCommand: config.claudeCommand,
    claudeArgs: config.claudeArgs,
    options: {
      cwd: config.dataRoot,
      env: {
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        HOME: homeDir,
        NO_COLOR: Bun.env.NO_COLOR ?? "1",
      },
    },
  },
  logger
);
```

**Step 3: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: No errors

**Step 4: Test that app starts with default backend**

Run: `bun run dev` (will fail without Telegram credentials, but should parse config)
Expected: No TypeScript/config errors

**Step 5: Commit main.ts update**

```bash
git add src/main.ts
git commit -m "feat: integrate bridge factory into main startup"
```

---

## Task 7: Update Skills Bootstrap for Dual Sync

**Files:**
- Modify: `src/main.ts` (skills bootstrap section)

**Step 1: Sync skills to both Codex and Claude directories**

In `src/main.ts`, find the skills bootstrap section and update:

Find:
```typescript
const codexSkillsRoot = `${codexHome}/skills`;
const bootstrapResult = await bootstrapProjectSkills({
  sourceRoot: projectSkillsRoot,
  destinationRoot: codexSkillsRoot,
});
```

Replace with:
```typescript
const codexSkillsRoot = `${codexHome}/skills`;
const claudeSkillsRoot = `${claudeHome}/skills`;

// Sync to both directories to support backend switching
const codexBootstrapResult = await bootstrapProjectSkills({
  sourceRoot: projectSkillsRoot,
  destinationRoot: codexSkillsRoot,
});
const claudeBootstrapResult = await bootstrapProjectSkills({
  sourceRoot: projectSkillsRoot,
  destinationRoot: claudeSkillsRoot,
});

const bootstrapResult = {
  copied: [...codexBootstrapResult.copied, ...claudeBootstrapResult.copied],
  updated: [...codexBootstrapResult.updated, ...claudeBootstrapResult.updated],
  skipped: [...codexBootstrapResult.skipped, ...claudeBootstrapResult.skipped],
};
```

**Step 2: Update skill discovery to use backend-specific path**

Find the skill discovery line:
```typescript
const skills = new SkillDiscovery(codexSkillsRoot);
```

Replace with:
```typescript
const skillsRoot = config.backend === 'codex' ? codexSkillsRoot : claudeSkillsRoot;
const skills = new SkillDiscovery(skillsRoot);
```

**Step 3: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: No errors

**Step 4: Commit skills bootstrap update**

```bash
git add src/main.ts
git commit -m "feat: sync skills to both Codex and Claude directories"
```

---

## Task 8: Update Dockerfile for Claude CLI

**Files:**
- Modify: `Dockerfile`

**Step 1: Add Claude CLI installation after Codex**

In `Dockerfile`, after the line that installs `@openai/codex`, add:

```dockerfile
# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && export PATH="$HOME/.local/bin:$PATH" \
  && claude --version || echo "Claude CLI installed but needs authentication"
```

**Step 2: Set CLAUDE_HOME environment variable**

After the ENV declarations, add:

```dockerfile
ENV CLAUDE_HOME=/data/.claude
```

**Step 3: Commit Dockerfile update**

```bash
git add Dockerfile
git commit -m "feat: add Claude Code CLI installation to Docker image"
```

---

## Task 9: Update README with New Backend Configuration

**Files:**
- Modify: `README.md`

**Step 1: Update features list to mention dual backend**

In the Features section, update the backend-related line:

```markdown
- Dual backend support: OpenAI Codex (`codex exec`) or Claude Code (`claude -p`) via `BACKEND` env var
```

**Step 2: Add backend configuration to environment variables section**

In the `.env` setup section, add:

```markdown
- `BACKEND` (default: `codex`, options: `codex` or `claude`)
- `CLAUDE_COMMAND` (default: `claude`, only used when `BACKEND=claude`)
- `CLAUDE_ARGS` (optional additional args for Claude Code)
```

**Step 3: Add Claude authentication section**

After the "ChatGPT login (device auth)" section, add:

```markdown
## Claude Code authentication (token auth)

When using `BACKEND=claude`, authenticate via token:

```bash
docker exec -it ambrogio-agent sh -lc 'HOME=/data CLAUDE_HOME=/data/.claude claude setup-token'
docker compose restart ambrogio-agent
```

Requires a Claude subscription. Token is persisted in `./data/.claude`.

```

**Step 4: Update model bridge contract section**

Update the "Model bridge contract (current)" section:

```markdown
## Model bridge contract (current)

The service runs either `codex exec` or `claude -p` per request based on `BACKEND` env var.

**Codex mode:**
- `--output-last-message` captures the final assistant message to a file
- Tool execution handled inside Codex runtime

**Claude mode:**
- `--output-format json` returns structured response via stdout
- `--no-session-persistence` since conversation state managed externally
- Tool execution handled inside Claude runtime
```

**Step 5: Commit README update**

```bash
git add README.md
git commit -m "docs: update README for dual backend support"
```

---

## Task 10: Write Unit Tests for ClaudeBridge

**Files:**
- Create: `test/claude-bridge.test.ts`

**Step 1: Write test for successful JSON response**

Create `test/claude-bridge.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { extractClaudeAuditActions } from "../src/model/claude-bridge";

describe("extractClaudeAuditActions", () => {
  test("extracts web search and fetch counts", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
      usage: {
        server_tool_use: {
          web_search_requests: 2,
          web_fetch_requests: 1,
        },
      },
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      type: "web_search",
      detail: "2 searches",
    });
    expect(actions[1]).toEqual({
      type: "web_fetch",
      detail: "1 fetch",
    });
  });

  test("handles missing usage data", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(0);
  });

  test("handles zero requests", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
      usage: {
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
      },
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(0);
  });

  test("handles singular counts correctly", () => {
    const response = {
      type: "result" as const,
      result: "Response text",
      usage: {
        server_tool_use: {
          web_search_requests: 1,
          web_fetch_requests: 1,
        },
      },
    };

    const actions = extractClaudeAuditActions(response);

    expect(actions).toHaveLength(2);
    expect(actions[0]?.detail).toBe("1 search");
    expect(actions[1]?.detail).toBe("1 fetch");
  });
});
```

**Step 2: Run tests**

Run: `bun test test/claude-bridge.test.ts`
Expected: All tests pass

**Step 3: Commit tests**

```bash
git add test/claude-bridge.test.ts
git commit -m "test: add unit tests for ClaudeBridge audit extraction"
```

---

## Task 11: Write Unit Tests for Bridge Factory

**Files:**
- Create: `test/bridge-factory.test.ts`

**Step 1: Write test for factory backend selection**

Create `test/bridge-factory.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createModelBridge } from "../src/model/bridge-factory";
import { CodexBridge } from "../src/model/codex-bridge";
import { ClaudeBridge } from "../src/model/claude-bridge";
import { Logger } from "../src/logging/audit";

describe("createModelBridge", () => {
  const logger = new Logger("error");
  const config = {
    codexCommand: "codex",
    codexArgs: ["--test"],
    claudeCommand: "claude",
    claudeArgs: ["-p"],
    options: {
      cwd: "/tmp",
      env: {},
    },
  };

  test("creates CodexBridge when backend is codex", () => {
    const bridge = createModelBridge("codex", config, logger);
    expect(bridge).toBeInstanceOf(CodexBridge);
  });

  test("creates ClaudeBridge when backend is claude", () => {
    const bridge = createModelBridge("claude", config, logger);
    expect(bridge).toBeInstanceOf(ClaudeBridge);
  });
});
```

**Step 2: Run tests**

Run: `bun test test/bridge-factory.test.ts`
Expected: All tests pass

**Step 3: Commit factory tests**

```bash
git add test/bridge-factory.test.ts
git commit -m "test: add unit tests for bridge factory"
```

---

## Task 12: Manual Integration Test with Claude Backend

**Files:**
- Manual testing only

**Step 1: Set environment variables for Claude backend**

Create `test-claude.env`:

```bash
BACKEND=claude
CLAUDE_COMMAND=claude
CLAUDE_ARGS=
# Copy other required vars from .env
```

**Step 2: Verify application starts with Claude backend**

Run: `BACKEND=claude bun run typecheck`
Expected: No errors

**Step 3: Test Claude CLI is available**

Run: `which claude`
Expected: Path to claude binary

**Step 4: Document test results**

Create verification checklist:
- [ ] App compiles with BACKEND=claude
- [ ] Skills sync to both directories
- [ ] Claude CLI is installed
- [ ] Config loads correctly

**Step 5: Commit test documentation**

```bash
git add test-claude.env
git commit -m "test: add manual Claude backend integration test setup"
```

---

## Task 13: Update .gitignore for New Files

**Files:**
- Modify: `.gitignore` (if not already ignored)

**Step 1: Ensure test env files are ignored**

Check if `.gitignore` contains:

```
*.env
!.env.example
```

If not, add these lines.

**Step 2: Commit if changed**

```bash
git add .gitignore
git commit -m "chore: ensure test env files are ignored"
```

---

## Task 14: Final Verification and Cleanup

**Files:**
- All files

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Verify builds compile**

Run: `bun run start --help` (will fail without env, but should compile)
Expected: No TypeScript errors

**Step 4: Create summary commit**

```bash
git add .
git commit -m "feat: complete Claude Code backend implementation

Summary of changes:
- Add backend selection via BACKEND env var (codex|claude)
- Refactor ExecBridge to CodexBridge
- Implement ClaudeBridge with JSON response parsing
- Create bridge factory for backend instantiation
- Sync skills to both Codex and Claude directories
- Update Dockerfile to install Claude CLI
- Add comprehensive unit tests
- Update documentation

All tests pass. Both backends ready for use."
```

**Step 5: Verify git log**

Run: `git log --oneline -15`
Expected: See all feature commits

---

## Execution Notes

- Each task is independent and can be completed in 5-10 minutes
- Follow TDD where applicable (tests before implementation)
- Commit frequently with clear messages
- Test after each major change
- Keep changes focused and minimal per task

## Next Steps After Implementation

1. **Manual testing**: Test with actual Telegram messages using both backends
2. **Performance comparison**: Compare response times and costs between Codex and Claude
3. **Production deployment**: Roll out with BACKEND=codex first, then switch to claude after validation
4. **Monitoring**: Add metrics for backend selection and execution stats
5. **Documentation**: Update deployment guides with backend selection instructions
