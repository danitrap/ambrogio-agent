import type { TelegramAllowlist } from "../auth/allowlist";
import type { Logger } from "../logging/audit";
import type { ModelBridge } from "../model/types";
import type { SkillDiscovery } from "../skills/discovery";

export type AgentDependencies = {
  allowlist: TelegramAllowlist;
  modelBridge: ModelBridge;
  skills: SkillDiscovery;
  logger: Logger;
};

export class AgentService {
  private readonly historyByUser = new Map<number, Array<{ role: "user" | "assistant"; text: string }>>();

  constructor(private readonly deps: AgentDependencies) {}

  async handleMessage(userId: number, text: string, requestId?: string, signal?: AbortSignal): Promise<string> {
    if (!this.deps.allowlist.isAllowed(userId)) {
      this.deps.logger.warn("unauthorized_user", { userId });
      return "Unauthorized user.";
    }

    const history = this.historyByUser.get(userId) ?? [];
    const contextualMessage = formatContextualMessage(history, text);

    const modelResponse = await this.deps.modelBridge.respond({
      requestId,
      message: contextualMessage,
      skills: [],
      signal,
    });
    const responseText = modelResponse.text || "Done.";

    this.pushHistory(userId, "user", text);
    this.pushHistory(userId, "assistant", responseText);
    return responseText;
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

  getConversationStats(userId: number): { entries: number; userTurns: number; assistantTurns: number; hasContext: boolean } {
    const history = this.historyByUser.get(userId) ?? [];
    const userTurns = history.filter((entry) => entry.role === "user").length;
    const assistantTurns = history.length - userTurns;
    return {
      entries: history.length,
      userTurns,
      assistantTurns,
      hasContext: history.length > 0,
    };
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
