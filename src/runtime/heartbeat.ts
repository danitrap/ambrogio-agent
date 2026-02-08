export const HEARTBEAT_OK = "HEARTBEAT_OK";
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const HEARTBEAT_FILE_NAME = "HEARTBEAT.md";

type HeartbeatLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type HeartbeatCycleResult = {
  status: "ok" | "ok_notice_sent" | "alert_sent" | "alert_dropped";
};

export function buildHeartbeatPrompt(heartbeatDoc: string | null): string {
  const base = [
    "Run a lightweight periodic heartbeat check.",
    "Follow HEARTBEAT.md instructions if provided below.",
    "Do not resurrect stale tasks unless HEARTBEAT.md explicitly asks for it.",
    `If there is nothing actionable, reply with exactly ${HEARTBEAT_OK}.`,
  ].join("\n");

  if (!heartbeatDoc || heartbeatDoc.trim().length === 0) {
    return base;
  }

  return `${base}\n\nHEARTBEAT.md:\n${heartbeatDoc.trim()}`;
}

function formatAlertMessage(reason: string): string {
  return `Heartbeat alert:\n${reason}`.slice(0, 4000);
}

function isHeartbeatOk(response: string): boolean {
  return response.trim() === HEARTBEAT_OK;
}

function extractOkReminderMessage(heartbeatDoc: string | null): string | null {
  if (!heartbeatDoc) {
    return null;
  }

  const marker = "always include the exact message:";
  for (const line of heartbeatDoc.split("\n")) {
    const normalized = line.trim().replace(/^-+\s*/, "");
    const lower = normalized.toLowerCase();
    const index = lower.indexOf(marker);
    if (index === -1) {
      continue;
    }
    const value = normalized.slice(index + marker.length).trim();
    if (value.length > 0) {
      return value;
    }
  }

  return null;
}

export async function runHeartbeatCycle(params: {
  logger: HeartbeatLogger;
  readHeartbeatDoc: () => Promise<string | null>;
  runHeartbeatPrompt: (args: { prompt: string; requestId: string }) => Promise<string>;
  getAlertChatId: () => number | null;
  sendAlert: (chatId: number, message: string) => Promise<void>;
  requestId: string;
}): Promise<HeartbeatCycleResult> {
  let heartbeatDoc: string | null = null;

  try {
    heartbeatDoc = await params.readHeartbeatDoc();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.logger.warn("heartbeat_doc_read_failed", { requestId: params.requestId, message });
  }

  const prompt = buildHeartbeatPrompt(heartbeatDoc);
  params.logger.info("heartbeat_started", { requestId: params.requestId });

  try {
    const response = await params.runHeartbeatPrompt({ prompt, requestId: params.requestId });
    if (isHeartbeatOk(response)) {
      const reminder = extractOkReminderMessage(heartbeatDoc);
      if (reminder) {
        const chatId = params.getAlertChatId();
        if (chatId === null) {
          params.logger.warn("heartbeat_ok_notice_dropped_no_chat", { requestId: params.requestId });
          return { status: "alert_dropped" };
        }
        await params.sendAlert(chatId, reminder.slice(0, 4000));
        params.logger.info("heartbeat_ok_notice_sent", { requestId: params.requestId, chatId });
        return { status: "ok_notice_sent" };
      }
      params.logger.info("heartbeat_ok", { requestId: params.requestId });
      return { status: "ok" };
    }

    const normalized = response.trim();
    const reason = normalized.length > 0 ? normalized : "Empty heartbeat response.";
    const chatId = params.getAlertChatId();
    if (chatId === null) {
      params.logger.warn("heartbeat_alert_dropped_no_chat", { requestId: params.requestId, reason });
      return { status: "alert_dropped" };
    }

    await params.sendAlert(chatId, formatAlertMessage(reason));
    params.logger.warn("heartbeat_alert_sent", { requestId: params.requestId, chatId });
    return { status: "alert_sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const chatId = params.getAlertChatId();
    if (chatId === null) {
      params.logger.error("heartbeat_failed_no_chat", { requestId: params.requestId, message });
      return { status: "alert_dropped" };
    }

    await params.sendAlert(chatId, formatAlertMessage(`Heartbeat execution failed: ${message}`));
    params.logger.error("heartbeat_failed_alert_sent", { requestId: params.requestId, message, chatId });
    return { status: "alert_sent" };
  }
}
