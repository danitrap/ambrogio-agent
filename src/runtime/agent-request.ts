import type { Logger } from "../logging/audit";

export type RequestContext = {
  updateId: number;
  userId: number;
  chatId: number;
};

export type AgentRequestResult = {
  reply: string;
  ok: boolean;
};

export async function runAgentRequestWithTimeout(params: {
  logger: Logger;
  update: RequestContext;
  timeoutMs: number;
  operation: () => Promise<string>;
  command?: string;
}): Promise<AgentRequestResult> {
  try {
    const reply = await params.operation();
    return { reply, ok: true };
  } catch (error) {
    if (error instanceof Error && error.message === "MODEL_TIMEOUT") {
      params.logger.error("request_timed_out", {
        updateId: params.update.updateId,
        userId: params.update.userId,
        chatId: params.update.chatId,
        timeoutMs: params.timeoutMs,
        ...(params.command ? { command: params.command } : {}),
      });
      return {
        reply: "Model backend unavailable right now. Riprova tra poco.",
        ok: false,
      };
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    params.logger.error("message_processing_failed", {
      message,
      userId: params.update.userId,
      ...(params.command ? { command: params.command } : {}),
    });
    return {
      reply: `Error: ${message}`,
      ok: false,
    };
  }
}
