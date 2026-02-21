import type { Logger } from "../logging/audit";
import type { DashboardSnapshot } from "./types";
import { renderDashboardHtml } from "./ui";

type StartDashboardHttpServerOptions = {
  host: string;
  port: number;
  logger: Logger;
  getSnapshot: () => Promise<DashboardSnapshot>;
};

type DashboardHttpServerHandle = {
  server: Bun.Server<unknown>;
  port: number;
  stop: () => void;
};

export function createDashboardFetchHandler(
  options: Pick<StartDashboardHttpServerOptions, "logger" | "getSnapshot">,
): (request: Request) => Promise<Response> {
  const html = renderDashboardHtml();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/dashboard") {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/dashboard/api/snapshot") {
      const snapshot = await options.getSnapshot();
      return Response.json(snapshot, {
        headers: {
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/dashboard/healthz") {
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  };
}

export function startDashboardHttpServer(options: StartDashboardHttpServerOptions): DashboardHttpServerHandle {
  const fetchHandler = createDashboardFetchHandler(options);
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: fetchHandler,
    error: (error) => {
      options.logger.error("dashboard_http_error", {
        message: error.message,
      });
      return Response.json({ error: "internal_error" }, { status: 500 });
    },
  });

  options.logger.info("dashboard_http_started", {
    host: options.host,
    port: server.port,
  });

  return {
    server,
    port: server.port ?? options.port,
    stop: () => server.stop(true),
  };
}
