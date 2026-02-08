import { describe, expect, test } from "bun:test";
import { handleTelegramCommand } from "../src/runtime/command-handlers";

describe("handleTelegramCommand", () => {
  test("returns unauthorized reply for blocked users", async () => {
    const replies: string[] = [];
    const handled = await handleTelegramCommand({
      command: { name: "help", args: "" },
      update: { updateId: 1, userId: 99, chatId: 1 },
      isAllowed: () => false,
      sendCommandReply: async (text) => {
        replies.push(text);
      },
      getStatusReply: () => "",
      getLastLogReply: () => "",
      getMemoryReply: () => "",
      getSkillsReply: async () => "",
      getLastPrompt: () => undefined,
      setLastPrompt: () => undefined,
      clearConversation: () => undefined,
      executePrompt: async () => ({ reply: "", ok: true }),
      dispatchAssistantReply: async () => undefined,
      sendAudioFile: async () => "",
      runHeartbeatNow: async () => "",
    });

    expect(handled).toBe(true);
    expect(replies).toEqual(["Unauthorized user."]);
  });

  test("returns false for non-command payload", async () => {
    const handled = await handleTelegramCommand({
      command: null,
      update: { updateId: 1, userId: 1, chatId: 1 },
      isAllowed: () => true,
      sendCommandReply: async () => undefined,
      getStatusReply: () => "",
      getLastLogReply: () => "",
      getMemoryReply: () => "",
      getSkillsReply: async () => "",
      getLastPrompt: () => undefined,
      setLastPrompt: () => undefined,
      clearConversation: () => undefined,
      executePrompt: async () => ({ reply: "", ok: true }),
      dispatchAssistantReply: async () => undefined,
      sendAudioFile: async () => "",
      runHeartbeatNow: async () => "",
    });

    expect(handled).toBe(false);
  });

  test("handles heartbeat command and returns forced execution result", async () => {
    const replies: string[] = [];
    let called = false;
    const handled = await handleTelegramCommand({
      command: { name: "heartbeat", args: "" },
      update: { updateId: 1, userId: 1, chatId: 1 },
      isAllowed: () => true,
      sendCommandReply: async (text) => {
        replies.push(text);
      },
      getStatusReply: () => "",
      getLastLogReply: () => "",
      getMemoryReply: () => "",
      getSkillsReply: async () => "",
      getLastPrompt: () => undefined,
      setLastPrompt: () => undefined,
      clearConversation: () => undefined,
      executePrompt: async () => ({ reply: "", ok: true }),
      dispatchAssistantReply: async () => undefined,
      sendAudioFile: async () => "",
      runHeartbeatNow: async () => {
        called = true;
        return "Heartbeat completato: ok";
      },
    });

    expect(handled).toBe(true);
    expect(called).toBe(true);
    expect(replies).toEqual(["Heartbeat completato: ok"]);
  });

  test("heartbeat command replies when forced heartbeat is ok", async () => {
    const replies: string[] = [];
    const handled = await handleTelegramCommand({
      command: { name: "heartbeat", args: "" },
      update: { updateId: 1, userId: 1, chatId: 1 },
      isAllowed: () => true,
      sendCommandReply: async (text) => {
        replies.push(text);
      },
      getStatusReply: () => "",
      getLastLogReply: () => "",
      getMemoryReply: () => "",
      getSkillsReply: async () => "",
      getLastPrompt: () => undefined,
      setLastPrompt: () => undefined,
      clearConversation: () => undefined,
      executePrompt: async () => ({ reply: "", ok: true }),
      dispatchAssistantReply: async () => undefined,
      sendAudioFile: async () => "",
      runHeartbeatNow: async () => "Heartbeat completato: HEARTBEAT_OK (nessun alert).",
    });

    expect(handled).toBe(true);
    expect(replies).toEqual(["Heartbeat completato: HEARTBEAT_OK (nessun alert)."]);
  });
});
