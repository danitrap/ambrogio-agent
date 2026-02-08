import type { Logger } from "../logging/audit";
import type { ModelBridge, ModelExecutionSummary, ModelRequest, ModelResponse } from "./types";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
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
    "- Wrap only your final answer inside <final>...</final> tags.\n" +
    "- Do not invent custom XML-like tags. Use only these runtime tags when needed: <response_mode>audio|text</response_mode> and <telegram_document>...</telegram_document>.";

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
      requestId,
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
        requestId,
        command: execCommand,
        exitCode,
        stdout,
        stderr,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });

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
          requestId,
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
          requestId,
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
        requestId,
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
        requestId,
        command: execCommand,
        stdout,
        stderr,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
      this.logger.error("exec_command_error", {
        requestId,
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
