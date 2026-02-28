import { createConnection } from "node:net";
import type { RpcId, RpcRequest, RpcResponse } from "./types";

const DEFAULT_SOCKET_PATH = "/tmp/ambrogio-mac-tools.sock";
const DEFAULT_TCP_HOST = "127.0.0.1";
const DEFAULT_TCP_PORT = 39223;
const DEFAULT_RPC_TIMEOUT_MS = 35_000;

type Transport = "unix" | "tcp";

function readTcpPort(): number {
  const raw = process.env.AMBROGIO_MAC_TOOLS_TCP_PORT;
  if (!raw) {
    return DEFAULT_TCP_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TCP_PORT;
  }
  return Math.floor(parsed);
}

function isRetriableUnixError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "ENOENT" || code === "EPERM" || code === "ECONNREFUSED";
}

function sendRpcOverTransport(params: {
  timeoutMs: number;
  request: RpcRequest;
  transport: Transport;
  socketPath: string;
  tcpHost: string;
  tcpPort: number;
}): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = params.transport === "unix"
      ? createConnection(params.socketPath)
      : createConnection({ host: params.tcpHost, port: params.tcpPort });

    let buffer = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new Error(`mac-tools RPC timeout after ${params.timeoutMs}ms`));
      });
    }, params.timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(params.request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline).trim();
      finish(() => {
        socket.end();
        if (!line) {
          reject(new Error("Empty RPC response."));
          return;
        }
        try {
          resolve(JSON.parse(line) as RpcResponse);
        } catch (error) {
          reject(error);
        }
      });
    });

    socket.on("error", (error) => {
      finish(() => reject(error));
    });
  });
}

export async function callMacToolsRpc<TParams extends Record<string, unknown> | undefined>(params: {
  socketPath?: string;
  method: string;
  requestId?: RpcId;
  rpcId?: RpcId;
  payload?: TParams;
  timeoutMs?: number;
}): Promise<RpcResponse> {
  const socketPath = params.socketPath?.trim()
    || process.env.AMBROGIO_MAC_TOOLS_SOCKET_PATH?.trim()
    || DEFAULT_SOCKET_PATH;
  const timeoutEnv = Number(process.env.AMBROGIO_MAC_TOOLS_RPC_TIMEOUT_MS ?? "");
  const timeoutMs = params.timeoutMs
    ?? (Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : DEFAULT_RPC_TIMEOUT_MS);
  const tcpHost = process.env.AMBROGIO_MAC_TOOLS_TCP_HOST?.trim() || DEFAULT_TCP_HOST;
  const tcpPort = readTcpPort();
  const transportPref = (process.env.AMBROGIO_MAC_TOOLS_RPC_TRANSPORT?.trim().toLowerCase() ?? "auto") as
    | "auto"
    | "unix"
    | "tcp";

  const request: RpcRequest = {
    jsonrpc: "2.0",
    id: params.requestId ?? params.rpcId ?? null,
    method: params.method,
    params: params.payload,
  };

  if (transportPref === "tcp") {
    return await sendRpcOverTransport({
      timeoutMs,
      request,
      transport: "tcp",
      socketPath,
      tcpHost,
      tcpPort,
    });
  }

  if (transportPref === "unix") {
    return await sendRpcOverTransport({
      timeoutMs,
      request,
      transport: "unix",
      socketPath,
      tcpHost,
      tcpPort,
    });
  }

  try {
    return await sendRpcOverTransport({
      timeoutMs,
      request,
      transport: "unix",
      socketPath,
      tcpHost,
      tcpPort,
    });
  } catch (error) {
    if (!isRetriableUnixError(error)) {
      throw error;
    }
    return await sendRpcOverTransport({
      timeoutMs,
      request,
      transport: "tcp",
      socketPath,
      tcpHost,
      tcpPort,
    });
  }
}
