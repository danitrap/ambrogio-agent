export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const HEARTBEAT_FILE_NAME = "HEARTBEAT.md";

type HeartbeatLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type HeartbeatCycleResult = {
  status: "completed" | "error";
  requestId: string;
};

export function buildHeartbeatPrompt(): string {
  return "Run a heartbeat check.";
}

export async function runHeartbeatCycle(params: {
  logger: HeartbeatLogger;
  runHeartbeatPrompt: (args: { prompt: string; requestId: string }) => Promise<string>;
  requestId: string;
}): Promise<HeartbeatCycleResult> {
  const prompt = buildHeartbeatPrompt();
  params.logger.info("heartbeat_started", { requestId: params.requestId });

  try {
    await params.runHeartbeatPrompt({ prompt, requestId: params.requestId });
    // La skill gestisce tutto autonomamente: lettura contesto, decisione, invio messaggi
    // Qui non dobbiamo fare nulla con la risposta
    params.logger.info("heartbeat_completed", { requestId: params.requestId });
    return { status: "completed", requestId: params.requestId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.logger.error("heartbeat_error", {
      requestId: params.requestId,
      message,
    });
    return { status: "error", requestId: params.requestId };
  }
}
