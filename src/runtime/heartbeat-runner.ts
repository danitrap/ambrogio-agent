import { runHeartbeatCycle } from "./heartbeat";
import { isInQuietHours, type QuietHoursWindow } from "./heartbeat-quiet-hours";

export type HeartbeatStatus = "completed" | "error" | "skipped_inflight" | "skipped_quiet_hours";

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
  quietHours: QuietHoursWindow | null;
}) {
  let heartbeatInFlight = false;
  let heartbeatLastRunAt = params.stateStore.getRuntimeValue("heartbeat_last_run_at");
  let heartbeatLastResult =
    (params.stateStore.getRuntimeValue("heartbeat_last_result") as HeartbeatStatus | "never" | null) ?? "never";

  const runScheduledHeartbeat = async (
    trigger: "timer" | "manual"
  ): Promise<{ status: HeartbeatStatus; requestId?: string }> => {
    if (heartbeatInFlight) {
      params.logger.warn("heartbeat_skipped_inflight");
      heartbeatLastResult = "skipped_inflight";
      params.stateStore.setRuntimeValue("heartbeat_last_result", heartbeatLastResult);
      return { status: "skipped_inflight" };
    }

    // Quiet hours check (SOLO per timer trigger, non per manual)
    if (trigger === "timer" && isInQuietHours(params.quietHours)) {
      params.logger.info("heartbeat_skipped_quiet_hours", { trigger });
      heartbeatLastResult = "skipped_quiet_hours";
      params.stateStore.setRuntimeValue("heartbeat_last_result", heartbeatLastResult);
      return { status: "skipped_quiet_hours" };
    }

    heartbeatInFlight = true;
    heartbeatLastRunAt = new Date().toISOString();
    params.stateStore.setRuntimeValue("heartbeat_last_run_at", heartbeatLastRunAt);
    const requestId = `heartbeat-${Date.now()}`;

    try {
      const cycleResult = await runHeartbeatCycle({
        logger: params.logger,
        runHeartbeatPrompt: async ({ prompt, requestId: cycleRequestId }) =>
          params.runHeartbeatPromptWithTimeout(prompt, cycleRequestId),
        requestId,
      });

      heartbeatLastResult = cycleResult.status;
      params.stateStore.setRuntimeValue("heartbeat_last_result", heartbeatLastResult);
      params.logger.info("heartbeat_finished", { requestId, status: cycleResult.status });
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
