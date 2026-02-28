import {
  type CalendarEventDto,
  type CalendarUpcomingParams,
  type CalendarUpcomingResult,
  MacToolsError,
  type PermissionState,
} from "../types";
import {
  isPermissionDeniedErrorMessage,
  listEkctlCalendars,
  listEkctlEventsByCalendar,
  type EkctlEvent,
} from "./ekctl";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const NOTES_PREVIEW_MAX = 240;

type NativeCalendarEvent = {
  id: string;
  calendarName: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  location?: string;
  notes?: string;
};

type FetchCalendarEventsArgs = {
  from: Date;
  to: Date;
  timezone: string;
  limit: number;
};

type CalendarProviderDeps = {
  now?: () => Date;
  timeoutMs?: number;
  fetchCalendarEvents?: (args: FetchCalendarEventsArgs) => Promise<NativeCalendarEvent[]>;
  getPermissionState?: () => Promise<PermissionState>;
};

function parseBoundedInteger(value: unknown, fallback: number, field: string, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MacToolsError("invalid_params", `${field} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new MacToolsError("invalid_params", `${field} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseTimezone(value: unknown): string {
  if (value === undefined) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MacToolsError("invalid_params", "timezone must be a non-empty string.");
  }
  return value.trim();
}

function normalizeNotesPreview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length <= NOTES_PREVIEW_MAX) {
    return normalized;
  }
  return `${normalized.slice(0, NOTES_PREVIEW_MAX - 3)}...`;
}

function formatLocalCalendarParts(input: Date, timezone: string): {
  date: string;
  time: string;
  weekday: string;
} {
  const formatter = new Intl.DateTimeFormat("it-IT", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const byType = new Map(formatter.formatToParts(input).map((part) => [part.type, part.value]));
  const year = byType.get("year");
  const month = byType.get("month");
  const day = byType.get("day");
  const hour = byType.get("hour");
  const minute = byType.get("minute");
  const weekday = byType.get("weekday");
  if (!year || !month || !day || !hour || !minute || !weekday) {
    throw new MacToolsError("internal_error", `Unable to format calendar event in timezone ${timezone}.`);
  }
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    weekday,
  };
}

function mapCalendarEvent(event: NativeCalendarEvent, nowEpochMs: number, timezone: string): CalendarEventDto | null {
  const startAtDate = new Date(event.startAt);
  const endAtDate = new Date(event.endAt);
  const startAtEpochMs = startAtDate.getTime();
  const endAtEpochMs = endAtDate.getTime();
  if (!Number.isFinite(startAtEpochMs) || !Number.isFinite(endAtEpochMs)) {
    return null;
  }
  const isStarted = startAtEpochMs <= nowEpochMs;
  const isEnded = endAtEpochMs < nowEpochMs;
  const startLocal = formatLocalCalendarParts(startAtDate, timezone);
  const endLocal = formatLocalCalendarParts(endAtDate, timezone);

  return {
    id: String(event.id),
    calendarName: String(event.calendarName || "Unknown"),
    title: String(event.title || "(untitled)"),
    startAt: new Date(startAtEpochMs).toISOString(),
    endAt: new Date(endAtEpochMs).toISOString(),
    startLocalDate: startLocal.date,
    startLocalTime: startLocal.time,
    startWeekday: startLocal.weekday,
    endLocalDate: endLocal.date,
    endLocalTime: endLocal.time,
    startAtEpochMs,
    endAtEpochMs,
    startInMinutes: Math.trunc((startAtEpochMs - nowEpochMs) / 60_000),
    endInMinutes: Math.trunc((endAtEpochMs - nowEpochMs) / 60_000),
    isStarted,
    isEnded,
    isOngoing: isStarted && !isEnded,
    allDay: Boolean(event.allDay),
    location: event.location?.trim() || undefined,
    notesPreview: normalizeNotesPreview(event.notes),
  };
}

function mapProviderError(error: unknown): never {
  if (error instanceof MacToolsError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isPermissionDeniedErrorMessage(message)) {
    throw new MacToolsError(
      "permission_denied",
      "Calendar access not granted.",
      {
        service: "calendar",
        instructions: [
          "Open System Settings > Privacy & Security > Calendars",
          "Enable access for your terminal or Ambrogio process",
          "Retry the command",
        ],
      },
    );
  }
  throw new MacToolsError("internal_error", message);
}

async function withTimeout<T>(input: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new MacToolsError("timeout", `Calendar provider timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([input, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toNativeEvent(event: EkctlEvent): NativeCalendarEvent | null {
  if (!event.startDate || !event.endDate) {
    return null;
  }
  return {
    id: String(event.id),
    calendarName: String(event.calendar?.title || "Unknown"),
    title: String(event.title || "(untitled)"),
    startAt: event.startDate,
    endAt: event.endDate,
    allDay: Boolean(event.allDay),
    location: event.location || undefined,
    notes: event.notes || undefined,
  };
}

async function fetchCalendarEventsWithEkctl(args: FetchCalendarEventsArgs): Promise<NativeCalendarEvent[]> {
  const calendars = await listEkctlCalendars(DEFAULT_TIMEOUT_MS);
  const eventCalendars = calendars.filter((calendar) => calendar.type === "event");

  const responses = await Promise.all(
    eventCalendars.map(async (calendar) => {
      return await listEkctlEventsByCalendar({
        calendarId: calendar.id,
        fromIso: args.from.toISOString(),
        toIso: args.to.toISOString(),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }),
  );

  const merged: NativeCalendarEvent[] = [];
  for (const events of responses) {
    for (const event of events) {
      const mapped = toNativeEvent(event);
      if (mapped) {
        merged.push(mapped);
      }
      if (merged.length >= args.limit) {
        return merged;
      }
    }
  }
  return merged;
}

async function getCalendarPermissionStateDefault(): Promise<PermissionState> {
  try {
    await listEkctlCalendars(5000);
    return "authorized";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isPermissionDeniedErrorMessage(message)) {
      return "denied";
    }
    return "not_determined";
  }
}

export class CalendarProvider {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchCalendarEvents: (args: FetchCalendarEventsArgs) => Promise<NativeCalendarEvent[]>;
  private readonly getPermissionStateImpl: () => Promise<PermissionState>;

  constructor(deps: CalendarProviderDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    const timeoutFromEnv = Number(process.env.AMBROGIO_MAC_TOOLS_PROVIDER_TIMEOUT_MS ?? "");
    this.timeoutMs = deps.timeoutMs ?? (Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? timeoutFromEnv : DEFAULT_TIMEOUT_MS);
    this.fetchCalendarEvents = deps.fetchCalendarEvents ?? fetchCalendarEventsWithEkctl;
    this.getPermissionStateImpl = deps.getPermissionState ?? getCalendarPermissionStateDefault;
  }

  async getPermissionState(): Promise<PermissionState> {
    return await this.getPermissionStateImpl();
  }

  async getUpcoming(rawParams: CalendarUpcomingParams | undefined): Promise<CalendarUpcomingResult> {
    const params = rawParams ?? {};
    const days = parseBoundedInteger(params.days, DEFAULT_DAYS, "days", 1, MAX_DAYS);
    const limit = parseBoundedInteger(params.limit, DEFAULT_LIMIT, "limit", 1, MAX_LIMIT);
    const timezone = parseTimezone(params.timezone);
    const from = this.now();
    const generatedAtEpochMs = from.getTime();
    const to = new Date(from.getTime() + (days * 24 * 60 * 60 * 1000));

    try {
      const native = await withTimeout(this.fetchCalendarEvents({ from, to, timezone, limit }), this.timeoutMs);
      const mapped = native
        .map((event) => mapCalendarEvent(event, generatedAtEpochMs, timezone))
        .filter((event): event is CalendarEventDto => event !== null)
        .sort((a, b) => a.startAtEpochMs - b.startAtEpochMs)
        .slice(0, limit);

      return {
        generatedAtEpochMs,
        window: {
          from: from.toISOString(),
          to: to.toISOString(),
          timezone,
        },
        events: mapped,
        count: mapped.length,
      };
    } catch (error) {
      mapProviderError(error);
    }
  }
}

export type { CalendarProviderDeps, NativeCalendarEvent, FetchCalendarEventsArgs };
