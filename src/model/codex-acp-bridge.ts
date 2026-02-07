import type { Logger } from "../logging/audit";
import type { ModelBridge, ModelRequest, ModelResponse } from "./types";

type AcpEnvelope = {
  text?: string;
  toolCalls?: Array<{ tool?: string; args?: Record<string, unknown> }>;
};

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

function stripAnsi(value: string): string {
  return value.replaceAll(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function extractJsonEnvelope(stdout: string): AcpEnvelope | null {
  const lines = stdout
    .split("\n")
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const candidates = [line];
    const firstBrace = line.indexOf("{");
    if (firstBrace > 0) {
      candidates.push(line.slice(firstBrace));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed && typeof parsed === "object") {
          return parsed as AcpEnvelope;
        }
      } catch {
        // Ignore non-JSON lines and keep scanning.
      }
    }
  }

  return null;
}

export class CodexAcpBridge implements ModelBridge {
  private readonly cwd?: string;
  private readonly envOverrides?: Record<string, string>;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    options: BridgeOptions = {},
  ) {
    this.cwd = options.cwd;
    this.envOverrides = options.env;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const payload = JSON.stringify({
      type: "respond",
      request: {
        message: request.message,
        skills: request.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
        })),
        tools: ["list_files", "read_file", "write_file", "search"],
      },
    });

    const process = Bun.spawn([this.command, ...this.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cwd,
      env: {
        ...Bun.env,
        ...(this.envOverrides ?? {}),
      },
    });

    process.stdin.write(`${payload}\n`);
    process.stdin.end();

    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    const exitCode = await process.exited;
    if (exitCode !== 0) {
      this.logger.error("acp_command_failed", { command: this.command, exitCode, stderr: stderr.trim() });
      return {
        text: "Model backend unavailable right now.",
        toolCalls: [],
      };
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return { text: "No response from model backend.", toolCalls: [] };
    }

    const parsed = extractJsonEnvelope(trimmed);
    if (!parsed) {
      this.logger.error("acp_invalid_stdout", {
        command: this.command,
        stdout: trimmed,
        stderr: stderr.trim(),
      });
      return {
        text: "Model backend returned an invalid response.",
        toolCalls: [],
      };
    }

    return {
      text: parsed.text ?? "",
      toolCalls: (parsed.toolCalls ?? [])
        .filter((item) => typeof item.tool === "string")
        .map((item) => ({
          tool: item.tool as ModelResponse["toolCalls"][number]["tool"],
          args: item.args ?? {},
        })),
    };
  }
}
