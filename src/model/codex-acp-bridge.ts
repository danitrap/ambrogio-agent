import type { Logger } from "../logging/audit";
import type { ModelBridge, ModelRequest, ModelResponse } from "./types";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

function buildPromptText(request: ModelRequest): string {
  const responseContract =
    "Important response rules:\n" +
    "- Reply with the final user-facing answer only.\n" +
    "- Do not include planning/debug/internal reasoning.\n" +
    "- Use available Codex tools (especially shell/apply_patch) when useful, then report the concrete result.\n" +
    "- Keep the answer concise and actionable.\n" +
    "- Wrap only your final answer inside <final>...</final> tags.";

  if (request.skills.length === 0) {
    return `${responseContract}\n\nUser request:\n${request.message}`;
  }

  const skillSection = request.skills
    .map((skill) => `# Skill: ${skill.name}\n${skill.instructions}`)
    .join("\n\n");

  return `${responseContract}\n\n${skillSection}\n\nUser request:\n${request.message}`;
}

function unwrapFinalTags(text: string): string {
  const trimmed = text.trim();
  const tagged = trimmed.match(/^<final>([\s\S]*?)<\/final>$/i);
  if (tagged && tagged[1]) {
    return tagged[1].trim();
  }
  return trimmed.replaceAll(/<\/?final>/gi, "").trim();
}

export class CodexAcpBridge implements ModelBridge {
  private readonly cwd?: string;
  private readonly rootDir: string;
  private readonly envOverrides?: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    options: BridgeOptions = {},
  ) {
    this.cwd = options.cwd;
    this.rootDir = resolve(options.cwd ?? process.cwd());
    this.envOverrides = options.env;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private resolveExecCommand(): string {
    return this.command === "codex-acp" ? "codex" : this.command;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
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

    const process = Bun.spawn([this.resolveExecCommand(), ...execArgs], {
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

    const stdinSink = process.stdin;
    const stdoutStream = process.stdout;
    const stderrStream = process.stderr;
    if (!stdinSink || typeof stdinSink === "number" || !(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
      this.logger.error("exec_pipe_setup_failed", { command: this.resolveExecCommand() });
      return { text: "Model backend unavailable right now.", toolCalls: [] };
    }

    const stderrPromise = new Response(stderrStream).text();
    const stdoutPromise = new Response(stdoutStream).text();

    try {
      stdinSink.write(prompt);
      stdinSink.end();
      const exitCode = await process.exited;
      const stderr = (await stderrPromise).trim();
      const stdout = (await stdoutPromise).trim();

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
          command: this.resolveExecCommand(),
          exitCode,
          stderr,
        });
      }

      if (!text && stdout) {
        text = stdout;
      }

      if (!text) {
        return { text: "Model backend unavailable right now.", toolCalls: [] };
      }

      return { text: unwrapFinalTags(text), toolCalls: [] };
    } catch (error) {
      const stderr = (await stderrPromise).trim();
      this.logger.error("exec_command_error", {
        command: this.resolveExecCommand(),
        message: error instanceof Error ? error.message : String(error),
        stderr,
      });
      return { text: "Model backend unavailable right now.", toolCalls: [] };
    }
  }
}
