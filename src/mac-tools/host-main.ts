import { mkdir } from "node:fs/promises";
import path from "node:path";
import { startMacToolsService } from "./mac-tools-service";

function resolveHostSocketPath(): string {
  const fromEnv = process.env.AMBROGIO_MAC_TOOLS_SOCKET_PATH?.trim();
  if (!fromEnv) {
    return path.join(process.cwd(), "data", "runtime", "mac-tools.sock");
  }
  if (fromEnv.startsWith("/data/")) {
    return path.join(process.cwd(), "data", fromEnv.slice("/data/".length));
  }
  return fromEnv;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("mac-tools host service can run only on macOS (darwin).");
  }

  const socketPath = resolveHostSocketPath();
  await mkdir(path.dirname(socketPath), { recursive: true });
  const tcpEnabled = (process.env.AMBROGIO_MAC_TOOLS_TCP_ENABLED?.trim().toLowerCase() ?? "true") === "true";
  const tcpHost = process.env.AMBROGIO_MAC_TOOLS_TCP_HOST ?? "0.0.0.0";
  const tcpPort = Number(process.env.AMBROGIO_MAC_TOOLS_TCP_PORT ?? "39223");

  const handle = await startMacToolsService({
    socketPath,
    tcp: {
      enabled: tcpEnabled,
      host: tcpHost,
      port: Number.isFinite(tcpPort) ? tcpPort : 39223,
    },
  });
  console.log(`mac-tools-service listening on ${handle.socketPath}`);
  if (handle.tcpEndpoint) {
    console.log(`mac-tools-service tcp endpoint ${handle.tcpEndpoint.host}:${handle.tcpEndpoint.port}`);
  }

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`mac-tools-service shutting down (${signal})`);
    await handle.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await new Promise(() => {});
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
