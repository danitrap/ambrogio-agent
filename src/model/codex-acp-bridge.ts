import type { Logger } from "../logging/audit";
import type { ModelBridge, ModelRequest, ModelResponse } from "./types";

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    message?: string;
    data?: unknown;
  };
};

const JSON_RPC_VERSION = "2.0";

function stripAnsi(value: string): string {
  return value.replaceAll(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function parseJsonFromLine(line: string): RpcMessage | null {
  const cleaned = stripAnsi(line).trim();
  if (!cleaned) {
    return null;
  }

  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace > 0) {
    candidates.push(cleaned.slice(firstBrace));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as RpcMessage;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return null;
}

function extractTextChunks(value: unknown, chunks: string[]): void {
  if (chunks.length >= 30) {
    return;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractTextChunks(item, chunks);
      if (chunks.length >= 30) {
        return;
      }
    }
    return;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (["text", "content", "message", "delta"].includes(key)) {
        extractTextChunks(item, chunks);
      } else if (key === "update" || key === "prompt" || key === "params") {
        extractTextChunks(item, chunks);
      }
      if (chunks.length >= 30) {
        return;
      }
    }
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    onLine(buffer);
  }
}

class RpcClient {
  private nextId = 1;
  private readonly waiters = new Map<string, (message: RpcMessage) => void>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly updateChunks: string[] = [];

  constructor(
    private readonly stdin: { write: (chunk: string) => unknown; end: () => unknown },
    stdout: ReadableStream<Uint8Array>,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {
    readLines(stdout, (line) => this.handleLine(line)).catch((error) => {
      this.logger.error("acp_stdout_read_failed", { error: String(error) });
    });
  }

  private handleLine(line: string): void {
    const message = parseJsonFromLine(line);
    if (!message) {
      return;
    }

    if (typeof message.id === "number" || typeof message.id === "string") {
      const key = String(message.id);
      const waiter = this.waiters.get(key);
      if (waiter) {
        const timeout = this.timeouts.get(key);
        if (timeout) {
          clearTimeout(timeout);
          this.timeouts.delete(key);
        }
        this.waiters.delete(key);
        waiter(message);
      }
      return;
    }

    if (message.method === "session/update") {
      extractTextChunks(message.params, this.updateChunks);
    }
  }

  getUpdatesText(): string {
    if (this.updateChunks.length === 0) {
      return "";
    }
    // ACP can stream token-sized deltas; joining with newlines creates broken output.
    return this.updateChunks.join("").replaceAll("\r", "").trim();
  }

  request(method: string, params: Record<string, unknown>): Promise<RpcMessage> {
    const id = this.nextId;
    this.nextId += 1;

    const payload = JSON.stringify({
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      params,
    });

    return new Promise<RpcMessage>((resolve, reject) => {
      const key = String(id);
      const timeout = setTimeout(() => {
        this.waiters.delete(key);
        this.timeouts.delete(key);
        reject(new Error(`RPC timeout for method ${method}`));
      }, this.timeoutMs);

      this.waiters.set(key, resolve);
      this.timeouts.set(key, timeout);

      try {
        this.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.waiters.delete(key);
        this.timeouts.delete(key);
        reject(error);
      }
    });
  }

  closeStdin(): void {
    try {
      this.stdin.end();
    } catch {
      // Ignore close errors.
    }
  }
}

function formatRpcError(response: RpcMessage): string {
  const message = response.error?.message ?? "Unknown RPC error";
  const data = response.error?.data;
  if (data === undefined || data === null) {
    return message;
  }
  return `${message}: ${typeof data === "string" ? data : JSON.stringify(data)}`;
}

function buildPromptText(request: ModelRequest): string {
  if (request.skills.length === 0) {
    return request.message;
  }

  const skillSection = request.skills
    .map((skill) => `# Skill: ${skill.name}\n${skill.instructions}`)
    .join("\n\n");

  return `${skillSection}\n\nUser request:\n${request.message}`;
}

export class CodexAcpBridge implements ModelBridge {
  private readonly cwd?: string;
  private readonly envOverrides?: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    options: BridgeOptions = {},
  ) {
    this.cwd = options.cwd;
    this.envOverrides = options.env;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const process = Bun.spawn([this.command, ...this.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cwd,
      env: {
        ...Bun.env,
        ...(this.envOverrides ?? {}),
        RUST_LOG: Bun.env.RUST_LOG ?? "error",
      },
    });

    const stdinSink = process.stdin;
    const stdoutStream = process.stdout;
    const stderrStream = process.stderr;
    if (!stdinSink || typeof stdinSink === "number" || !(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
      this.logger.error("acp_pipe_setup_failed", { command: this.command });
      return {
        text: "Model backend unavailable right now.",
        toolCalls: [],
      };
    }

    const stderrPromise = new Response(stderrStream).text();
    const rpc = new RpcClient(stdinSink, stdoutStream, this.timeoutMs, this.logger);

    try {
      const initialize = await rpc.request("initialize", {
        protocolVersion: "v1",
        clientName: "telegram-wrapper",
        capabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
        },
      });

      if (initialize.error) {
        return { text: `ACP initialize failed: ${formatRpcError(initialize)}`, toolCalls: [] };
      }

      const authMethodsRaw = initialize.result?.authMethods;
      const authMethods = Array.isArray(authMethodsRaw)
        ? authMethodsRaw
            .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined))
            .filter((id): id is string => typeof id === "string")
        : [];

      if (authMethods.length > 0) {
        const preferredMethod = Bun.env.OPENAI_API_KEY ? "apikey" : "chatgpt";
        const methodToUse = authMethods.includes(preferredMethod) ? preferredMethod : authMethods[0]!;
        const authResponse = await rpc.request("authenticate", { methodId: methodToUse });
        if (authResponse.error) {
          return {
            text: `ACP authentication failed (${methodToUse}): ${formatRpcError(authResponse)}`,
            toolCalls: [],
          };
        }
      }

      const newSession = await rpc.request("session/new", {
        cwd: this.cwd ?? ".",
        mcpServers: [],
      });

      if (newSession.error) {
        return { text: `ACP session creation failed: ${formatRpcError(newSession)}`, toolCalls: [] };
      }

      const sessionId =
        (newSession.result?.sessionId as string | undefined) ??
        (newSession.result?.session_id as string | undefined);

      if (!sessionId) {
        return {
          text: "ACP session creation failed: missing session ID in response.",
          toolCalls: [],
        };
      }

      const promptResponse = await rpc.request("session/prompt", {
        sessionId,
        prompt: [
          {
            type: "text",
            text: buildPromptText(request),
          },
        ],
      });

      if (promptResponse.error) {
        return { text: `ACP prompt failed: ${formatRpcError(promptResponse)}`, toolCalls: [] };
      }

      const textFromUpdates = rpc.getUpdatesText();
      return {
        text: textFromUpdates || "Done.",
        toolCalls: [],
      };
    } catch (error) {
      const stderr = (await stderrPromise).trim();
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("acp_command_failed", {
        command: this.command,
        message,
        stderr,
      });
      return {
        text: "Model backend unavailable right now.",
        toolCalls: [],
      };
    } finally {
      rpc.closeStdin();
      const exitCode = await process.exited;
      if (exitCode !== 0) {
        const stderr = (await stderrPromise).trim();
        this.logger.error("acp_process_exit", {
          command: this.command,
          exitCode,
          stderr,
        });
      }
    }
  }
}
