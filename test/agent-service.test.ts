import { describe, expect, test } from "bun:test";
import type { ModelBridge } from "../src/model/types";
import { AgentService } from "../src/app/agent-service";
import { TelegramAllowlist } from "../src/auth/allowlist";
import { Logger } from "../src/logging/audit";

class FakeSkills {
  async discover() {
    return [];
  }

  async hydrate() {
    throw new Error("hydrate should not be called");
  }
}

describe("AgentService", () => {
  test("denies unauthorized users", async () => {
    const model: ModelBridge = {
      respond: async () => ({ text: "ok" }),
    };

    const service = new AgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      skills: new FakeSkills() as never,
      logger: new Logger("error"),
    });

    const result = await service.handleMessage(2, "hello");
    expect(result).toBe("Unauthorized user.");
  });

  test("includes short conversation context on subsequent turns", async () => {
    const seenMessages: string[] = [];
    const model: ModelBridge = {
      respond: async (request) => {
        seenMessages.push(request.message);
        return { text: "ok" };
      },
    };

    const service = new AgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      skills: new FakeSkills() as never,
      logger: new Logger("error"),
    });

    await service.handleMessage(1, "primo messaggio");
    await service.handleMessage(1, "secondo messaggio");

    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[0]).toBe("primo messaggio");
    expect(seenMessages[1]).toContain("Conversation context:");
    expect(seenMessages[1]).toContain("User: primo messaggio");
    expect(seenMessages[1]).toContain("Assistant: ok");
    expect(seenMessages[1]).toContain("Current user request:");
    expect(seenMessages[1]).toContain("secondo messaggio");
  });

  test("clears conversation context for a user", async () => {
    const seenMessages: string[] = [];
    const model: ModelBridge = {
      respond: async (request) => {
        seenMessages.push(request.message);
        return { text: "ok" };
      },
    };

    const service = new AgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      skills: new FakeSkills() as never,
      logger: new Logger("error"),
    });

    await service.handleMessage(1, "ciao");
    await service.handleMessage(1, "come va?");
    service.clearConversation(1);
    await service.handleMessage(1, "nuova chat");

    expect(seenMessages[1]).toContain("Conversation context:");
    expect(seenMessages[2]).toBe("nuova chat");
  });

  test("reports conversation stats for a user", async () => {
    const model: ModelBridge = {
      respond: async () => ({ text: "ok" }),
    };

    const service = new AgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      skills: new FakeSkills() as never,
      logger: new Logger("error"),
    });

    await service.handleMessage(1, "ciao");
    await service.handleMessage(1, "come va?");

    expect(service.getConversationStats(1)).toEqual({
      entries: 4,
      userTurns: 2,
      assistantTurns: 2,
      hasContext: true,
    });
  });
});
