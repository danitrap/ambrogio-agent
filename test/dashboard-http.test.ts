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
      health: {
        heartbeat: {
          status: "ok",
          lastRunAt: "2026-02-21T08:30:00.000Z",
          lastResult: "completed",
          minutesSinceLastRun: 30,
          staleAfterMinutes: 90,
        },
        errors: {
          failedPendingDelivery: 0,
          heartbeatError: false,
          total: 0,
        },
        pending: {
          scheduled: 0,
          running: 0,
          pendingDelivery: 0,
          total: 0,
        },
        uptime: {
          seconds: 120,
          human: "2m 0s",
        },
      },
      todo: { columns: [] },
      groceries: { columns: [] },
      knowledge: {
        memory: { exists: true, updatedAt: "2026-02-21T09:00:00.000Z", previewLines: ["# Memory", "- espresso"] },
        notes: { exists: true, updatedAt: "2026-02-21T09:00:00.000Z", previewLines: ["# Notes", "## Project"] },
        stateCounts: {
          memoryEntries: 2,
          notesEntries: 3,
        },
      },
      skillState: {
        fetchUrlCacheEntries: 1,
        ttsAudioCacheEntries: 1,
        atmTramScheduleCacheEntries: 1,
        atmTramScheduleGtfsTimestampPresent: true,
      },
    };

    const handler = createDashboardFetchHandler({
      logger: new Logger("error"),
      getSnapshot: async () => snapshot,
    });

    const html = await handler(new Request("http://localhost/dashboard"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const htmlBody = await html.text();
    expect(htmlBody).toContain("Ambrogio Dashboard");
    expect(htmlBody).toContain("Knowledge");

    const json = await handler(new Request("http://localhost/dashboard/api/snapshot"));
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toEqual(snapshot);

    const health = await handler(new Request("http://localhost/dashboard/healthz"));
    expect(await health.json()).toEqual({ ok: true });
  });
});
