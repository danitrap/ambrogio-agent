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
    });

    expect(handled).toBe(false);
  });
});
