import type { Logger } from "../logging/audit";
import { correlationFields } from "../logging/correlation";
import type { ModelBridge, ModelExecutionSummary, ModelRequest, ModelResponse, ModelToolCallEvent } from "./types";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

type CodexAuditAction = {
  type: "shell_exec" | "web_search";
  detail: string;
};

type CodexToolCallAction = {
  toolCallId?: string;
  toolName: string;
  detail: string;
};

type CodexTurnCompletedEvent = {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
};

function previewLogText(value: string, max = 240): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function buildPromptText(request: ModelRequest): string {
  // System prompt is now loaded from /data/AGENTS.md via CODEX_HOME
  // No need to duplicate instructions here
  return request.message;
}

function compactDetail(value: string, max = 220): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

export function splitCodexJsonLines(input: string): {
  lines: string[];
  remaining: string;
} {
  if (input.length === 0) {
    return { lines: [], remaining: "" };
  }
  const normalized = input.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n");
  const remaining = parts.pop() ?? "";
  const lines = parts.map((line) => line.trim()).filter((line) => line.length > 0);
  return { lines, remaining };
}

function summarizeCodexToolDetail(item: Record<string, unknown>): string {
  const command = typeof item.command === "string" ? item.command.trim() : "";
  if (command) {
    return compactDetail(command);
  }
  const query = typeof item.query === "string" ? item.query.trim() : "";
  if (query) {
    return compactDetail(`query=${query}`);
  }
  const action = item.action;
  if (action && typeof action === "object") {
    const actionQuery = typeof (action as { query?: unknown }).query === "string"
      ? ((action as { query?: string }).query ?? "").trim()
      : "";
    if (actionQuery) {
      return compactDetail(`query=${actionQuery}`);
    }
  }
  return "no input";
}

export function extractCodexToolCallActionsFromEvent(event: unknown): CodexToolCallAction[] {
  if (!event || typeof event !== "object") {
    return [];
  }
  const record = event as Record<string, unknown>;
  const item = record.item;
  if (!item || typeof item !== "object") {
    return [];
  }

  const itemRecord = item as Record<string, unknown>;
  const itemType = typeof itemRecord.type === "string" ? itemRecord.type.trim() : "";
  const itemId = typeof itemRecord.id === "string" ? itemRecord.id : undefined;
  if (itemType === "command_execution") {
    return [{
      toolCallId: itemId,
      toolName: "Shell",
      detail: summarizeCodexToolDetail(itemRecord),
    }];
  }
  if (itemType === "web_search") {
    return [{
      toolCallId: itemId,
      toolName: "WebSearch",
      detail: summarizeCodexToolDetail(itemRecord),
    }];
  }
  return [];
}

export function extractLastCodexAssistantText(events: unknown[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object") {
      continue;
    }
    const item = (event as { item?: unknown }).item;
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type !== "agent_message") {
      continue;
    }
    const text = typeof itemRecord.text === "string" ? itemRecord.text.trim() : "";
    if (text) {
      return text;
    }
  }
  return "";
}

export function extractCodexExecutionDetails(
  event: CodexTurnCompletedEvent,
): Record<string, unknown> {
  const usage = event.usage;
  if (!usage) {
    return {};
  }

  return {
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cached_input_tokens ?? 0,
    },
  };
}

export function extractCodexAuditActionFromLine(line: string): CodexAuditAction | null {
  const searchMatch = line.match(/🌐\s*Searched:\s*(.+)/);
  if (searchMatch) {
    const query = compactDetail(searchMatch[1] ?? "");
    if (query) {
      return { type: "web_search", detail: query };
    }
  }

  const shellMatch = line.match(/^(.+)\s+in\s+(\S+)\s+(succeeded|exited|failed)\b.*$/);
  if (!shellMatch) {
    return null;
  }
  const command = (shellMatch[1] ?? "").trim();
  const cwd = (shellMatch[2] ?? "").trim();
  const status = (shellMatch[3] ?? "").trim();
  if (!command || !cwd || !status) {
    return null;
  }
  return {
    type: "shell_exec",
    detail: compactDetail(`${command} [cwd=${cwd}] [status=${status}]`),
  };
}

export function extractCodexAuditActions(stderr: string): CodexAuditAction[] {
  const actions: CodexAuditAction[] = [];
  const seen = new Set<string>();

  for (const line of stderr.split("\n")) {
    const action = extractCodexAuditActionFromLine(line);
    if (!action) {
      continue;
    }
    const key = `${action.type}:${action.detail}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    actions.push(action);
  }

  return actions;
}

async function readCodexStderrStream(params: {
  stream: ReadableStream;
  onAction?: (action: CodexAuditAction) => Promise<void> | void;
}): Promise<string> {
  const reader = params.stream.getReader();
  const decoder = new TextDecoder();
  const seen = new Set<string>();
  let text = "";
  let pending = "";

  const flushLine = async (line: string): Promise<void> => {
    const action = extractCodexAuditActionFromLine(line);
    if (!action) {
      return;
    }
    const key = `${action.type}:${action.detail}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    await params.onAction?.(action);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        await flushLine(line);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      text += tail;
      pending += tail;
    }
    if (pending.length > 0) {
      await flushLine(pending);
    }
  } finally {
    reader.releaseLock();
  }

  return text;
}

async function readCodexStdoutStream(params: {
  stream: ReadableStream;
  onEventObject?: (event: unknown) => Promise<void> | void;
}): Promise<{ stdout: string; realtimeParseFailed: boolean; events: unknown[] }> {
  const reader = params.stream.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  let pending = "";
  let realtimeParseFailed = false;
  const events: unknown[] = [];

  const processBuffer = async (): Promise<void> => {
    const split = splitCodexJsonLines(pending);
    pending = split.remaining;
    for (const rawLine of split.lines) {
      try {
        const parsed = JSON.parse(rawLine) as unknown;
        events.push(parsed);
        await params.onEventObject?.(parsed);
      } catch {
        realtimeParseFailed = true;
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      stdout += chunk;
      pending += chunk;
      await processBuffer();
    }
    const tail = decoder.decode();
    if (tail) {
      stdout += tail;
      pending += tail;
      await processBuffer();
    }
  } finally {
    reader.releaseLock();
  }

  const tail = pending.trim();
  if (tail.length > 0) {
    try {
      const parsed = JSON.parse(tail) as unknown;
      events.push(parsed);
      await params.onEventObject?.(parsed);
    } catch {
      realtimeParseFailed = true;
    }
  }

  return { stdout, realtimeParseFailed, events };
}

export class CodexBridge implements ModelBridge {
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
    this.rootDir = resolve(options.cwd ?? process.cwd());
    this.envOverrides = options.env;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const requestId = request.requestId;
    const prompt = buildPromptText(request);
    const outputPath = `/tmp/codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;

    const hasDangerFlag = this.args.includes("--dangerously-bypass-approvals-and-sandbox");
    const execArgs = [
      "exec",
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      outputPath,
      "--cd",
      this.cwd ?? this.rootDir,
      ...(hasDangerFlag ? this.args : ["--dangerously-bypass-approvals-and-sandbox", ...this.args]),
      "-",
    ];
    const execCommand = this.command;
    this.lastExecutionSummary = {
      requestId,
      command: execCommand,
      startedAt: startedAtIso,
      status: "running",
      promptLength: prompt.length,
    };
    this.logger.info("codex_exec_started", {
      ...correlationFields({ requestId }),
      command: execCommand,
      args: execArgs,
      cwd: this.cwd ?? this.rootDir,
      promptLength: prompt.length,
      outputPath,
    });
    this.logger.info("codex_exec_prompt", {
      ...correlationFields({ requestId }),
      command: execCommand,
      promptLength: prompt.length,
      prompt,
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

    const stderrPromise = readCodexStderrStream({
      stream: stderrStream,
      onAction: async (action) => {
        const event: ModelToolCallEvent = {
          backend: "codex",
          type: action.type,
          detail: action.detail,
          phase: "realtime",
        };
        try {
          await request.onToolCallEvent?.(event);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("codex_tool_call_event_emit_failed", {
            ...correlationFields({ requestId }),
            command: execCommand,
            type: event.type,
            phase: event.phase,
            message,
          });
        }
      },
    });
    const emittedToolUseIds = new Set<string>();
    let lastToolCallKey: string | null = null;
    const emitToolCallEvent = async (event: ModelToolCallEvent, toolUseId?: string): Promise<void> => {
      const dedupKey = `${event.type}:${event.toolName ?? ""}:${event.detail}`;
      if (lastToolCallKey === dedupKey) {
        return;
      }
      if (toolUseId && emittedToolUseIds.has(toolUseId)) {
        return;
      }
      if (toolUseId) {
        emittedToolUseIds.add(toolUseId);
      }
      lastToolCallKey = dedupKey;
      try {
        await request.onToolCallEvent?.(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("codex_tool_call_event_emit_failed", {
          ...correlationFields({ requestId }),
          command: execCommand,
          type: event.type,
          toolName: event.toolName,
          phase: event.phase,
          source: event.source,
          message,
        });
      }
    };

    const stdoutPromise = readCodexStdoutStream({
      stream: stdoutStream,
      onEventObject: async (streamEvent) => {
        const actions = extractCodexToolCallActionsFromEvent(streamEvent);
        for (const action of actions) {
          await emitToolCallEvent(
            {
              backend: "codex",
              type: "tool_call",
              toolName: action.toolName,
              detail: action.detail,
              phase: "realtime",
              source: "tool_use",
            },
            action.toolCallId,
          );
        }
      },
    });

    try {
      stdinSink.write(prompt);
      stdinSink.end();
      const exitCode = await process.exited;
      const stderr = (await stderrPromise).trim();
      const stdoutResult = await stdoutPromise;
      const stdout = stdoutResult.stdout.trim();

      this.logger.info("codex_exec_streams", {
        ...correlationFields({ requestId }),
        command: execCommand,
        exitCode,
        stdout,
        stderr,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
      const auditActions = extractCodexAuditActions(stderr);
      if (auditActions.length > 0) {
        this.logger.info("codex_exec_audit", {
          ...correlationFields({ requestId }),
          command: execCommand,
          exitCode,
          auditActionCount: auditActions.length,
          auditActions: auditActions.slice(0, 20),
        });
      }

      const turnCompletedEvent = stdoutResult.events.findLast((item) => {
        if (!item || typeof item !== "object") {
          return false;
        }
        return (item as { type?: string }).type === "turn.completed";
      }) as CodexTurnCompletedEvent | undefined;
      if (turnCompletedEvent) {
        const executionDetails = extractCodexExecutionDetails(turnCompletedEvent);
        if (Object.keys(executionDetails).length > 0) {
          this.logger.info("codex_exec_details", {
            ...correlationFields({ requestId }),
            command: execCommand,
            exitCode,
            ...executionDetails,
          });
        }
      }

      let text = "";
      try {
        text = (await readFile(outputPath, "utf8")).trim();
      } catch {
        text = "";
      } finally {
        try {
          await unlink(outputPath);
        } catch {
          // Ignore cleanup issues.
        }
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
        text = extractLastCodexAssistantText(stdoutResult.events);
      }

      if (!text && stdout) {
        text = stdout;
      }

      if (!text) {
        const durationMs = Date.now() - startedAt;
        this.logger.warn("codex_exec_empty_output", {
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
      this.logger.info("codex_exec_completed", {
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
      const stdout = (await stdoutPromise).stdout.trim();
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("codex_exec_streams_error", {
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

  getLastExecutionSummary(): ModelExecutionSummary | null {
    return this.lastExecutionSummary;
  }
}
