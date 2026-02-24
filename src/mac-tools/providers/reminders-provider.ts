import {
  MacToolsError,
  type PermissionState,
  type ReminderItemDto,
  type RemindersOpenParams,
  type RemindersOpenResult,
} from "../types";
import {
  isPermissionDeniedErrorMessage,
  listEkctlCalendars,
  listEkctlRemindersByCalendar,
  type EkctlReminder,
} from "./ekctl";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const NOTES_PREVIEW_MAX = 240;

type NativeReminderItem = {
  id: string;
  listName: string;
  title: string;
  dueAt: string | null;
  priority: number;
  isFlagged: boolean;
  notes?: string;
  tags?: string[];
};

type FetchOpenRemindersArgs = {
  limit: number;
  includeNoDueDate: boolean;
};

type RemindersProviderDeps = {
  now?: () => Date;
  timeoutMs?: number;
  fetchOpenReminders?: (args: FetchOpenRemindersArgs) => Promise<NativeReminderItem[]>;
  getPermissionState?: () => Promise<PermissionState>;
};

function resolveSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

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

function parseBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new MacToolsError("invalid_params", `${field} must be a boolean.`);
  }
  return value;
}

function extractTags(title: string, notes: string | undefined, incomingTags: string[] | undefined): string[] {
  const explicit = Array.isArray(incomingTags)
    ? incomingTags.filter((tag) => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim().toLowerCase())
    : [];
  const fromTitle = title.match(/@[\w-]+/g)?.map((tag) => tag.toLowerCase()) ?? [];
  const fromNotes = notes?.match(/@[\w-]+/g)?.map((tag) => tag.toLowerCase()) ?? [];
  return [...new Set([...explicit, ...fromTitle, ...fromNotes])];
}

function normalizeNotesPreview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= NOTES_PREVIEW_MAX) {
    return normalized;
  }
  return `${normalized.slice(0, NOTES_PREVIEW_MAX - 3)}...`;
}

function mapReminderItem(item: NativeReminderItem, generatedAtEpochMs: number): ReminderItemDto {
  const notesPreview = normalizeNotesPreview(item.notes);
  const title = String(item.title || "(untitled)");
  const dueAtDate = item.dueAt ? new Date(item.dueAt) : null;
  const dueAtEpochMs = dueAtDate && Number.isFinite(dueAtDate.getTime()) ? dueAtDate.getTime() : null;
  const dueAt = dueAtEpochMs !== null ? new Date(dueAtEpochMs).toISOString() : null;
  const dueInMinutes = dueAtEpochMs === null ? null : Math.trunc((dueAtEpochMs - generatedAtEpochMs) / 60_000);

  return {
    id: String(item.id),
    listName: String(item.listName || "Unknown"),
    title,
    dueAt,
    dueAtEpochMs,
    dueInMinutes,
    isOverdue: dueInMinutes !== null && dueInMinutes < 0,
    priority: Number.isFinite(item.priority) ? item.priority : 0,
    isFlagged: Boolean(item.isFlagged),
    tags: extractTags(title, item.notes, item.tags),
    notesPreview,
  };
}

function compareReminders(a: ReminderItemDto, b: ReminderItemDto): number {
  const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) {
    return aDue - bDue;
  }
  if (a.isFlagged !== b.isFlagged) {
    return a.isFlagged ? -1 : 1;
  }
  return a.title.localeCompare(b.title, "en", { sensitivity: "base" });
}

function mapProviderError(error: unknown): never {
  if (error instanceof MacToolsError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isPermissionDeniedErrorMessage(message)) {
    throw new MacToolsError(
      "permission_denied",
      "Reminders access not granted.",
      {
        service: "reminders",
        instructions: [
          "Open System Settings > Privacy & Security > Reminders",
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
      reject(new MacToolsError("timeout", `Reminders provider timed out after ${timeoutMs}ms.`));
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

function toNativeReminder(reminder: EkctlReminder): NativeReminderItem {
  const notes = reminder.notes || undefined;
  const title = String(reminder.title || "(untitled)");
  const dueAt = reminder.dueDate ? new Date(reminder.dueDate).toISOString() : null;

  return {
    id: String(reminder.id),
    listName: String(reminder.list?.title || "Unknown"),
    title,
    dueAt,
    priority: Number.isFinite(reminder.priority) ? Number(reminder.priority) : 0,
    isFlagged: Number(reminder.priority ?? 0) >= 9,
    notes,
    tags: extractTags(title, notes, []),
  };
}

async function fetchOpenRemindersWithEkctl(args: FetchOpenRemindersArgs): Promise<NativeReminderItem[]> {
  const calendars = await listEkctlCalendars(DEFAULT_TIMEOUT_MS);
  const reminderCalendars = calendars.filter((calendar) => calendar.type === "reminder");

  const responses = await Promise.all(
    reminderCalendars.map(async (calendar) => {
      return await listEkctlRemindersByCalendar({
        calendarId: calendar.id,
        includeCompleted: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }),
  );

  const merged: NativeReminderItem[] = [];
  for (const reminders of responses) {
    for (const reminder of reminders) {
      if (reminder.isCompleted) {
        continue;
      }
      const mapped = toNativeReminder(reminder);
      if (!args.includeNoDueDate && mapped.dueAt === null) {
        continue;
      }
      merged.push(mapped);
      if (merged.length >= args.limit) {
        return merged;
      }
    }
  }

  return merged;
}

async function getRemindersPermissionStateDefault(): Promise<PermissionState> {
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

export class RemindersProvider {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchOpenRemindersImpl: (args: FetchOpenRemindersArgs) => Promise<NativeReminderItem[]>;
  private readonly getPermissionStateImpl: () => Promise<PermissionState>;

  constructor(deps: RemindersProviderDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    const timeoutFromEnv = Number(process.env.AMBROGIO_MAC_TOOLS_PROVIDER_TIMEOUT_MS ?? "");
    this.timeoutMs = deps.timeoutMs ?? (Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? timeoutFromEnv : DEFAULT_TIMEOUT_MS);
    this.fetchOpenRemindersImpl = deps.fetchOpenReminders ?? fetchOpenRemindersWithEkctl;
    this.getPermissionStateImpl = deps.getPermissionState ?? getRemindersPermissionStateDefault;
  }

  async getPermissionState(): Promise<PermissionState> {
    return await this.getPermissionStateImpl();
  }

  async getOpen(rawParams: RemindersOpenParams | undefined): Promise<RemindersOpenResult> {
    const params = rawParams ?? {};
    const limit = parseBoundedInteger(params.limit, DEFAULT_LIMIT, "limit", 1, MAX_LIMIT);
    const includeNoDueDate = parseBoolean(params.includeNoDueDate, true, "includeNoDueDate");
    const generatedAt = this.now();
    const generatedAtEpochMs = generatedAt.getTime();
    const timezone = resolveSystemTimezone();

    try {
      const reminders = await withTimeout(this.fetchOpenRemindersImpl({ limit, includeNoDueDate }), this.timeoutMs);
      const mapped = reminders
        .map((item) => mapReminderItem(item, generatedAtEpochMs))
        .filter((item) => includeNoDueDate || item.dueAt !== null)
        .sort(compareReminders)
        .slice(0, limit);

      return {
        generatedAt: generatedAt.toISOString(),
        generatedAtEpochMs,
        timezone,
        items: mapped,
        count: mapped.length,
      };
    } catch (error) {
      mapProviderError(error);
    }
  }
}

export {
  compareReminders,
  extractTags,
  mapReminderItem,
};

export type {
  RemindersProviderDeps,
  NativeReminderItem,
  FetchOpenRemindersArgs,
};
