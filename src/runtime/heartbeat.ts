export const HEARTBEAT_OK = "HEARTBEAT_OK";
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const HEARTBEAT_FILE_NAME = "HEARTBEAT.md";

type HeartbeatLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type HeartbeatCycleResult = {
  status: "ok" | "checkin_sent" | "checkin_dropped" | "alert_sent" | "alert_dropped";
};

type HeartbeatDecision =
  | { action: "ok" }
  | { action: "checkin" | "alert"; issue: string; impact: string; nextStep: string; todoItems: string[] };

export function buildHeartbeatPrompt(): string {
  return "Run a heartbeat check.";
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

export async function runHeartbeatCycle(params: {
  logger: HeartbeatLogger;
  runHeartbeatPrompt: (args: { prompt: string; requestId: string }) => Promise<string>;
  getAlertChatId: () => number | null;
  sendAlert: (chatId: number, message: string) => Promise<"sent" | "dropped">;
  requestId: string;
  trigger?: "timer" | "manual";
  shouldSuppressCheckin?: () => boolean;
}): Promise<HeartbeatCycleResult> {
  const prompt = buildHeartbeatPrompt();
  params.logger.info("heartbeat_started", { requestId: params.requestId });

  try {
    const response = await params.runHeartbeatPrompt({ prompt, requestId: params.requestId });
    const decision = parseHeartbeatDecision(response);
    if (decision?.action === "ok") {
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
