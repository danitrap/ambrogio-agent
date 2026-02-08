import type { TelegramAllowlist } from "../auth/allowlist";
import type { Logger } from "../logging/audit";
import type { ModelBridge } from "../model/types";

type ConversationStore = {
  getConversation: (userId: number, limit?: number) => Array<{ role: "user" | "assistant"; text: string }>;
  appendConversationTurn: (userId: number, role: "user" | "assistant", text: string, maxEntries?: number) => void;
  clearConversation: (userId: number) => void;
  getConversationStats: (userId: number) => { entries: number; userTurns: number; assistantTurns: number; hasContext: boolean };
};

export type AmbrogioAgentDependencies = {
  allowlist: TelegramAllowlist;
  modelBridge: ModelBridge;
  logger: Logger;
  conversationStore?: ConversationStore;
};

export class AmbrogioAgentService {
  private readonly historyByUser = new Map<number, Array<{ role: "user" | "assistant"; text: string }>>();

  constructor(private readonly deps: AmbrogioAgentDependencies) {}

  async handleMessage(userId: number, text: string, requestId?: string, signal?: AbortSignal): Promise<string> {
    if (!this.deps.allowlist.isAllowed(userId)) {
      this.deps.logger.warn("unauthorized_user", { userId });
      return "Unauthorized user.";
    }

    const history = this.deps.conversationStore
      ? this.deps.conversationStore.getConversation(userId, 12)
      : this.historyByUser.get(userId) ?? [];
    if (this.deps.conversationStore) {
      this.deps.logger.debug("state_store_conversation_loaded", {
        userId,
        entries: history.length,
      });
    }
    const contextualMessage = formatContextualMessage(history, text);

    const modelResponse = await this.deps.modelBridge.respond({
      requestId,
      message: contextualMessage,
      signal,
    });
    const responseText = modelResponse.text || "Done.";

    if (this.deps.conversationStore) {
      this.deps.conversationStore.appendConversationTurn(userId, "user", text, 12);
      this.deps.conversationStore.appendConversationTurn(userId, "assistant", responseText, 12);
      this.deps.logger.debug("state_store_conversation_written", {
        userId,
        writtenTurns: 2,
      });
    } else {
      this.pushHistory(userId, "user", text);
      this.pushHistory(userId, "assistant", responseText);
    }
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
    if (this.deps.conversationStore) {
      this.deps.conversationStore.clearConversation(userId);
      this.deps.logger.debug("state_store_conversation_cleared", { userId });
      return;
    }
    this.historyByUser.delete(userId);
  }

  getConversationStats(userId: number): { entries: number; userTurns: number; assistantTurns: number; hasContext: boolean } {
    if (this.deps.conversationStore) {
      const stats = this.deps.conversationStore.getConversationStats(userId);
      this.deps.logger.debug("state_store_conversation_stats_loaded", {
        userId,
        entries: stats.entries,
      });
      return stats;
    }
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
