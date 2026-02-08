import { describe, expect, test } from "bun:test";
import { handleTelegramCommand } from "../src/runtime/command-handlers";

function buildParams(overrides: Partial<Parameters<typeof handleTelegramCommand>[0]> = {}): Parameters<typeof handleTelegramCommand>[0] {
  return {
    command: { name: "help", args: "" },
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
    clearRuntimeState: async () => undefined,
    executePrompt: async () => ({ reply: "", ok: true }),
    dispatchAssistantReply: async () => undefined,
    sendAudioFile: async () => "",
    runHeartbeatNow: async () => "",
    ...overrides,
  };
}

describe("handleTelegramCommand", () => {
  test("returns unauthorized reply for blocked users", async () => {
    const replies: string[] = [];
    const handled = await handleTelegramCommand(buildParams({
      command: { name: "help", args: "" },
      update: { updateId: 1, userId: 99, chatId: 1 },
      isAllowed: () => false,
      sendCommandReply: async (text) => {
        replies.push(text);
      },
    }));

    expect(handled).toBe(true);
    expect(replies).toEqual(["Unauthorized user."]);
  });

  test("returns false for non-command payload", async () => {
    const handled = await handleTelegramCommand(buildParams({ command: null }));
    expect(handled).toBe(false);
  });

  test("handles heartbeat command and returns forced execution result", async () => {
    const replies: string[] = [];
    let called = false;
    const handled = await handleTelegramCommand(buildParams({
      command: { name: "heartbeat", args: "" },
      sendCommandReply: async (text) => {
        replies.push(text);
      },
      runHeartbeatNow: async () => {
        called = true;
        return "Heartbeat completato: ok";
      },
    }));

    expect(handled).toBe(true);
    expect(called).toBe(true);
    expect(replies).toEqual(["Heartbeat completato: ok"]);
  });

  test("heartbeat command replies when forced heartbeat is ok", async () => {
    const replies: string[] = [];
    const handled = await handleTelegramCommand(buildParams({
      command: { name: "heartbeat", args: "" },
      sendCommandReply: async (text) => {
        replies.push(text);
      },
      runHeartbeatNow: async () => "Heartbeat completato: HEARTBEAT_OK (nessun alert).",
    }));

    expect(handled).toBe(true);
    expect(replies).toEqual(["Heartbeat completato: HEARTBEAT_OK (nessun alert)."]);
  });

  test("clear command resets both conversation and runtime state", async () => {
    const replies: string[] = [];
    let conversationCleared = false;
    let runtimeCleared = false;

    const handled = await handleTelegramCommand(buildParams({
      command: { name: "clear", args: "" },
      sendCommandReply: async (text) => {
        replies.push(text);
      },
      clearConversation: () => {
        conversationCleared = true;
      },
      clearRuntimeState: async () => {
        runtimeCleared = true;
      },
    }));

    expect(handled).toBe(true);
    expect(conversationCleared).toBe(true);
    expect(runtimeCleared).toBe(true);
    expect(replies).toEqual(["Memoria conversazione cancellata."]);
  });

});
