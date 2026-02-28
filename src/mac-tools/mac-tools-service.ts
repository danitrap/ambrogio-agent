import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { CalendarProvider } from "./providers/calendar-provider";
import { RemindersProvider } from "./providers/reminders-provider";
import {
  MacToolsError,
  type RemindersCreateParams,
  type RemindersUpdateParams,
  type RpcError,
  type RpcId,
  type RpcRequest,
  type RpcResponse,
  type RpcSuccess,
  type SystemInfoResult,
  type SystemPingResult,
} from "./types";

const SERVICE_VERSION = "1.0.0";
const DEFAULT_SOCKET_PATH = "/tmp/ambrogio-mac-tools.sock";

export type MacToolsServiceOptions = {
  socketPath?: string;
  tcp?: {
    enabled?: boolean;
    host?: string;
    port?: number;
  };
  calendarProvider?: CalendarProvider;
  remindersProvider?: RemindersProvider;
  onServerError?: (error: Error) => void;
  onServerClose?: () => void;
};

export type MacToolsServiceHandle = {
  socketPath: string;
  tcpEndpoint: { host: string; port: number } | null;
  close: () => Promise<void>;
};

async function safeUnlink(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function buildSuccess<TResult>(id: RpcId, result: TResult): RpcSuccess<TResult> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function buildError(id: RpcId, error: MacToolsError): RpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: error.code,
      message: error.message,
      data: error.data,
    },
  };
}

function readMethod(request: RpcRequest): string {
  if (typeof request.method !== "string" || request.method.trim().length === 0) {
    throw new MacToolsError("invalid_params", "method must be a non-empty string.");
  }
  return request.method.trim();
}

function normalizeId(id: unknown): RpcId {
  if (id === null || id === undefined) {
    return null;
  }
  if (typeof id === "string" || typeof id === "number") {
    return id;
  }
  return null;
}

export async function handleMacToolsRpcRequest(params: {
  request: RpcRequest;
  socketPath: string;
  startedAtMs: number;
  calendarProvider: CalendarProvider;
  remindersProvider: RemindersProvider;
}): Promise<RpcResponse> {
  const id = normalizeId(params.request.id);
  let method = "";
  try {
    method = readMethod(params.request);
    if (method === "system.ping") {
      const result: SystemPingResult = {
        ok: true,
        service: "mac-tools-service",
        version: SERVICE_VERSION,
      };
      return buildSuccess(id, result);
    }

    if (method === "system.info") {
      const [calendarPermission, remindersPermission] = await Promise.all([
        params.calendarProvider.getPermissionState(),
        params.remindersProvider.getPermissionState(),
      ]);
      const result: SystemInfoResult = {
        service: "mac-tools-service",
        version: SERVICE_VERSION,
        uptimeMs: Math.max(0, Date.now() - params.startedAtMs),
        socketPath: params.socketPath,
        permissions: {
          calendar: calendarPermission,
          reminders: remindersPermission,
        },
      };
      return buildSuccess(id, result);
    }

    if (method === "calendar.upcoming") {
      const result = await params.calendarProvider.getUpcoming(params.request.params as Record<string, unknown> | undefined);
      return buildSuccess(id, result);
    }

	    if (method === "reminders.open") {
	      const result = await params.remindersProvider.getOpen(params.request.params as Record<string, unknown> | undefined);
	      return buildSuccess(id, result);
	    }

	    if (method === "reminders.lists") {
	      const result = await params.remindersProvider.getLists();
	      return buildSuccess(id, result);
	    }

	    if (method === "reminders.create") {
      const result = await params.remindersProvider.create((params.request.params ?? {}) as RemindersCreateParams);
      return buildSuccess(id, result);
    }

    if (method === "reminders.update") {
      const result = await params.remindersProvider.update((params.request.params ?? {}) as RemindersUpdateParams);
      return buildSuccess(id, result);
    }

    throw new MacToolsError("method_not_found", `Unsupported method: ${method}`);
  } catch (error) {
    if (error instanceof MacToolsError) {
      return buildError(id, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return buildError(id, new MacToolsError("internal_error", message));
  }
}

function attachConnection(params: {
  socket: Socket;
  socketPath: string;
  startedAtMs: number;
  calendarProvider: CalendarProvider;
  remindersProvider: RemindersProvider;
}): void {
  let buffer = "";
  params.socket.setEncoding("utf8");

  params.socket.on("data", async (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        const request = JSON.parse(line) as RpcRequest;
        const response = await handleMacToolsRpcRequest({
          request,
          socketPath: params.socketPath,
          startedAtMs: params.startedAtMs,
          calendarProvider: params.calendarProvider,
          remindersProvider: params.remindersProvider,
        });
        params.socket.write(`${JSON.stringify(response)}\n`);
      } catch {
        const response = buildError(null, new MacToolsError("invalid_params", "Invalid JSON request."));
        params.socket.write(`${JSON.stringify(response)}\n`);
      }
    }
  });
}

export async function startMacToolsService(options: MacToolsServiceOptions = {}): Promise<MacToolsServiceHandle> {
  const socketPath = options.socketPath?.trim() || process.env.AMBROGIO_MAC_TOOLS_SOCKET_PATH?.trim() || DEFAULT_SOCKET_PATH;
  const tcpEnabled = options.tcp?.enabled ?? (process.env.AMBROGIO_MAC_TOOLS_TCP_ENABLED?.trim().toLowerCase() === "true");
  const tcpHost = options.tcp?.host ?? process.env.AMBROGIO_MAC_TOOLS_TCP_HOST ?? "0.0.0.0";
  const tcpListenHost = tcpHost === "host.docker.internal" ? "0.0.0.0" : tcpHost;
  const tcpPortRaw = options.tcp?.port
    ?? (process.env.AMBROGIO_MAC_TOOLS_TCP_PORT ? Number(process.env.AMBROGIO_MAC_TOOLS_TCP_PORT) : 39223);
  const tcpPort = Number.isFinite(tcpPortRaw) ? Math.floor(tcpPortRaw) : 39223;
  const calendarProvider = options.calendarProvider ?? new CalendarProvider();
  const remindersProvider = options.remindersProvider ?? new RemindersProvider();
  const startedAtMs = Date.now();

  await mkdir(path.dirname(socketPath), { recursive: true });
  await safeUnlink(socketPath);

  const unixServer: Server = createServer((socket) => {
    attachConnection({
      socket,
      socketPath,
      startedAtMs,
      calendarProvider,
      remindersProvider,
    });
  });

  if (options.onServerError) {
    unixServer.on("error", options.onServerError);
  }
  if (options.onServerClose) {
    unixServer.on("close", options.onServerClose);
  }

  await new Promise<void>((resolve, reject) => {
    unixServer.once("error", reject);
    unixServer.listen(socketPath, () => {
      unixServer.off("error", reject);
      resolve();
    });
  });

  try {
    await chmod(socketPath, 0o600);
  } catch {
    // Some environments may not support chmod on unix sockets.
  }

  let tcpServer: Server | null = null;
  let tcpEndpoint: { host: string; port: number } | null = null;
  if (tcpEnabled) {
    tcpServer = createServer((socket) => {
      attachConnection({
        socket,
        socketPath,
        startedAtMs,
        calendarProvider,
        remindersProvider,
      });
    });
    if (options.onServerError) {
      tcpServer.on("error", options.onServerError);
    }
    if (options.onServerClose) {
      tcpServer.on("close", options.onServerClose);
    }
    await new Promise<void>((resolve, reject) => {
      tcpServer?.once("error", reject);
      tcpServer?.listen(tcpPort, tcpListenHost, () => {
        tcpServer?.off("error", reject);
        resolve();
      });
    });
    const address = tcpServer.address();
    if (address && typeof address === "object") {
      tcpEndpoint = { host: address.address, port: address.port };
    } else {
      tcpEndpoint = { host: tcpListenHost, port: tcpPort };
    }
  }

  return {
    socketPath,
    tcpEndpoint,
    close: async () => {
      if (tcpServer) {
        await new Promise<void>((resolve, reject) => {
          tcpServer?.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
      await new Promise<void>((resolve, reject) => {
        unixServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await safeUnlink(socketPath);
    },
  };
}
