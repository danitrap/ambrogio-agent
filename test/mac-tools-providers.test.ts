import { describe, expect, test } from "bun:test";
import { CalendarProvider } from "../src/mac-tools/providers/calendar-provider";
import { RemindersProvider } from "../src/mac-tools/providers/reminders-provider";
import { MacToolsError } from "../src/mac-tools/types";

describe("CalendarProvider", () => {
  test("applies defaults and bounds validation", async () => {
    const provider = new CalendarProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchCalendarEvents: async () => [],
    });

    const result = await provider.getUpcoming(undefined);
    expect(result.window.from).toBe("2026-02-23T10:00:00.000Z");
    expect(result.window.to).toBe("2026-03-02T10:00:00.000Z");
    expect(result.count).toBe(0);

    await expect(provider.getUpcoming({ days: 31 })).rejects.toMatchObject({
      code: "invalid_params",
    } satisfies Partial<MacToolsError>);
    await expect(provider.getUpcoming({ limit: 501 })).rejects.toMatchObject({
      code: "invalid_params",
    } satisfies Partial<MacToolsError>);
  });

  test("maps and sorts upcoming events", async () => {
    const provider = new CalendarProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchCalendarEvents: async () => [
        {
          id: "2",
          calendarName: "Personal",
          title: "Zeta",
          startAt: "2026-02-24T15:00:00.000Z",
          endAt: "2026-02-24T16:00:00.000Z",
          allDay: false,
          notes: "  review   items  ",
        },
        {
          id: "1",
          calendarName: "Work",
          title: "Alpha",
          startAt: "2026-02-23T12:00:00.000Z",
          endAt: "2026-02-23T12:30:00.000Z",
          allDay: false,
          location: "HQ",
        },
      ],
    });

    const result = await provider.getUpcoming({ days: 2, limit: 10, timezone: "Europe/Rome" });
    expect(result.events[0]?.id).toBe("1");
    expect(result.events[1]?.notesPreview).toBe("review items");
    expect(result.window.timezone).toBe("Europe/Rome");
    expect(result.generatedAtEpochMs).toBe(Date.parse("2026-02-23T10:00:00.000Z"));
    expect(result.events[0]).toMatchObject({
      startAtEpochMs: Date.parse("2026-02-23T12:00:00.000Z"),
      endAtEpochMs: Date.parse("2026-02-23T12:30:00.000Z"),
      startInMinutes: 120,
      endInMinutes: 150,
      isStarted: false,
      isEnded: false,
      isOngoing: false,
    });
  });

  test("computes relative calendar status flags", async () => {
    const provider = new CalendarProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchCalendarEvents: async () => [
        {
          id: "future",
          calendarName: "Work",
          title: "Future event",
          startAt: "2026-02-23T11:00:00.000Z",
          endAt: "2026-02-23T11:30:00.000Z",
          allDay: false,
        },
        {
          id: "ongoing",
          calendarName: "Work",
          title: "Ongoing event",
          startAt: "2026-02-23T09:30:00.000Z",
          endAt: "2026-02-23T10:30:00.000Z",
          allDay: false,
        },
        {
          id: "past",
          calendarName: "Work",
          title: "Past event",
          startAt: "2026-02-23T08:00:00.000Z",
          endAt: "2026-02-23T09:00:00.000Z",
          allDay: false,
        },
      ],
    });

    const result = await provider.getUpcoming({ days: 1, limit: 10, timezone: "Europe/Rome" });
    const byId = new Map(result.events.map((event) => [event.id, event]));
    expect(byId.get("future")).toMatchObject({
      startInMinutes: 60,
      isStarted: false,
      isEnded: false,
      isOngoing: false,
    });
    expect(byId.get("ongoing")).toMatchObject({
      startInMinutes: -30,
      endInMinutes: 30,
      isStarted: true,
      isEnded: false,
      isOngoing: true,
    });
    expect(byId.get("past")).toMatchObject({
      endInMinutes: -60,
      isStarted: true,
      isEnded: true,
      isOngoing: false,
    });
  });
});

describe("RemindersProvider", () => {
  test("lists reminder lists from the provider", async () => {
    const provider = new RemindersProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchReminderLists: async () => [
        { id: "2", name: "Promemoria" },
        { id: "1", name: "Inbox" },
      ],
    });

    const result = await provider.getLists();
    expect(result).toMatchObject({
      generatedAt: "2026-02-23T10:00:00.000Z",
      generatedAtEpochMs: Date.parse("2026-02-23T10:00:00.000Z"),
      count: 2,
    });
    expect(result.lists).toEqual([
      { id: "2", name: "Promemoria" },
      { id: "1", name: "Inbox" },
    ]);
  });

  test("extracts canonical tags, exposes notesFull, filters, and supports no-due-date behavior", async () => {
    const provider = new RemindersProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchOpenReminders: async () => [
        {
          id: "a",
          listName: "Inbox",
          title: "Call supplier @calls",
          dueAt: "2026-02-24T08:00:00.000Z",
          priority: 1,
          isFlagged: false,
          notes: "details @next",
        },
        {
          id: "b",
          listName: "Inbox",
          title: "Flagged item",
          dueAt: "2026-02-24T08:00:00.000Z",
          priority: 9,
          isFlagged: true,
        },
        {
          id: "c",
          listName: "Someday",
          title: "No due",
          dueAt: null,
          priority: 0,
          isFlagged: false,
        },
      ],
    });

    const withNoDue = await provider.getOpen({ includeNoDueDate: true, limit: 10 });
    expect(withNoDue.items.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(withNoDue.items[1]?.tags).toEqual(["#calls", "#next"]);
    expect(withNoDue.items[1]?.statusTag).toBe("#next");
    expect(withNoDue.items[1]?.notesFull).toBe("details @next");
    expect(typeof withNoDue.timezone).toBe("string");
    expect(withNoDue.timezone.length).toBeGreaterThan(0);
    expect(withNoDue.generatedAtEpochMs).toBe(Date.parse("2026-02-23T10:00:00.000Z"));
    expect(withNoDue.items[2]).toMatchObject({
      dueAtEpochMs: null,
      dueInMinutes: null,
      isOverdue: false,
    });

    const withoutNoDue = await provider.getOpen({ includeNoDueDate: false, limit: 10 });
    expect(withoutNoDue.items.map((item) => item.id)).toEqual(["b", "a"]);

    const filteredByTag = await provider.getOpen({ limit: 10, tag: "#next" });
    expect(filteredByTag.items.map((item) => item.id)).toEqual(["a"]);

    const filteredByList = await provider.getOpen({ limit: 10, listName: "someday" });
    expect(filteredByList.items.map((item) => item.id)).toEqual(["c"]);
  });

  test("computes due-in and overdue reminder fields", async () => {
    const provider = new RemindersProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchOpenReminders: async () => [
        {
          id: "future",
          listName: "Inbox",
          title: "Due soon",
          dueAt: "2026-02-23T11:00:00.000Z",
          priority: 1,
          isFlagged: false,
        },
        {
          id: "overdue",
          listName: "Inbox",
          title: "Past due",
          dueAt: "2026-02-23T09:00:00.000Z",
          priority: 1,
          isFlagged: false,
        },
      ],
    });

    const result = await provider.getOpen({ includeNoDueDate: true, limit: 10 });
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get("future")).toMatchObject({
      dueInMinutes: 60,
      isOverdue: false,
    });
    expect(byId.get("overdue")).toMatchObject({
      dueInMinutes: -60,
      isOverdue: true,
    });
  });

  test("validates params and maps permission errors", async () => {
    const provider = new RemindersProvider({
      fetchOpenReminders: async () => {
        throw new Error("Not authorized to send Apple events to Reminders. (-1743)");
      },
    });

    await expect(provider.getOpen({ limit: 0 })).rejects.toMatchObject({
      code: "invalid_params",
    } satisfies Partial<MacToolsError>);

    await expect(provider.getOpen({ limit: 10 })).rejects.toMatchObject({
      code: "permission_denied",
      data: { service: "reminders" },
    } satisfies Partial<MacToolsError>);
  });

  test("supports completed reminders with a default 7 day window", async () => {
    const provider = new RemindersProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchOpenReminders: async ({ state }) => {
        if (state === "completed") {
          return [
            {
              id: "recent",
              listName: "Inbox",
              title: "Done #next",
              dueAt: null,
              completedAt: "2026-02-22T08:00:00.000Z",
              priority: 0,
              isFlagged: false,
              notes: "finished",
            },
            {
              id: "old",
              listName: "Inbox",
              title: "Old done",
              dueAt: null,
              completedAt: "2026-02-10T08:00:00.000Z",
              priority: 0,
              isFlagged: false,
            },
          ];
        }
        return [];
      },
    });

    const result = await provider.getOpen({ state: "completed", limit: 10 });
    expect(result.items.map((item) => item.id)).toEqual(["recent"]);
    expect(result.items[0]).toMatchObject({
      completedAt: "2026-02-22T08:00:00.000Z",
      tags: ["#next"],
      notesFull: "finished",
    });
  });

  test("update replaces reminder and returns the replacement item", async () => {
    const provider = new RemindersProvider({
      now: () => new Date("2026-02-23T10:00:00.000Z"),
      fetchOpenReminders: async () => [{
        id: "old-id",
        listName: "Inbox",
        title: "Replace me",
        dueAt: null,
        priority: 0,
        isFlagged: false,
        notes: "context\n\nambrogio-tags: #next #personal",
      }],
      createReminder: async () => "new-id",
      deleteReminder: async () => {},
    });

    const updated = await provider.update({ id: "old-id", statusTag: "#waiting", areaTag: "#home", otherTags: ["#smoke"] });
    expect(updated).toMatchObject({
      id: "new-id",
      tags: ["#waiting", "#home", "#smoke"],
      statusTag: "#waiting",
      areaTag: "#home",
      otherTags: ["#smoke"],
    });
  });
});
