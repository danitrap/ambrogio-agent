import { describe, expect, test } from "bun:test";
import { handleMacToolsRpcRequest } from "../src/mac-tools/mac-tools-service";
import { CalendarProvider } from "../src/mac-tools/providers/calendar-provider";
import { RemindersProvider } from "../src/mac-tools/providers/reminders-provider";
import { MacToolsError } from "../src/mac-tools/types";

describe("mac-tools-service routing", () => {
  test("supports ping/info/calendar/reminders routes", async () => {
    const calendarProvider = new CalendarProvider({
      fetchCalendarEvents: async () => [{
        id: "evt-1",
        calendarName: "Work",
        title: "Weekly review",
        startAt: "2026-02-24T10:00:00.000Z",
        endAt: "2026-02-24T11:00:00.000Z",
        allDay: false,
      }],
      getPermissionState: async () => "authorized",
      now: () => new Date("2026-02-23T10:00:00.000Z"),
    });

    const remindersProvider = new RemindersProvider({
      fetchOpenReminders: async () => [{
        id: "rem-1",
        listName: "Inbox",
        title: "Call @next",
        dueAt: "2026-02-24T08:00:00.000Z",
        priority: 5,
        isFlagged: true,
        notes: "details",
      }],
      getPermissionState: async () => "denied",
      now: () => new Date("2026-02-23T10:00:00.000Z"),
    });

    const context = {
      socketPath: "/tmp/test.sock",
      startedAtMs: Date.now() - 500,
      calendarProvider,
      remindersProvider,
    };

    const ping = await handleMacToolsRpcRequest({ request: { method: "system.ping", id: 1 }, ...context });
    expect("result" in ping && ping.result).toMatchObject({ ok: true, service: "mac-tools-service" });

    const info = await handleMacToolsRpcRequest({ request: { method: "system.info", id: 2 }, ...context });
    if (!("result" in info)) {
      throw new Error("Expected info success response");
    }
    const infoResult = info.result as { permissions: { calendar: string; reminders: string } };
    expect(infoResult.permissions.calendar).toBe("authorized");
    expect(infoResult.permissions.reminders).toBe("denied");

    const calendar = await handleMacToolsRpcRequest({
      request: { method: "calendar.upcoming", id: 3, params: { days: 2, limit: 10 } },
      ...context,
    });
    if (!("result" in calendar)) {
      throw new Error("Expected calendar success response");
    }
    const calendarResult = calendar.result as { count: number };
    expect(calendarResult.count).toBe(1);
    expect(calendarResult).toMatchObject({
      generatedAtEpochMs: Date.parse("2026-02-23T10:00:00.000Z"),
    });

    const reminders = await handleMacToolsRpcRequest({
      request: { method: "reminders.open", id: 4, params: { limit: 10 } },
      ...context,
    });
    if (!("result" in reminders)) {
      throw new Error("Expected reminders success response");
    }
    const remindersResult = reminders.result as {
      generatedAtEpochMs: number;
      timezone: string;
      items: Array<{ tags: string[]; isFlagged: boolean; dueInMinutes: number | null }>;
    };
    expect(remindersResult.items[0]?.tags).toEqual(["@next"]);
    expect(remindersResult.items[0]?.isFlagged).toBe(true);
    expect(remindersResult.items[0]?.dueInMinutes).toBe(1320);
    expect(remindersResult.generatedAtEpochMs).toBe(Date.parse("2026-02-23T10:00:00.000Z"));
    expect(typeof remindersResult.timezone).toBe("string");
  });

  test("returns method_not_found and standard errors", async () => {
    const context = {
      socketPath: "/tmp/test.sock",
      startedAtMs: Date.now(),
      calendarProvider: new CalendarProvider({
        fetchCalendarEvents: async () => {
          throw new MacToolsError("permission_denied", "Calendar access not granted.", { service: "calendar" });
        },
      }),
      remindersProvider: new RemindersProvider({
        fetchOpenReminders: async () => {
          throw new MacToolsError("timeout", "timed out");
        },
      }),
    };

    const unknown = await handleMacToolsRpcRequest({ request: { method: "unknown.method", id: 1 }, ...context });
    expect("error" in unknown && unknown.error.code).toBe("method_not_found");

    const permission = await handleMacToolsRpcRequest({
      request: { method: "calendar.upcoming", id: 2, params: { days: 1 } },
      ...context,
    });
    expect("error" in permission && permission.error.code).toBe("permission_denied");

    const timeout = await handleMacToolsRpcRequest({ request: { method: "reminders.open", id: 3 }, ...context });
    expect("error" in timeout && timeout.error.code).toBe("timeout");

    const invalidParams = await handleMacToolsRpcRequest({
      request: { method: "calendar.upcoming", id: 4, params: { days: 100 } },
      socketPath: "/tmp/test.sock",
      startedAtMs: Date.now(),
      calendarProvider: new CalendarProvider({ fetchCalendarEvents: async () => [] }),
      remindersProvider: new RemindersProvider({ fetchOpenReminders: async () => [] }),
    });
    expect("error" in invalidParams && invalidParams.error.code).toBe("invalid_params");
  });
});
