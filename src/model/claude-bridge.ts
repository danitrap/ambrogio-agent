import { resolve } from "node:path";
import type { Logger } from "../logging/audit";
import { correlationFields } from "../logging/correlation";
import type {
  ModelBridge,
  ModelExecutionSummary,
  ModelRequest,
  ModelResponse,
  ModelToolCallEvent,
} from "./types";

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
  duration_api_ms?: number;
  num_turns?: number;
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
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    webSearchRequests?: number;
    costUSD?: number;
  }>;
  session_id?: string;
  total_cost_usd?: number;
  stop_reason?: string | null;
};

type ClaudeAuditAction = {
  type: "web_search" | "web_fetch";
  detail: string;
};

export type ClaudeToolCallAction = {
  toolUseId?: string;
  toolName: string;
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

function compactDetail(value: string, max = 220): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) {
    return "no input";
  }
  if (typeof input === "string") {
    return compactDetail(input);
  }
  if (typeof input !== "object") {
    return compactDetail(String(input));
  }
  const record = input as Record<string, unknown>;
  const preferredKeys = ["file_path", "path", "query", "url", "command", "cmd", "skill", "args"];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  if (parts.length > 0) {
    return compactDetail(parts.join(" "));
  }
  return compactDetail(JSON.stringify(input));
}

export function extractClaudeToolCallActionsFromEvent(
  event: unknown,
): ClaudeToolCallAction[] {
  if (!event || typeof event !== "object") {
    return [];
  }
  const record = event as Record<string, unknown>;
  if (record.type !== "assistant") {
    return [];
  }
  const message = record.message;
  if (!message || typeof message !== "object") {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const actions: ClaudeToolCallAction[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const toolCall = item as Record<string, unknown>;
    if (toolCall.type !== "tool_use") {
      continue;
    }
    const toolName = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
    if (!toolName) {
      continue;
    }
    const toolUseId = typeof toolCall.id === "string" ? toolCall.id : undefined;
    actions.push({
      toolUseId,
      toolName,
      detail: summarizeToolInput(toolCall.input),
    });
  }
  return actions;
}

export function splitTopLevelJsonArrayObjects(input: string): {
  objects: string[];
  remaining: string;
} {
  const objects: string[] = [];
  if (input.length === 0) {
    return { objects, remaining: "" };
  }

  const firstBracket = input.indexOf("[");
  let index = firstBracket >= 0 ? firstBracket : 0;
  let insideArray = firstBracket < 0;
  let inString = false;
  let escaping = false;
  let depth = 0;
  let objectStart = -1;
  let lastConsumed = 0;

  for (; index < input.length; index += 1) {
    const char = input[index] ?? "";

    if (!insideArray) {
      if (char === "[") {
        insideArray = true;
        lastConsumed = index + 1;
      }
      continue;
    }

    if (objectStart === -1) {
      if (char === "{") {
        objectStart = index;
        depth = 1;
      } else if (char === "]") {
        lastConsumed = index + 1;
      } else if (char !== "," && char.trim().length > 0) {
        // Unexpected top-level token while streaming an array; keep tail for fallback parsing.
        return { objects, remaining: input.slice(index) };
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(input.slice(objectStart, index + 1));
        objectStart = -1;
        lastConsumed = index + 1;
      }
    }
  }

  if (objectStart !== -1) {
    const keepFrom = firstBracket >= 0 ? firstBracket : 0;
    return { objects, remaining: input.slice(keepFrom) };
  }
  return { objects, remaining: input.slice(lastConsumed) };
}

export function extractClaudeAuditActions(
  jsonResponse: ClaudeJsonResponse,
): ClaudeAuditAction[] {
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
      detail: `${searches} search${searches === 1 ? "" : "es"}`,
    });
  }

  if (fetches > 0) {
    actions.push({
      type: "web_fetch",
      detail: `${fetches} fetch${fetches === 1 ? "" : "es"}`,
    });
  }

  return actions;
}

export function extractClaudeExecutionDetails(
  jsonResponse: ClaudeJsonResponse,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  if (jsonResponse.num_turns !== undefined) {
    details.numTurns = jsonResponse.num_turns;
  }

  if (jsonResponse.duration_ms !== undefined) {
    details.durationMs = jsonResponse.duration_ms;
  }

  if (jsonResponse.duration_api_ms !== undefined) {
    details.durationApiMs = jsonResponse.duration_api_ms;
  }

  if (jsonResponse.total_cost_usd !== undefined) {
    details.totalCostUsd = jsonResponse.total_cost_usd;
  }

  if (jsonResponse.usage) {
    const usage = jsonResponse.usage;
    details.usage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    };

    if (usage.server_tool_use) {
      details.toolUse = {
        webSearches: usage.server_tool_use.web_search_requests ?? 0,
        webFetches: usage.server_tool_use.web_fetch_requests ?? 0,
      };
    }
  }

  if (jsonResponse.modelUsage) {
    const modelNames = Object.keys(jsonResponse.modelUsage);
    if (modelNames.length > 0) {
      details.models = modelNames;
      details.modelUsage = jsonResponse.modelUsage;
    }
  }

  return details;
}

async function readClaudeStdoutStream(params: {
  stream: ReadableStream;
  onEventObject?: (event: unknown) => Promise<void> | void;
}): Promise<{ stdout: string; realtimeParseFailed: boolean }> {
  const reader = params.stream.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  let pending = "";
  let realtimeParseFailed = false;

  const processBuffer = async (): Promise<void> => {
    const split = splitTopLevelJsonArrayObjects(pending);
    pending = split.remaining;
    for (const rawObject of split.objects) {
      try {
        const parsed = JSON.parse(rawObject) as unknown;
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

  return { stdout, realtimeParseFailed };
}

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
    this.rootDir = resolve(options.cwd ?? process.cwd());
    this.envOverrides = options.env;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const requestId = request.requestId;
    const prompt = buildPromptText(request);

    const hasDangerFlag = this.args.includes("--dangerously-skip-permissions");
    const hasVerboseFlag = this.args.includes("--verbose");
    const execArgs = [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--add-dir",
      this.cwd ?? this.rootDir,
      ...(hasDangerFlag ? this.args : ["--dangerously-skip-permissions", ...this.args]),
      ...(hasVerboseFlag ? [] : ["--verbose"]),
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
    this.logger.info("claude_exec_prompt", {
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
        this.logger.warn("claude_tool_call_event_emit_failed", {
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

    const stderrPromise = new Response(stderrStream).text();
    const stdoutPromise = readClaudeStdoutStream({
      stream: stdoutStream,
      onEventObject: async (streamEvent) => {
        const actions = extractClaudeToolCallActionsFromEvent(streamEvent);
        for (const action of actions) {
          await emitToolCallEvent(
            {
              backend: "claude",
              type: "claude_tool_call",
              toolName: action.toolName,
              detail: action.detail,
              phase: "realtime",
              source: "tool_use",
            },
            action.toolUseId,
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

      this.logger.info("claude_exec_streams", {
        ...correlationFields({ requestId }),
        command: execCommand,
        exitCode,
        stdout,
        stderr,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });

      let text = "";
      let jsonResponse: ClaudeJsonResponse | null = null;
      let parsedResponse: unknown = null;

      // Try parsing JSON response
      try {
        parsedResponse = JSON.parse(stdout);

        // Handle verbose mode: array of objects with last one being the result
        if (Array.isArray(parsedResponse)) {
          // Find the last object with type: "result"
          const resultObj = parsedResponse.findLast((item: any) => item?.type === "result");
          if (resultObj) {
            jsonResponse = resultObj as ClaudeJsonResponse;
          }
        } else {
          // Normal mode: single object
          jsonResponse = parsedResponse as ClaudeJsonResponse;
        }

        if (jsonResponse) {
          text = jsonResponse.result ?? "";

          // Log detailed execution info (similar to Codex stderr parsing)
          const executionDetails = extractClaudeExecutionDetails(jsonResponse);
          if (Object.keys(executionDetails).length > 0) {
            this.logger.info("claude_exec_details", {
              ...correlationFields({ requestId }),
              command: execCommand,
              exitCode,
              ...executionDetails,
            });
          }

          const auditActions = extractClaudeAuditActions(jsonResponse);
          if (auditActions.length > 0) {
            this.logger.info("claude_exec_audit", {
              ...correlationFields({ requestId }),
              command: execCommand,
              exitCode,
              auditActionCount: auditActions.length,
              auditActions,
            });
            for (const action of auditActions) {
              await emitToolCallEvent({
                backend: "claude",
                type: action.type,
                detail: action.detail,
                phase: "final_summary",
                source: "usage_summary",
              });
            }
          }

          if (Array.isArray(parsedResponse)) {
            for (const streamEvent of parsedResponse) {
              const actions = extractClaudeToolCallActionsFromEvent(streamEvent);
              for (const action of actions) {
                await emitToolCallEvent(
                  {
                    backend: "claude",
                    type: "claude_tool_call",
                    toolName: action.toolName,
                    detail: action.detail,
                    phase: "realtime",
                    source: "tool_use",
                  },
                  action.toolUseId,
                );
              }
            }
          }
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

      if (stdoutResult.realtimeParseFailed) {
        this.logger.warn("claude_realtime_tool_parse_failed", {
          ...correlationFields({ requestId }),
          command: execCommand,
        });
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
      const stdout = (await stdoutPromise).stdout.trim();
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

  getLastExecutionSummary(): ModelExecutionSummary | null {
    return this.lastExecutionSummary;
  }
}
