export const HEARTBEAT_OK = "HEARTBEAT_OK";
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const HEARTBEAT_FILE_NAME = "HEARTBEAT.md";

type HeartbeatLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type HeartbeatCycleResult = {
  status: "ok" | "ok_notice_sent" | "checkin_sent" | "checkin_dropped" | "alert_sent" | "alert_dropped";
};

type HeartbeatDecision =
  | { action: "ok" }
  | { action: "checkin" | "alert"; issue: string; impact: string; nextStep: string; todoItems: string[] };

export function buildHeartbeatPrompt(heartbeatDoc: string | null): string {
  const base = [
    "Run a lightweight periodic heartbeat check.",
    "Follow HEARTBEAT.md instructions if provided below.",
    "Use Runtime status details (including TODO path and data root) to inspect current state before deciding.",
    "Do not resurrect stale tasks unless HEARTBEAT.md explicitly asks for it.",
    `If there is nothing actionable, reply with exactly ${HEARTBEAT_OK}.`,
    "If action is needed, reply with compact JSON only:",
    '{"action":"checkin|alert","issue":"...","impact":"...","nextStep":"...","todoItems":["optional item 1","optional item 2"]}',
    "Use action values as defined by HEARTBEAT.md policy.",
  ].join("\n");

  if (!heartbeatDoc || heartbeatDoc.trim().length === 0) {
    return base;
  }

  return `${base}\n\nHEARTBEAT.md:\n${heartbeatDoc.trim()}`;
}

function formatAlertMessage(reason: string): string {
  return `Heartbeat alert:\n${reason}`.slice(0, 4000);
}

function formatCheckinMessage(reason: string): string {
  return `Heartbeat check-in:\n${reason}`.slice(0, 4000);
}

function isHeartbeatOk(response: string): boolean {
  return response.trim() === HEARTBEAT_OK;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length < 3) {
    return trimmed;
  }

  if (!lines[0]?.startsWith("```") || lines[lines.length - 1]?.trim() !== "```") {
    return trimmed;
  }

  return lines.slice(1, -1).join("\n").trim();
}

function parseHeartbeatDecision(response: string): HeartbeatDecision | null {
  if (isHeartbeatOk(response)) {
    return { action: "ok" };
  }

  const normalized = stripCodeFence(response);
  if (!normalized.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized) as {
      action?: unknown;
      issue?: unknown;
      impact?: unknown;
      nextStep?: unknown;
      todoItems?: unknown;
    };
    if (parsed.action === "ok") {
      return { action: "ok" };
    }
    if (parsed.action !== "checkin" && parsed.action !== "alert") {
      return null;
    }

    const issue = typeof parsed.issue === "string" ? parsed.issue.trim() : "";
    const impact = typeof parsed.impact === "string" ? parsed.impact.trim() : "";
    const nextStep = typeof parsed.nextStep === "string" ? parsed.nextStep.trim() : "";
    const todoItems = Array.isArray(parsed.todoItems)
      ? parsed.todoItems.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];

    if (!issue || !impact || !nextStep) {
      return null;
    }

    return {
      action: parsed.action,
      issue,
      impact,
      nextStep,
      todoItems,
    };
  } catch {
    return null;
  }
}

function formatDecisionMessage(decision: Exclude<HeartbeatDecision, { action: "ok" }>): string {
  const lines = [
    `Issue: ${decision.issue}`,
    `Impact: ${decision.impact}`,
    `Next step: ${decision.nextStep}`,
  ];
  if (decision.todoItems.length > 0) {
    lines.push("TODO focus:");
    lines.push(...decision.todoItems.slice(0, 5).map((item, index) => `${index + 1}. ${item}`));
  }
  return lines.join("\n");
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
  sendAlert: (chatId: number, message: string) => Promise<"sent" | "dropped">;
  requestId: string;
  trigger?: "timer" | "manual";
  shouldSuppressCheckin?: () => boolean;
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
    const decision = parseHeartbeatDecision(response);
    if (decision?.action === "ok") {
      const reminder = extractOkReminderMessage(heartbeatDoc);
      if (reminder) {
        const chatId = params.getAlertChatId();
        if (chatId === null) {
          params.logger.warn("heartbeat_ok_notice_dropped_no_chat", { requestId: params.requestId });
          return { status: "alert_dropped" };
        }
        const sent = await params.sendAlert(chatId, reminder.slice(0, 4000));
        if (sent === "dropped") {
          params.logger.warn("heartbeat_ok_notice_dropped", { requestId: params.requestId, chatId });
          return { status: "alert_dropped" };
        }
        params.logger.info("heartbeat_ok_notice_sent", { requestId: params.requestId, chatId });
        return { status: "ok_notice_sent" };
      }
      params.logger.info("heartbeat_ok", { requestId: params.requestId });
      return { status: "ok" };
    }

    const normalized = response.trim();
    const reason = decision ? formatDecisionMessage(decision) : (normalized.length > 0 ? normalized : "Empty heartbeat response.");
    const action = decision?.action ?? "alert";
    if (action === "checkin" && params.trigger === "timer" && params.shouldSuppressCheckin?.()) {
      params.logger.info("heartbeat_checkin_suppressed_quiet_hours", { requestId: params.requestId });
      return { status: "checkin_dropped" };
    }
    const outbound = action === "checkin" ? formatCheckinMessage(reason) : formatAlertMessage(reason);
    const chatId = params.getAlertChatId();
    if (chatId === null) {
      params.logger.warn("heartbeat_action_dropped_no_chat", { requestId: params.requestId, reason, action });
      return { status: action === "checkin" ? "checkin_dropped" : "alert_dropped" };
    }

    const sent = await params.sendAlert(chatId, outbound);
    if (sent === "dropped") {
      params.logger.warn("heartbeat_action_deduplicated", { requestId: params.requestId, chatId, action });
      return { status: action === "checkin" ? "checkin_dropped" : "alert_dropped" };
    }
    if (action === "checkin") {
      params.logger.info("heartbeat_checkin_sent", { requestId: params.requestId, chatId });
      return { status: "checkin_sent" };
    }
    params.logger.warn("heartbeat_alert_sent", { requestId: params.requestId, chatId });
    return { status: "alert_sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const chatId = params.getAlertChatId();
    if (chatId === null) {
      params.logger.error("heartbeat_failed_no_chat", { requestId: params.requestId, message });
      return { status: "alert_dropped" };
    }

    const sent = await params.sendAlert(chatId, formatAlertMessage(`Heartbeat execution failed: ${message}`));
    if (sent === "dropped") {
      params.logger.warn("heartbeat_failed_alert_deduplicated", { requestId: params.requestId, chatId });
      return { status: "alert_dropped" };
    }
    params.logger.error("heartbeat_failed_alert_sent", { requestId: params.requestId, message, chatId });
    return { status: "alert_sent" };
  }
}
