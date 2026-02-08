import { createHash } from "node:crypto";
import { shouldDeduplicateHeartbeatMessage } from "./heartbeat-dedup";
import { runHeartbeatCycle } from "./heartbeat";
import { isInQuietHours, type QuietHoursWindow } from "./heartbeat-quiet-hours";

export type HeartbeatStatus =
  | "ok"
  | "checkin_sent"
  | "checkin_dropped"
  | "alert_sent"
  | "alert_dropped"
  | "skipped_inflight";

type LoggerLike = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  debug: (message: string, fields?: Record<string, unknown>) => void;
};

export function createHeartbeatRunner(params: {
  logger: LoggerLike;
  stateStore: {
    getRuntimeValue: (key: string) => string | null;
    setRuntimeValue: (key: string, value: string) => void;
  };
  runHeartbeatPromptWithTimeout: (prompt: string, requestId: string) => Promise<string>;
  getAlertChatId: () => number | null;
  sendAlertMessage: (chatId: number, message: string) => Promise<void>;
  recordRecentTelegramEntry: (role: "assistant" | "user", summary: string, atMs?: number) => Promise<void>;
  previewText: (value: string, max?: number) => string;
  dedupWindowMs: number;
  quietHours: QuietHoursWindow | null;
}) {
  let heartbeatInFlight = false;
  let heartbeatLastRunAt = params.stateStore.getRuntimeValue("heartbeat_last_run_at");
  let heartbeatLastResult =
    (params.stateStore.getRuntimeValue("heartbeat_last_result") as HeartbeatStatus | "never" | null) ?? "never";

  const runScheduledHeartbeat = async (
    trigger: "timer" | "manual",
  ): Promise<{ status: HeartbeatStatus; requestId?: string }> => {
    if (heartbeatInFlight) {
      params.logger.warn("heartbeat_skipped_inflight");
      heartbeatLastResult = "skipped_inflight";
      params.stateStore.setRuntimeValue("heartbeat_last_result", heartbeatLastResult);
      params.logger.debug("state_store_runtime_value_written", {
        key: "heartbeat_last_result",
        value: heartbeatLastResult,
      });
      return { status: "skipped_inflight" };
    }

    heartbeatInFlight = true;
    heartbeatLastRunAt = new Date().toISOString();
    params.stateStore.setRuntimeValue("heartbeat_last_run_at", heartbeatLastRunAt);
    params.logger.debug("state_store_runtime_value_written", {
      key: "heartbeat_last_run_at",
      value: heartbeatLastRunAt,
    });
    const requestId = `heartbeat-${Date.now()}`;

    try {
      const cycleResult = await runHeartbeatCycle({
        logger: params.logger,
        runHeartbeatPrompt: async ({ prompt, requestId: cycleRequestId }) =>
          params.runHeartbeatPromptWithTimeout(prompt, cycleRequestId),
        getAlertChatId: params.getAlertChatId,
        sendAlert: async (chatId, message) => {
          const fingerprint = createHash("sha1").update(message.trim()).digest("hex");
          const nowMs = Date.now();
          const nowIso = new Date(nowMs).toISOString();
          const lastFingerprint = params.stateStore.getRuntimeValue("heartbeat_last_alert_fingerprint");
          const lastAlertAt = params.stateStore.getRuntimeValue("heartbeat_last_alert_at");
          if (trigger === "timer" && shouldDeduplicateHeartbeatMessage({
            lastFingerprint,
            lastSentAtIso: lastAlertAt,
            nextFingerprint: fingerprint,
            nowMs,
            dedupWindowMs: params.dedupWindowMs,
          })) {
            params.logger.info("heartbeat_alert_deduplicated", {
              chatId,
              fingerprint,
              lastAlertAt,
              dedupWindowMs: params.dedupWindowMs,
            });
            return "dropped";
          }
          await params.sendAlertMessage(chatId, message);
          await params.recordRecentTelegramEntry("assistant", `heartbeat alert: ${params.previewText(message, 120)}`);
          params.stateStore.setRuntimeValue("heartbeat_last_alert_fingerprint", fingerprint);
          params.stateStore.setRuntimeValue("heartbeat_last_alert_at", nowIso);
          params.logger.debug("state_store_runtime_value_written", {
            key: "heartbeat_last_alert_fingerprint",
            value: fingerprint,
          });
          params.logger.debug("state_store_runtime_value_written", {
            key: "heartbeat_last_alert_at",
            value: nowIso,
          });
          return "sent";
        },
        requestId,
        trigger,
        shouldSuppressCheckin: () => isInQuietHours(params.quietHours),
      });
      heartbeatLastResult = cycleResult.status;
      params.stateStore.setRuntimeValue("heartbeat_last_result", heartbeatLastResult);
      params.logger.debug("state_store_runtime_value_written", {
        key: "heartbeat_last_result",
        value: heartbeatLastResult,
      });
      params.logger.info("heartbeat_finished", { trigger, requestId, status: cycleResult.status });
      return { status: cycleResult.status, requestId };
    } finally {
      heartbeatInFlight = false;
    }
  };

  return {
    runScheduledHeartbeat,
    getHeartbeatState: () => ({
      heartbeatInFlight,
      heartbeatLastRunAt,
      heartbeatLastResult,
    }),
    resetHeartbeatState: () => {
      heartbeatLastRunAt = null;
      heartbeatLastResult = "never";
    },
    isInQuietHours: () => isInQuietHours(params.quietHours),
    hasQuietHours: () => params.quietHours !== null,
    getQuietHoursRaw: () => params.quietHours?.raw ?? null,
  };
}
