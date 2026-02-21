import { describe, expect, test } from "bun:test";
import type { DashboardSnapshot } from "../src/dashboard/types";
import { createDashboardFetchHandler } from "../src/dashboard/http-server";
import { Logger } from "../src/logging/audit";

describe("startDashboardHttpServer", () => {
  test("serves html, json snapshot and healthz", async () => {
    const snapshot: DashboardSnapshot = {
      generatedAt: "2026-02-21T09:00:00.000Z",
      timezone: "Europe/Rome",
      jobs: [],
      todo: { columns: [] },
      groceries: { columns: [] },
    };

    const handler = createDashboardFetchHandler({
      logger: new Logger("error"),
      getSnapshot: async () => snapshot,
    });

    const html = await handler(new Request("http://localhost/dashboard"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("Ambrogio Dashboard");

    const json = await handler(new Request("http://localhost/dashboard/api/snapshot"));
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toEqual(snapshot);

    const health = await handler(new Request("http://localhost/dashboard/healthz"));
    expect(await health.json()).toEqual({ ok: true });
  });
});
