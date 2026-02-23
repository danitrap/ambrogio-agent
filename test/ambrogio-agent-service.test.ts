import { describe, expect, test } from "bun:test";
import type { ModelBridge, ModelToolCallEvent } from "../src/model/types";
import { AmbrogioAgentService } from "../src/app/ambrogio-agent-service";
import { TelegramAllowlist } from "../src/auth/allowlist";
import { Logger } from "../src/logging/audit";

describe("AmbrogioAgentService", () => {
  test("denies unauthorized users", async () => {
    const model: ModelBridge = {
      respond: async () => ({ text: "ok" }),
    };

    const service = new AmbrogioAgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,

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

    const service = new AmbrogioAgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,

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

    const service = new AmbrogioAgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,

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

    const service = new AmbrogioAgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,

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

  test("injects personalization hints when relevant memories are available", async () => {
    const seenMessages: string[] = [];
    const model: ModelBridge = {
      respond: async (request) => {
        seenMessages.push(request.message);
        return { text: "ok" };
      },
    };

    const service = new AmbrogioAgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      logger: new Logger("error"),
      memoryStore: {
        getAllRuntimeKeys: () => [
          {
            key: "memory:preference:1",
            updatedAt: "2026-02-20T09:00:00.000Z",
            value: JSON.stringify({
              id: "mem-1",
              type: "preference",
              content: "Preferisce usare Bun per progetti TypeScript",
              confidence: 100,
              status: "active",
              tags: ["bun", "typescript"],
              context: "",
              updatedAt: "2026-02-20T09:00:00.000Z",
            }),
          },
        ],
      },
    });

    await service.handleMessage(1, "proponi setup typescript");

    expect(seenMessages).toHaveLength(1);
    expect(seenMessages[0]).toContain("Personalization hints:");
    expect(seenMessages[0]?.toLowerCase()).toContain("bun");
    expect(seenMessages[0]).toContain("Current user request:");
  });

  test("does not inject personalization hints when no valid memories exist", async () => {
    const seenMessages: string[] = [];
    const model: ModelBridge = {
      respond: async (request) => {
        seenMessages.push(request.message);
        return { text: "ok" };
      },
    };

    const service = new AmbrogioAgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      logger: new Logger("error"),
      memoryStore: {
        getAllRuntimeKeys: () => [],
      },
    });

    await service.handleMessage(1, "ciao");

    expect(seenMessages).toHaveLength(1);
    expect(seenMessages[0]).toBe("ciao");
  });

  test("forwards onToolCallEvent callback to model bridge", async () => {
    let seenEventCallback: ((event: ModelToolCallEvent) => Promise<void> | void) | undefined;
    const model: ModelBridge = {
      respond: async (request) => {
        seenEventCallback = request.onToolCallEvent;
        return { text: "ok" };
      },
    };

    const service = new AmbrogioAgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      logger: new Logger("error"),
    });

    const callback = () => {};
    await service.handleMessage(1, "ciao", "req-1", undefined, callback);

    expect(seenEventCallback).toBe(callback);
  });
});
