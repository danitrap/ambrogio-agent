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

class FakeSnapshots {
  public calls: string[] = [];

  createSnapshot(reason: string): string {
    this.calls.push(reason);
    return "abc123";
  }
}

class FakeFsTools {
  async listFiles(): Promise<unknown[]> {
    return [];
  }

  async readFile(path: string): Promise<{ path: string; content: string; sha256: string }> {
    return { path, content: "", sha256: "" };
  }

  async search(): Promise<unknown[]> {
    return [];
  }

  async writeFile(path: string, content: string): Promise<{ path: string; newSha256: string }> {
    return { path, newSha256: `${content.length}` };
  }
}

describe("AgentService", () => {
  test("takes snapshot before write_file operations", async () => {
    const model: ModelBridge = {
      respond: async () => ({
        text: "ok",
        toolCalls: [
          {
            tool: "write_file",
            args: {
              path: "grocery.md",
              content: "milk",
            },
          },
        ],
      }),
    };

    const snapshots = new FakeSnapshots();
    const service = new AgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      skills: new FakeSkills() as never,
      fsTools: new FakeFsTools() as never,
      snapshots: snapshots as never,
      logger: new Logger("error"),
    });

    const result = await service.handleMessage(1, "add milk");
    expect(snapshots.calls).toEqual(["add milk"]);
    expect(result).toContain("snapshotCommit");
  });

  test("denies unauthorized users", async () => {
    const model: ModelBridge = {
      respond: async () => ({ text: "ok", toolCalls: [] }),
    };

    const service = new AgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      skills: new FakeSkills() as never,
      fsTools: new FakeFsTools() as never,
      snapshots: new FakeSnapshots() as never,
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
        return { text: "ok", toolCalls: [] };
      },
    };

    const service = new AgentService({
      allowlist: new TelegramAllowlist(1),
      modelBridge: model,
      skills: new FakeSkills() as never,
      fsTools: new FakeFsTools() as never,
      snapshots: new FakeSnapshots() as never,
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
});
