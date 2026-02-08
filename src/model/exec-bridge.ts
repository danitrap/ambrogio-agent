import type { Logger } from "../logging/audit";
import { correlationFields } from "../logging/correlation";
import type { ModelBridge, ModelExecutionSummary, ModelRequest, ModelResponse } from "./types";
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

function previewLogText(value: string, max = 240): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function buildPromptText(request: ModelRequest): string {
  const personaContract =
    "Assistant identity and tone:\n" +
    "- You are Ambrogio, personal assistant to Signor Daniele.\n" +
    "- Always address the user as Signor Daniele.\n" +
    "- Use a formal but warm and deferential tone.\n" +
    "- Be concise, practical, and action-oriented.\n";

  const responseContract =
    "Important response rules:\n" +
    "- Reply with the final user-facing answer only.\n" +
    "- Do not include planning/debug/internal reasoning.\n" +
    "- Use available Codex tools (especially shell/apply_patch) when useful, then report the concrete result.\n" +
    "- Keep the answer concise and actionable.\n" +
    "- For heartbeat requests, follow HEARTBEAT.md policy strictly: return exactly HEARTBEAT_OK when no action is needed; otherwise return compact JSON with action=checkin|alert and fields issue/impact/nextStep/todoItems.\n" +
    "- For runtime task management, prefer using the natural-scheduler skill and ambrogioctl; keep responses concise and avoid inventing background-task IDs.\n" +
    "- Wrap only your final answer inside <final>...</final> tags.\n" +
    "- Do not invent custom XML-like tags.\n" +
    "- To send the final answer as Telegram audio, put this at the beginning of the final answer: <response_mode>audio</response_mode>.\n" +
    "- If audio is not needed, you can use <response_mode>text</response_mode> or omit response_mode.\n" +
    "- To ask runtime to upload a file on Telegram, include one or more tags in the final answer: <telegram_document>/data/path/to/file.ext</telegram_document>.\n" +
    "- Use only existing files under /data, and keep user-facing text outside tags.";

  if (request.skills.length === 0) {
    return `${personaContract}\n${responseContract}\n\nUser request:\n${request.message}`;
  }

  const skillSection = request.skills
    .map((skill) => `# Skill: ${skill.name}\n${skill.instructions}`)
    .join("\n\n");

  return `${personaContract}\n${responseContract}\n\n${skillSection}\n\nUser request:\n${request.message}`;
}

function unwrapFinalTags(text: string): string {
  const trimmed = text.trim();
  const tagged = trimmed.match(/^<final>([\s\S]*?)<\/final>$/i);
  if (tagged && tagged[1]) {
    return tagged[1].trim();
  }
  return trimmed.replaceAll(/<\/?final>/gi, "").trim();
}

function compactDetail(value: string, max = 220): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

export function extractCodexAuditActions(stderr: string): CodexAuditAction[] {
  const actions: CodexAuditAction[] = [];
  const seen = new Set<string>();

  for (const match of stderr.matchAll(/🌐\s*Searched:\s*(.+)/g)) {
    const query = compactDetail(match[1] ?? "");
    if (!query) {
      continue;
    }
    const key = `web_search:${query}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    actions.push({ type: "web_search", detail: query });
  }

  for (const line of stderr.split("\n")) {
    const match = line.match(/^(.+)\s+in\s+(\S+)\s+(succeeded|exited|failed)\b.*$/);
    if (!match) {
      continue;
    }
    const command = (match[1] ?? "").trim();
    const cwd = (match[2] ?? "").trim();
    const status = (match[3] ?? "").trim();
    if (!command || !cwd || !status) {
      continue;
    }
    const detail = compactDetail(`${command} [cwd=${cwd}] [status=${status}]`);
    const key = `shell_exec:${detail}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    actions.push({ type: "shell_exec", detail });
  }

  return actions;
}

export class ExecBridge implements ModelBridge {
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

      const responseText = unwrapFinalTags(text);
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
      const stdout = (await stdoutPromise).trim();
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
