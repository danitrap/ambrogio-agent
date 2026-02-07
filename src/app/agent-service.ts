import type { TelegramAllowlist } from "../auth/allowlist";
import type { Logger } from "../logging/audit";
import type { ModelBridge } from "../model/types";
import type { GitSnapshotManager } from "../snapshots/git";
import type { SkillDiscovery } from "../skills/discovery";
import { selectSkills } from "../skills/resolver";
import type { FsTools } from "../tools/fs-tools";

function stringifyResult(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

export type AgentDependencies = {
  allowlist: TelegramAllowlist;
  modelBridge: ModelBridge;
  skills: SkillDiscovery;
  fsTools: FsTools;
  snapshots: GitSnapshotManager;
  logger: Logger;
};

export class AgentService {
  private readonly historyByUser = new Map<number, Array<{ role: "user" | "assistant"; text: string }>>();

  constructor(private readonly deps: AgentDependencies) {}

  async handleMessage(userId: number, text: string): Promise<string> {
    if (!this.deps.allowlist.isAllowed(userId)) {
      this.deps.logger.warn("unauthorized_user", { userId });
      return "Unauthorized user.";
    }

    const availableSkills = await this.deps.skills.discover();
    const selected = selectSkills(text, availableSkills);
    const hydrated = await Promise.all(selected.map((skill) => this.deps.skills.hydrate(skill)));

    const history = this.historyByUser.get(userId) ?? [];
    const contextualMessage = formatContextualMessage(history, text);

    const modelResponse = await this.deps.modelBridge.respond({
      message: contextualMessage,
      skills: hydrated,
    });

    const operationLogs: string[] = [];
    for (const toolCall of modelResponse.toolCalls) {
      const result = await this.executeToolCall(toolCall.tool, toolCall.args, text);
      operationLogs.push(`${toolCall.tool}: ${stringifyResult(result)}`);
    }

    const responseText = operationLogs.length === 0
      ? (modelResponse.text || "Done.")
      : [modelResponse.text || "Completed tool operations.", "", ...operationLogs].join("\n");

    this.pushHistory(userId, "user", text);
    this.pushHistory(userId, "assistant", responseText);
    return responseText;
  }

  private async executeToolCall(tool: string, args: Record<string, unknown>, messageText: string): Promise<unknown> {
    switch (tool) {
      case "list_files": {
        const targetPath = typeof args.path === "string" ? args.path : ".";
        return this.deps.fsTools.listFiles(targetPath);
      }
      case "read_file": {
        const targetPath = typeof args.path === "string" ? args.path : "";
        if (!targetPath) {
          throw new Error("read_file requires path");
        }
        return this.deps.fsTools.readFile(targetPath);
      }
      case "search": {
        const query = typeof args.query === "string" ? args.query : "";
        if (!query) {
          throw new Error("search requires query");
        }
        const targetPath = typeof args.path === "string" ? args.path : ".";
        return this.deps.fsTools.search(query, targetPath);
      }
      case "write_file": {
        const targetPath = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        const expectedSha256 = typeof args.expected_sha256 === "string" ? args.expected_sha256 : undefined;

        if (!targetPath) {
          throw new Error("write_file requires path");
        }

        const snapshotCommit = this.deps.snapshots.createSnapshot(messageText);
        const writeResult = await this.deps.fsTools.writeFile(targetPath, content, expectedSha256);
        return {
          snapshotCommit,
          ...writeResult,
        };
      }
      default:
        throw new Error(`Unsupported tool: ${tool}`);
    }
  }

  private pushHistory(userId: number, role: "user" | "assistant", text: string): void {
    const history = this.historyByUser.get(userId) ?? [];
    history.push({ role, text });
    const maxEntries = 12;
    if (history.length > maxEntries) {
      history.splice(0, history.length - maxEntries);
    }
    this.historyByUser.set(userId, history);
  }

  clearConversation(userId: number): void {
    this.historyByUser.delete(userId);
  }
}

function formatContextualMessage(history: Array<{ role: "user" | "assistant"; text: string }>, text: string): string {
  if (history.length === 0) {
    return text;
  }

  const serializedHistory = history
    .slice(-8)
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`)
    .join("\n");

  return `Conversation context:\n${serializedHistory}\n\nCurrent user request:\n${text}`;
}
