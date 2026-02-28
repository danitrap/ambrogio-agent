import type { Logger } from "../logging/audit";
import { startMacToolsService, type MacToolsServiceHandle } from "../mac-tools/mac-tools-service";
import { callMacToolsRpc } from "../mac-tools/rpc-client";

type MacToolsLifecycleOptions = {
  enabled: boolean;
  socketPath: string;
  logger: Logger;
  deps?: {
    startService?: typeof startMacToolsService;
    callRpc?: typeof callMacToolsRpc;
  };
};

type MacToolsLifecycleHandle = {
  isEnabled: () => boolean;
  runStartupHealthcheck: () => Promise<void>;
  stop: () => Promise<void>;
};

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export async function startMacToolsLifecycle(options: MacToolsLifecycleOptions): Promise<MacToolsLifecycleHandle> {
  if (!options.enabled) {
    options.logger.info("mac_tools_disabled", { socketPath: options.socketPath });
    return {
      isEnabled: () => false,
      runStartupHealthcheck: async () => {},
      stop: async () => {},
    };
  }

  let service: MacToolsServiceHandle | null = null;
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDelayMs = INITIAL_BACKOFF_MS;

  const startServiceImpl = options.deps?.startService ?? startMacToolsService;
  const callRpcImpl = options.deps?.callRpc ?? callMacToolsRpc;

  const clearRestartTimer = (): void => {
    if (!restartTimer) {
      return;
    }
    clearTimeout(restartTimer);
    restartTimer = null;
  };

  const startService = async (): Promise<void> => {
    clearRestartTimer();
    service = await startServiceImpl({
      socketPath: options.socketPath,
      onServerError: (error) => {
        options.logger.error("mac_tools_server_error", { message: error.message });
        if (!stopping) {
          scheduleRestart();
        }
      },
      onServerClose: () => {
        options.logger.warn("mac_tools_server_closed");
        service = null;
        if (!stopping) {
          scheduleRestart();
        }
      },
    });
    restartDelayMs = INITIAL_BACKOFF_MS;
    options.logger.info("mac_tools_server_started", { socketPath: service.socketPath });
  };

  const scheduleRestart = (): void => {
    if (stopping || restartTimer) {
      return;
    }
    const delay = restartDelayMs;
    restartDelayMs = Math.min(restartDelayMs * 2, MAX_BACKOFF_MS);
    options.logger.warn("mac_tools_server_restart_scheduled", { delayMs: delay });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void (async () => {
        try {
          await startService();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.logger.error("mac_tools_server_restart_failed", { message });
          scheduleRestart();
        }
      })();
    }, delay);
  };

  await startService();

  const runStartupHealthcheck = async (): Promise<void> => {
    try {
      const ping = await callRpcImpl({
        socketPath: options.socketPath,
        method: "system.ping",
        requestId: "startup-ping",
      });
      if ("error" in ping) {
        options.logger.error("mac_tools_healthcheck_ping_failed", {
          code: ping.error.code,
          message: ping.error.message,
        });
        return;
      }
      options.logger.info("mac_tools_healthcheck_ping_ok", { result: ping.result });

      const info = await callRpcImpl({
        socketPath: options.socketPath,
        method: "system.info",
        requestId: "startup-info",
      });
      if ("error" in info) {
        options.logger.error("mac_tools_healthcheck_info_failed", {
          code: info.error.code,
          message: info.error.message,
        });
        return;
      }
      options.logger.info("mac_tools_healthcheck_info_ok", { result: info.result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.error("mac_tools_healthcheck_failed", { message });
    }
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    clearRestartTimer();
    if (!service) {
      return;
    }
    await service.close();
    service = null;
    options.logger.info("mac_tools_server_stopped");
  };

  return {
    isEnabled: () => true,
    runStartupHealthcheck,
    stop,
  };
}
