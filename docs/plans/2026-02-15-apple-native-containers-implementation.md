# Apple Native Containers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the Ambrogio Agent natively on macOS with full Apple Framework access, while executing Codex/Claude bridge operations inside ephemeral Apple containers for security isolation.

**Architecture:** The agent runs natively on macOS. Both Codex and Claude bridges execute inside ephemeral Apple containers. The container is an execution layer - the bridge type ("codex" or "claude") remains the same, but runs inside the container instead of directly on the host.

**Tech Stack:** Apple `container` CLI (v0.9.0+), Bun runtime, OCI-compatible container images, Unix socket JSON-RPC

---

## Prerequisites

- Apple Silicon Mac (M1-M4)
- macOS 26.2+
- Download and install Apple Container from https://github.com/apple/container/releases

---

## Task 1: Apple Container Setup & Bridge Container Image

**Files:**
- Create: `container/Containerfile`
- Create: `container/ambrogioctl-wrapper.sh`

**Step 1: Create container directory and Containerfile**

Run: `mkdir -p container`

Create file `container/Containerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.6

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash curl nodejs npm git \
  && rm -rf /var/lib/apt/lists/*

# Install Codex CLI
RUN npm install -g @openai/codex

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && if [ -f /root/.local/bin/claude ]; then \
       cp /root/.local/bin/claude /usr/local/bin/claude && chmod +x /usr/local/bin/claude; \
     fi

# Copy ambrogioctl wrapper script
COPY ambrogioctl-wrapper.sh /usr/local/bin/ambrogioctl
RUN chmod +x /usr/local/bin/ambrogioctl

WORKDIR /data
```

Create file `container/ambrogioctl-wrapper.sh`:
```bash
#!/bin/bash
# Wrapper script that routes ambrogioctl calls to host via socket
# Expects AMBROGIO_SOCKET_PATH environment variable

SOCKET_PATH="${AMBROGIO_SOCKET_PATH:-/data/ambrogio-agent.sock}"

exec bun run /app/src/cli/ambrogioctl.ts "$@"
```

**Step 2: Build the container image**

Run: `cd container && container build -t ambrogio-bridge:latest .`
Expected: Image builds successfully

**Step 3: Commit**

```bash
git add container/
git commit -m "feat: add Apple container image for bridge execution"
```

---

## Task 2: Container Orchestrator Module

**Files:**
- Create: `src/runtime/container-orchestrator.ts`

**Step 1: Write the failing test**

Create file `test/container-orchestrator.test.ts`:
```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { ContainerOrchestrator, type RunCommand, type BuildRunCommandParams } from "../src/runtime/container-orchestrator";

describe("ContainerOrchestrator", () => {
  let orchestrator: ContainerOrchestrator;
  let mockLogger: ReturnType<typeof mock>;

  beforeEach(() => {
    mockLogger = mock(() => {});
    orchestrator = new ContainerOrchestrator({
      image: "ambrogio-bridge:latest",
      dataRoot: "/tmp/test-data",
      socketPath: "/tmp/test-agent.sock",
      logger: mockLogger as any,
    });
  });

  test("buildRunCommand generates correct container run command", () => {
    const params: BuildRunCommandParams = {
      taskId: "test-task-123",
      bridgeCommand: "codex",
      bridgeArgs: ["--model", "gpt-4o"],
    };
    const command: RunCommand = orchestrator.buildRunCommand(params);

    expect(command.command).toBe("container");
    expect(command.args).toContain("run");
    expect(command.args).toContain("--rm");
    expect(command.args).toContain("--name");
    expect(command.args).toContain("ambrogio-bridge-test-task-123");
    expect(command.args).toContain("--mount");
    expect(command.args).toContain("/tmp/test-data:/data:rw");
    expect(command.args).toContain("ambrogio-bridge:latest");
  });

  test("includes codex command in container args", () => {
    const command = orchestrator.buildRunCommand({
      taskId: "test-1",
      bridgeCommand: "codex",
      bridgeArgs: ["--model", "gpt-4o", "-"],
    });

    const idx = command.args.indexOf("ambrogio-bridge:latest");
    expect(command.args[idx + 1]).toBe("codex");
    expect(command.args[idx + 2]).toBe("--model");
    expect(command.args[idx + 3]).toBe("gpt-4o");
  });

  test("includes claude command in container args", () => {
    const command = orchestrator.buildRunCommand({
      taskId: "test-2",
      bridgeCommand: "claude",
      bridgeArgs: ["--print", "-"],
    });

    const idx = command.args.indexOf("ambrogio-bridge:latest");
    expect(command.args[idx + 1]).toBe("claude");
    expect(command.args[idx + 2]).toBe("--print");
  });

  test("includes environment variables", () => {
    const command = orchestrator.buildRunCommand({
      taskId: "task-1",
      bridgeCommand: "codex",
      bridgeArgs: [],
    });

    expect(command.env.DATA_ROOT).toBe("/data");
    expect(command.env.CODEX_HOME).toBe("/data/.codex");
    expect(command.env.AMBROGIO_SOCKET_PATH).toBe("/tmp/test-agent.sock");
    expect(command.env.TASK_ID).toBe("task-1");
  });

  test("generates unique container names per execution", () => {
    const cmd1 = orchestrator.buildRunCommand({ taskId: "task-1", bridgeCommand: "codex", bridgeArgs: [] });
    const cmd2 = orchestrator.buildRunCommand({ taskId: "task-1", bridgeCommand: "codex", bridgeArgs: [] });

    const nameIdx1 = cmd1.args.indexOf("--name");
    const nameIdx2 = cmd2.args.indexOf("--name");

    expect(cmd1.args[nameIdx1 + 1]).not.toBe(cmd2.args[nameIdx2 + 1]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/container-orchestrator.test.ts`
Expected: FAIL with "ContainerOrchestrator not found"

**Step 3: Write minimal implementation**

Create file `src/runtime/container-orchestrator.ts`:
```typescript
import type { Logger } from "../logging/audit";
import { randomUUID } from "node:crypto";

export type ContainerOrchestratorOptions = {
  image: string;
  dataRoot: string;
  socketPath: string;
  logger: Logger;
};

export type RunCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type BuildRunCommandParams = {
  taskId: string;
  bridgeCommand: "codex" | "claude";
  bridgeArgs: string[];
};

export class ContainerOrchestrator {
  private readonly image: string;
  private readonly dataRoot: string;
  private readonly socketPath: string;
  private readonly logger: Logger;

  constructor(options: ContainerOrchestratorOptions) {
    this.image = options.image;
    this.dataRoot = options.dataRoot;
    this.socketPath = options.socketPath;
    this.logger = options.logger;
  }

  buildRunCommand(params: BuildRunCommandParams): RunCommand {
    const uniqueId = randomUUID().slice(0, 8);
    const containerName = `ambrogio-bridge-${params.taskId}-${uniqueId}`;

    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--mount", `${this.dataRoot}:/data:rw`,
      "--workdir", "/data",
      "--env", "DATA_ROOT=/data",
      "--env", `CODEX_HOME=/data/.codex`,
      "--env", `CLAUDE_HOME=/data/.claude`,
      "--env", `AMBROGIO_SOCKET_PATH=${this.socketPath}`,
      "--env", `TASK_ID=${params.taskId}`,
      this.image,
      params.bridgeCommand,
      ...params.bridgeArgs,
    ];

    return {
      command: "container",
      args,
      env: {
        DATA_ROOT: "/data",
        CODEX_HOME: "/data/.codex",
        CLAUDE_HOME: "/data/.claude",
        AMBROGIO_SOCKET_PATH: this.socketPath,
        TASK_ID: params.taskId,
      },
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/container-orchestrator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/container-orchestrator.ts test/container-orchestrator.test.ts
git commit -m "feat: add container orchestrator module"
```

---

## Task 3: Container Execution with Lifecycle Management

**Files:**
- Modify: `src/runtime/container-orchestrator.ts`

**Step 1: Write failing test for execution**

Add to `test/container-orchestrator.test.ts`:
```typescript
test("execute runs container and returns result", async () => {
  const orchestrator = new ContainerOrchestrator({
    image: "ambrogio-bridge:latest",
    dataRoot: "/tmp/test-data",
    socketPath: "/tmp/test-agent.sock",
    logger: mockLogger as any,
  });

  const result = await orchestrator.execute({
    taskId: "test-exec-1",
    bridgeCommand: "codex",
    bridgeArgs: ["--dangerously-bypass-approvals-and-sandbox", "echo", "hello"],
    timeoutMs: 30000,
  });

  expect(result.exitCode).toBeDefined();
  expect(result.durationMs).toBeGreaterThan(0);
}, 35000);
```

**Step 2: Run test to verify it fails**

Run: `bun test test/container-orchestrator.test.ts`
Expected: FAIL with "execute method not defined"

**Step 3: Write implementation**

Update `src/runtime/container-orchestrator.ts` - add after the class definition:
```typescript
import { spawn, type ChildProcess } from "node:child_process";

export type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type ExecuteParams = {
  taskId: string;
  bridgeCommand: "codex" | "claude";
  bridgeArgs: string[];
  timeoutMs: number;
};

export class ContainerOrchestrator {
  // ... existing code ...

  async execute(params: ExecuteParams): Promise<ExecutionResult> {
    const { command, args, env } = this.buildRunCommand(params);
    const startedAt = Date.now();

    this.logger.info("container_execute_start", {
      taskId: params.taskId,
      bridgeCommand: params.bridgeCommand,
      command,
      args: args.join(" "),
    });

    return new Promise((resolve) => {
      const proc: ChildProcess = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }, params.timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAt;

        this.logger.info("container_execute_end", {
          taskId: params.taskId,
          bridgeCommand: params.bridgeCommand,
          exitCode: code,
          durationMs,
        });

        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs,
        });
      });

      proc.on("error", (error) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAt;

        this.logger.error("container_execute_error", {
          taskId: params.taskId,
          bridgeCommand: params.bridgeCommand,
          error: error.message,
          durationMs,
        });

        resolve({
          exitCode: -1,
          stdout: "",
          stderr: error.message,
          durationMs,
        });
      });
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/container-orchestrator.test.ts`
Expected: PASS (may skip if container not available)

**Step 5: Commit**

```bash
git add src/runtime/container-orchestrator.ts test/container-orchestrator.test.ts
git commit -m "feat: add container execution with lifecycle management"
```

---

## Task 4: Modify CodexBridge to Support Container Mode

**Files:**
- Modify: `src/model/codex-bridge.ts`

**Step 1: Read current implementation**

Run: `head -100 src/model/codex-bridge.ts`

**Step 2: Write failing test**

Create file `test/codex-bridge-container.test.ts`:
```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { CodexBridge } from "../src/model/codex-bridge";

describe("CodexBridge with Container Mode", () => {
  let mockLogger: ReturnType<typeof mock>;
  let mockOrchestrator: ReturnType<typeof mock>;

  beforeEach(() => {
    mockLogger = mock(() => {});
    mockOrchestrator = mock({
      execute: async () => ({
        exitCode: 0,
        stdout: "Container response from codex",
        stderr: "",
        durationMs: 1500,
      }),
    });
  });

  test("uses container when containerMode is enabled", async () => {
    const bridge = new CodexBridge(
      "codex",
      ["--model", "gpt-4o"],
      mockLogger as any,
      { cwd: "/data", env: {} },
      { orchestrator: mockOrchestrator as any, containerMode: true },
    );

    const request = {
      requestId: "req-container-1",
      message: "Test prompt",
    };

    const response = await bridge.respond(request);

    expect(mockOrchestrator.execute).toHaveBeenCalled();
    expect(response.text).toBe("Container response from codex");
  });

  test("getLastExecutionSummary returns container info", async () => {
    const bridge = new CodexBridge(
      "codex",
      [],
      mockLogger as any,
      { cwd: "/data", env: {} },
      { orchestrator: mockOrchestrator as any, containerMode: true },
    );

    await bridge.respond({
      requestId: "req-summary-1",
      message: "Test",
    });

    const summary = bridge.getLastExecutionSummary();
    expect(summary).not.toBeNull();
    expect(summary?.status).toBe("completed");
  });
});
```

**Step 3: Run test to verify it fails**

Run: `bun test test/codex-bridge-container.test.ts`
Expected: FAIL with "constructor does not accept 6 arguments"

**Step 4: Write implementation**

Update `src/model/codex-bridge.ts`:

First, add the import for ContainerOrchestrator and types:
```typescript
import { ContainerOrchestrator, type RunCommand, type ExecutionResult } from "../runtime/container-orchestrator";

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

type ContainerModeOptions = {
  orchestrator?: ContainerOrchestrator;
  containerMode?: boolean;
};
```

Modify the constructor to accept container options:
```typescript
export class CodexBridge implements ModelBridge {
  private readonly cwd?: string;
  private readonly rootDir: string;
  private readonly envOverrides?: Record<string, string>;
  private lastExecutionSummary: ModelExecutionSummary | null = null;
  private readonly containerOptions?: ContainerModeOptions;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    options: BridgeOptions = {},
    containerOptions?: ContainerModeOptions,
  ) {
    this.cwd = options.cwd;
    this.rootDir = resolve(options.cwd ?? process.cwd());
    this.envOverrides = options.env;
    this.containerOptions = containerOptions;
  }
```

Modify the respond method to check container mode:
```typescript
async respond(request: ModelRequest): Promise<ModelResponse> {
  // If container mode is enabled, run in container
  if (this.containerOptions?.containerMode && this.containerOptions?.orchestrator) {
    return this.respondViaContainer(request);
  }
  
  // Original direct execution logic
  return this.respondDirect(request);
}

private async respondViaContainer(request: ModelRequest): Promise<ModelResponse> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const requestId = request.requestId;
  const prompt = request.message;

  this.lastExecutionSummary = {
    requestId,
    command: "container",
    startedAt: startedAtIso,
    status: "running",
    promptLength: prompt.length,
  };

  this.logger.info("codex_container_exec_started", {
    ...correlationFields({ requestId }),
    promptLength: prompt.length,
  });

  const orchestrator = this.containerOptions!.orchestrator!;
  const result = await orchestrator.execute({
    taskId: requestId,
    bridgeCommand: "codex",
    bridgeArgs: [...this.args, "-"],
    timeoutMs: 120000,
  });

  const durationMs = Date.now() - startedAt;

  if (result.exitCode !== 0) {
    this.logger.error("codex_container_exec_failed", {
      ...correlationFields({ requestId }),
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    this.lastExecutionSummary = {
      requestId,
      command: "container",
      startedAt: startedAtIso,
      durationMs,
      status: "error",
      promptLength: prompt.length,
      stderrLength: result.stderr.length,
      stderrPreview: result.stderr.slice(0, 240),
      errorMessage: result.stderr,
    };
    return { text: "Model backend unavailable right now." };
  }

  this.logger.info("codex_container_exec_completed", {
    ...correlationFields({ requestId }),
    durationMs,
    outputLength: result.stdout.length,
  });

  this.lastExecutionSummary = {
    requestId,
    command: "container",
    startedAt: startedAtIso,
    durationMs,
    status: "completed",
    exitCode: result.exitCode,
    promptLength: prompt.length,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
    outputLength: result.stdout.length,
    stdoutPreview: result.stdout.slice(0, 240),
    stderrPreview: result.stderr.slice(0, 240),
    outputPreview: result.stdout.slice(0, 240),
  };

  return { text: result.stdout.trim() };
}

private async respondDirect(request: ModelRequest): Promise<ModelResponse> {
  // Move the existing respond logic here
  // (keep the existing implementation, just rename the method)
}
```

**Step 5: Run test to verify it passes**

Run: `bun test test/codex-bridge-container.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/model/codex-bridge.ts test/codex-bridge-container.test.ts
git commit -m "feat: add container mode to CodexBridge"
```

---

## Task 5: Modify ClaudeBridge to Support Container Mode

**Files:**
- Modify: `src/model/claude-bridge.ts`

**Step 1: Read current implementation**

Run: `head -100 src/model/claude-bridge.ts`

**Step 2: Apply same pattern as Task 4**

Follow the same structure:
- Add ContainerOrchestrator import and types
- Add containerOptions parameter to constructor
- Add respondViaContainer and respondDirect methods
- Call respondViaContainer when containerMode is enabled

**Step 3: Write test**

Create file `test/claude-bridge-container.test.ts`:
```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { ClaudeBridge } from "../src/model/claude-bridge";

describe("ClaudeBridge with Container Mode", () => {
  let mockLogger: ReturnType<typeof mock>;
  let mockOrchestrator: ReturnType<typeof mock>;

  beforeEach(() => {
    mockLogger = mock(() => {});
    mockOrchestrator = mock({
      execute: async () => ({
        exitCode: 0,
        stdout: "Container response from claude",
        stderr: "",
        durationMs: 1500,
      }),
    });
  });

  test("uses container when containerMode is enabled", async () => {
    const bridge = new ClaudeBridge(
      "claude",
      ["--print"],
      mockLogger as any,
      { cwd: "/data", env: {} },
      { orchestrator: mockOrchestrator as any, containerMode: true },
    );

    const response = await bridge.respond({
      requestId: "req-container-claude-1",
      message: "Test prompt",
    });

    expect(mockOrchestrator.execute).toHaveBeenCalled();
    expect(response.text).toBe("Container response from claude");
  });
});
```

**Step 4: Run test and fix implementation**

Run: `bun test test/claude-bridge-container.test.ts`
Fix any issues until tests pass

**Step 5: Commit**

```bash
git add src/model/claude-bridge.ts test/claude-bridge-container.test.ts
git commit -m "feat: add container mode to ClaudeBridge"
```

---

## Task 6: Update Bridge Factory to Pass Container Options

**Files:**
- Modify: `src/model/bridge-factory.ts`

**Step 1: Write failing test**

Create file `test/bridge-factory-container.test.ts`:
```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { createModelBridge, type BridgeConfig, type ContainerOptions } from "../src/model/bridge-factory";

describe("createModelBridge with container options", () => {
  let mockLogger: ReturnType<typeof mock>;
  let mockOrchestrator: ReturnType<typeof mock>;

  beforeEach(() => {
    mockLogger = mock(() => {});
    mockOrchestrator = mock({} as any);
  });

  test("creates CodexBridge with container options", () => {
    const config: BridgeConfig = {
      codexCommand: "codex",
      codexArgs: ["--model", "gpt-4o"],
      claudeCommand: "claude",
      claudeArgs: ["--print"],
    };

    const containerOptions: ContainerOptions = {
      orchestrator: mockOrchestrator as any,
      containerMode: true,
    };

    const bridge = createModelBridge("codex", config, mockLogger as any, containerOptions);
    expect(bridge).toBeDefined();
  });

  test("creates ClaudeBridge with container options", () => {
    const config: BridgeConfig = {
      codexCommand: "codex",
      codexArgs: [],
      claudeCommand: "claude",
      claudeArgs: [],
    };

    const containerOptions: ContainerOptions = {
      orchestrator: mockOrchestrator as any,
      containerMode: true,
    };

    const bridge = createModelBridge("claude", config, mockLogger as any, containerOptions);
    expect(bridge).toBeDefined();
  });

  test("creates bridge without container options (direct execution)", () => {
    const config: BridgeConfig = {
      codexCommand: "codex",
      codexArgs: [],
      claudeCommand: "claude",
      claudeArgs: [],
    };

    const bridge = createModelBridge("codex", config, mockLogger as any);
    expect(bridge).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/bridge-factory-container.test.ts`
Expected: FAIL with "createModelBridge does not accept 4 arguments"

**Step 3: Write implementation**

Update `src/model/bridge-factory.ts`:
```typescript
import type { Logger } from "../logging/audit";
import { CodexBridge } from "./codex-bridge";
import { ClaudeBridge } from "./claude-bridge";
import { ContainerOrchestrator } from "../runtime/container-orchestrator";
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

export type ContainerOptions = {
  orchestrator: ContainerOrchestrator;
  containerMode: boolean;
};

export function createModelBridge(
  backend: "codex" | "claude",
  config: BridgeConfig,
  logger: Logger,
  containerOptions?: ContainerOptions,
): ModelBridge {
  switch (backend) {
    case "codex":
      return new CodexBridge(
        config.codexCommand,
        config.codexArgs,
        logger,
        config.options,
        containerOptions,
      );
    case "claude":
      return new ClaudeBridge(
        config.claudeCommand,
        config.claudeArgs,
        logger,
        config.options,
        containerOptions,
      );
    default:
      const _exhaustive: never = backend;
      throw new Error(`Unknown backend: ${_exhaustive}`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/bridge-factory-container.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/model/bridge-factory.ts test/bridge-factory-container.test.ts
git commit -m "feat: update bridge factory to support container options"
```

---

## Task 7: Update Agent Service to Enable Container Mode

**Files:**
- Modify: `src/app/ambrogio-agent-service.ts`

**Step 1: Find where bridge is created**

Run: `grep -n "createModelBridge" src/app/ambrogio-agent-service.ts`

**Step 2: Update to pass container options**

Add import at top:
```typescript
import { ContainerOrchestrator } from "../runtime/container-orchestrator";
```

In the bridge creation section, add:
```typescript
const containerEnabled = process.env.AMBROGIO_CONTAINER_ENABLED === "true";

const containerOptions = containerEnabled
  ? {
      orchestrator: new ContainerOrchestrator({
        image: process.env.AMBROGIO_CONTAINER_IMAGE ?? "ambrogio-bridge:latest",
        dataRoot: process.env.DATA_ROOT ?? "/data",
        socketPath: process.env.AMBROGIO_SOCKET_PATH ?? "/data/ambrogio-agent.sock",
        logger,
      }),
      containerMode: true,
    }
  : undefined;

const bridge = createModelBridge(backend, config, logger, containerOptions);
```

**Step 3: Commit**

```bash
git add src/app/ambrogio-agent-service.ts
git commit -m "feat: enable container mode in agent service"
```

---

## Task 8: Socket Path Migration to /data

**Files:**
- Modify: Default socket path configuration

**Step 1: Check current socket path**

Run: `grep -r "ambrogio-agent.sock" src/ | head -10`

**Step 2: Update to /data/ambrogio-agent.sock**

Update default in relevant files (main.ts, job-rpc-server.ts, ambrogioctl.ts):
- Default: `/tmp/ambrogio-agent.sock` → `/data/ambrogio-agent.sock`

**Step 3: Commit**

```bash
git add src/
git commit -m "feat: migrate socket path to /data for container access"
```

---

## Task 9: Environment Variables

**Files:**
- Modify: `.env.example`

**Step 1: Add container-related variables**

Append to `.env.example`:
```bash
# Container mode - run bridges in ephemeral Apple containers
AMBROGIO_CONTAINER_ENABLED=true
AMBROGIO_CONTAINER_IMAGE=ambrogio-bridge:latest
# DATA_ROOT defaults to /data
# Socket path defaults to /data/ambrogio-agent.sock
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add container mode env vars to .env.example"
```

---

## Task 10: TypeScript TypeCheck

**Files:**
- Verify: All TypeScript

**Step 1: Run typecheck**

Run: `bun run typecheck`

**Step 2: Fix any errors**

**Step 3: Commit**

```bash
git add src/
git commit -m "fix: typecheck errors"
```

---

## Task 11: Run Test Suite

**Files:**
- Test: All tests

**Step 1: Run all tests**

Run: `bun test`

**Step 2: Commit**

```bash
git add test/
git commit -m "test: add container mode tests"
```

---

## Task 12: Integration Test (Manual)

**Files:**
- Test: Manual verification

**Step 1: Start container system**

Run: `container system start`

**Step 2: Build container image**

Run: `container build -t ambrogio-bridge:latest ./container`

**Step 3: Test container execution**

Run: `container run --rm --mount $(pwd)/data:/data:rw ambrogio-bridge:latest echo "hello"`

**Step 4: Enable container mode**

Add to `.env`:
```
AMBROGIO_CONTAINER_ENABLED=true
```

**Step 5: Run agent**

Run: `bun run dev`

**Step 6: Verify container execution in logs**

Check logs for "container_execute_start" messages

---

## Summary of Changes

| File | Change |
|------|--------|
| `container/Containerfile` | NEW - Bridge container image |
| `container/ambrogioctl-wrapper.sh` | NEW - Socket RPC wrapper |
| `src/runtime/container-orchestrator.ts` | NEW - Container lifecycle |
| `src/model/codex-bridge.ts` | MODIFY - Add container mode |
| `src/model/claude-bridge.ts` | MODIFY - Add container mode |
| `src/model/bridge-factory.ts` | MODIFY - Pass container options |
| `src/app/ambrogio-agent-service.ts` | MODIFY - Enable container mode |
| `.env.example` | MODIFY - Add container env vars |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AMBROGIO_CONTAINER_ENABLED` | `false` | Enable container mode |
| `AMBROGIO_CONTAINER_IMAGE` | `ambrogio-bridge:latest` | Container image |
| `DATA_ROOT` | `/data` | Shared workspace |
| `AMBROGIO_SOCKET_PATH` | `/data/ambrogio-agent.sock` | RPC socket |
