import type { Logger } from "../logging/audit";
import type { ModelBridge, ModelRequest, ModelResponse } from "./types";

type AcpEnvelope = {
  text?: string;
  toolCalls?: Array<{ tool?: string; args?: Record<string, unknown> }>;
};

export class CodexAcpBridge implements ModelBridge {
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
  ) {}

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

    try {
      const parsed = JSON.parse(trimmed) as AcpEnvelope;
      return {
        text: parsed.text ?? "",
        toolCalls: (parsed.toolCalls ?? [])
          .filter((item) => typeof item.tool === "string")
          .map((item) => ({
            tool: item.tool as ModelResponse["toolCalls"][number]["tool"],
            args: item.args ?? {},
          })),
      };
    } catch {
      return {
        text: trimmed,
        toolCalls: [],
      };
    }
  }
}
