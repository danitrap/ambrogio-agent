import {
  MacToolsError,
  type PermissionState,
  type ReminderListDto,
  type ReminderItemDto,
  type RemindersCreateParams,
  type RemindersListsResult,
  type RemindersOpenParams,
  type RemindersOpenResult,
  type RemindersUpdateParams,
} from "../types";
import {
  deleteEkctlReminder,
  isPermissionDeniedErrorMessage,
  listEkctlCalendars,
  listEkctlRemindersByCalendar,
  showEkctlReminder,
  type EkctlReminder,
} from "./ekctl";
import { parseReminderTagClassification, replaceManagedTagsLine } from "./reminders-tags";
import { RemindersNativeWrite } from "./reminders-native-write";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COMPLETED_DAYS = 7;
const MAX_DAYS = 365;

type NativeReminderItem = {
  id: string;
  listName: string;
  title: string;
  dueAt: string | null;
  completedAt?: string | null;
  priority: number;
  isFlagged: boolean;
  notes?: string;
  tags?: string[];
};

type FetchRemindersArgs = {
  state: "open" | "completed";
  limit: number;
  includeNoDueDate: boolean;
};

type RemindersProviderDeps = {
  now?: () => Date;
  timeoutMs?: number;
  fetchOpenReminders?: (args: FetchRemindersArgs) => Promise<NativeReminderItem[]>;
  fetchReminderLists?: () => Promise<ReminderListDto[]>;
  getPermissionState?: () => Promise<PermissionState>;
  createReminder?: (params: { listName: string; title: string; dueAt: string | null; notes: string | null }) => Promise<string>;
  deleteReminder?: (id: string) => Promise<void>;
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

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MacToolsError("invalid_params", `${field} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseReminderState(value: unknown): "open" | "completed" {
  if (value === undefined) {
    return "open";
  }
  if (value === "open" || value === "completed") {
    return value;
  }
  throw new MacToolsError("invalid_params", "state must be 'open' or 'completed'.");
}

function parseOptionalIso(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new MacToolsError("invalid_params", `${field} must be an ISO date string or null.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MacToolsError("invalid_params", `${field} must be a valid ISO date string.`);
  }
  return parsed.toISOString();
}

function parseManagedTag(value: unknown, field: string): "#next" | "#waiting" | "#someday" | "#tickler" | "#personal" | "#work" | "#home" | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new MacToolsError("invalid_params", `${field} must be a string or null.`);
  }
  const normalized = value.trim().toLowerCase();
  const allowed = new Set(["#next", "#waiting", "#someday", "#tickler", "#personal", "#work", "#home"]);
  if (!allowed.has(normalized)) {
    throw new MacToolsError("invalid_params", `${field} has an unsupported value.`);
  }
  return normalized as "#next" | "#waiting" | "#someday" | "#tickler" | "#personal" | "#work" | "#home";
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new MacToolsError("invalid_params", `${field} must be an array of strings.`);
  }
  const tags = value.map((item) => {
    if (typeof item !== "string") {
      throw new MacToolsError("invalid_params", `${field} must be an array of strings.`);
    }
    return item;
  });
  return tags;
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapReminderItem(item: NativeReminderItem, generatedAtEpochMs: number): ReminderItemDto {
  const title = String(item.title || "(untitled)");
  const dueAt = toIsoOrNull(item.dueAt);
  const dueAtEpochMs = dueAt ? Date.parse(dueAt) : null;
  const completedAt = toIsoOrNull(item.completedAt);
  const completedAtEpochMs = completedAt ? Date.parse(completedAt) : null;
  const dueInMinutes = dueAtEpochMs === null ? null : Math.trunc((dueAtEpochMs - generatedAtEpochMs) / 60_000);
  const classification = parseReminderTagClassification(title, item.notes, item.tags);

  return {
    id: String(item.id),
    listName: String(item.listName || "Unknown"),
    title,
    dueAt,
    dueAtEpochMs,
    dueInMinutes,
    completedAt,
    completedAtEpochMs,
    isOverdue: dueInMinutes !== null && dueInMinutes < 0,
    priority: Number.isFinite(item.priority) ? item.priority : 0,
    isFlagged: Boolean(item.isFlagged),
    tags: classification.tags,
    statusTag: (classification.statusTag as ReminderItemDto["statusTag"]) ?? null,
    areaTag: (classification.areaTag as ReminderItemDto["areaTag"]) ?? null,
    otherTags: classification.otherTags,
    notesFull: item.notes?.length ? item.notes : null,
  };
}

function compareOpenReminders(a: ReminderItemDto, b: ReminderItemDto): number {
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

function compareCompletedReminders(a: ReminderItemDto, b: ReminderItemDto): number {
  const aCompleted = a.completedAt ? Date.parse(a.completedAt) : Number.NEGATIVE_INFINITY;
  const bCompleted = b.completedAt ? Date.parse(b.completedAt) : Number.NEGATIVE_INFINITY;
  if (aCompleted !== bCompleted) {
    return bCompleted - aCompleted;
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
  return {
    id: String(reminder.id),
    listName: String(reminder.list?.title || "Unknown"),
    title: String(reminder.title || "(untitled)"),
    dueAt: toIsoOrNull(reminder.dueDate),
    completedAt: toIsoOrNull(reminder.completionDate),
    priority: Number.isFinite(reminder.priority) ? Number(reminder.priority) : 0,
    isFlagged: Number(reminder.priority ?? 0) >= 9,
    notes,
  };
}

async function fetchRemindersWithEkctl(args: FetchRemindersArgs): Promise<NativeReminderItem[]> {
  const calendars = await listEkctlCalendars(DEFAULT_TIMEOUT_MS);
  const reminderCalendars = calendars.filter((calendar) => calendar.type === "reminder");

  const responses = await Promise.all(
    reminderCalendars.map(async (calendar) => {
      return await listEkctlRemindersByCalendar({
        calendarId: calendar.id,
        includeCompleted: args.state === "completed",
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }),
  );

  const merged: NativeReminderItem[] = [];
  for (const reminders of responses) {
    for (const reminder of reminders) {
      if (args.state === "open" && reminder.isCompleted) {
        continue;
      }
      if (args.state === "completed" && !reminder.isCompleted) {
        continue;
      }
      const enriched = args.state === "completed" && !reminder.completionDate
        ? await showEkctlReminder(String(reminder.id), DEFAULT_TIMEOUT_MS)
        : null;
      const mapped = toNativeReminder(enriched ?? reminder);
      if (args.state === "open" && !args.includeNoDueDate && mapped.dueAt === null) {
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

async function fetchReminderListsWithEkctl(): Promise<ReminderListDto[]> {
  const calendars = await listEkctlCalendars(DEFAULT_TIMEOUT_MS);
  return calendars
    .filter((calendar) => calendar.type === "reminder")
    .map((calendar) => ({
      id: String(calendar.id),
      name: String(calendar.title || "Unknown"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
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

function buildManagedNotes(params: {
  notes: string | null | undefined;
  statusTag?: string | null;
  areaTag?: string | null;
  otherTags?: string[] | undefined;
}): string | null {
  const tags = [params.statusTag, params.areaTag, ...(params.otherTags ?? [])].filter((tag): tag is string => Boolean(tag));
  if (tags.length === 0) {
    return params.notes?.trim() ? params.notes.trim() : null;
  }
  return replaceManagedTagsLine(params.notes ?? undefined, tags);
}

export class RemindersProvider {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchRemindersImpl: (args: FetchRemindersArgs) => Promise<NativeReminderItem[]>;
  private readonly fetchReminderListsImpl: () => Promise<ReminderListDto[]>;
  private readonly getPermissionStateImpl: () => Promise<PermissionState>;
  private readonly createReminderImpl: (params: { listName: string; title: string; dueAt: string | null; notes: string | null }) => Promise<string>;
  private readonly deleteReminderImpl: (id: string) => Promise<void>;

  constructor(deps: RemindersProviderDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    const timeoutFromEnv = Number(process.env.AMBROGIO_MAC_TOOLS_PROVIDER_TIMEOUT_MS ?? "");
    this.timeoutMs = deps.timeoutMs ?? (Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? timeoutFromEnv : DEFAULT_TIMEOUT_MS);
    const nativeWrite = new RemindersNativeWrite({ timeoutMs: this.timeoutMs });
    this.fetchRemindersImpl = deps.fetchOpenReminders ?? fetchRemindersWithEkctl;
    this.fetchReminderListsImpl = deps.fetchReminderLists ?? fetchReminderListsWithEkctl;
    this.getPermissionStateImpl = deps.getPermissionState ?? getRemindersPermissionStateDefault;
    this.createReminderImpl = deps.createReminder ?? ((params) => nativeWrite.createReminder(params));
    this.deleteReminderImpl = deps.deleteReminder ?? ((id) => deleteEkctlReminder(id, this.timeoutMs));
  }

  async getPermissionState(): Promise<PermissionState> {
    return await this.getPermissionStateImpl();
  }

  async getLists(): Promise<RemindersListsResult> {
    const generatedAt = this.now();
    const generatedAtEpochMs = generatedAt.getTime();
    try {
      const lists = await withTimeout(this.fetchReminderListsImpl(), this.timeoutMs);
      return {
        generatedAt: generatedAt.toISOString(),
        generatedAtEpochMs,
        lists,
        count: lists.length,
      };
    } catch (error) {
      mapProviderError(error);
    }
  }

  async getOpen(rawParams: RemindersOpenParams | undefined): Promise<RemindersOpenResult> {
    const params = rawParams ?? {};
    const state = parseReminderState(params.state);
    const limit = parseBoundedInteger(params.limit, DEFAULT_LIMIT, "limit", 1, MAX_LIMIT);
    const includeNoDueDate = parseBoolean(params.includeNoDueDate, true, "includeNoDueDate");
    const tag = parseOptionalString(params.tag, "tag")?.replace(/^@/, "#").toLowerCase();
    const listName = parseOptionalString(params.listName, "listName");
    const days = parseBoundedInteger(params.days, DEFAULT_COMPLETED_DAYS, "days", 1, MAX_DAYS);
    const generatedAt = this.now();
    const generatedAtEpochMs = generatedAt.getTime();
    const timezone = resolveSystemTimezone();

    try {
      const reminders = await withTimeout(this.fetchRemindersImpl({ state, limit, includeNoDueDate }), this.timeoutMs);
      const completedThresholdMs = generatedAtEpochMs - (days * 24 * 60 * 60 * 1000);
      const mapped = reminders
        .map((item) => mapReminderItem(item, generatedAtEpochMs))
        .filter((item) => !tag || item.tags.includes(tag))
        .filter((item) => !listName || item.listName.localeCompare(listName, "en", { sensitivity: "accent" }) === 0)
        .filter((item) => {
          if (state !== "completed") {
            return includeNoDueDate || item.dueAt !== null;
          }
          return item.completedAtEpochMs !== null && item.completedAtEpochMs >= completedThresholdMs;
        })
        .sort(state === "completed" ? compareCompletedReminders : compareOpenReminders)
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

  async create(rawParams: RemindersCreateParams): Promise<ReminderItemDto> {
    const listName = parseOptionalString(rawParams.listName, "listName");
    const title = parseOptionalString(rawParams.title, "title");
    if (!listName || !title) {
      throw new MacToolsError("invalid_params", "listName and title are required.");
    }
    const dueAt = parseOptionalIso(rawParams.dueAt, "dueAt");
    const statusTag = parseManagedTag(rawParams.statusTag, "statusTag");
    const areaTag = parseManagedTag(rawParams.areaTag, "areaTag");
    const otherTags = parseStringArray(rawParams.otherTags, "otherTags");
    const notes = typeof rawParams.notes === "string" || rawParams.notes === null ? rawParams.notes : undefined;
    const notesFull = buildManagedNotes({ notes, statusTag, areaTag, otherTags });

    try {
      const id = await withTimeout(this.createReminderImpl({ listName, title, dueAt: dueAt ?? null, notes: notesFull }), this.timeoutMs);
      return mapReminderItem({
        id,
        listName,
        title,
        dueAt: dueAt ?? null,
        priority: 0,
        isFlagged: false,
        notes: notesFull ?? undefined,
      }, this.now().getTime());
    } catch (error) {
      mapProviderError(error);
    }
  }

  async update(rawParams: RemindersUpdateParams): Promise<ReminderItemDto> {
    const id = parseOptionalString(rawParams.id, "id");
    if (!id) {
      throw new MacToolsError("invalid_params", "id is required.");
    }
    const dueAt = parseOptionalIso(rawParams.dueAt, "dueAt");
    const statusTag = parseManagedTag(rawParams.statusTag, "statusTag");
    const areaTag = parseManagedTag(rawParams.areaTag, "areaTag");
    const otherTags = parseStringArray(rawParams.otherTags, "otherTags");
    const notesMode = rawParams.notesMode ?? "replace_managed_tags";
    if (!["preserve", "replace_managed_tags"].includes(notesMode)) {
      throw new MacToolsError("invalid_params", "notesMode has an unsupported value.");
    }
    const existing = (await this.getOpen({ limit: MAX_LIMIT, includeNoDueDate: true })).items.find((item) => item.id === id);
    if (!existing) {
      throw new MacToolsError("invalid_params", `Reminder not found: ${id}`);
    }
    const notes = notesMode === "preserve"
      ? existing.notesFull
      : buildManagedNotes({
        notes: existing.notesFull,
        statusTag: statusTag === undefined ? existing.statusTag : statusTag,
        areaTag: areaTag === undefined ? existing.areaTag : areaTag,
        otherTags: otherTags === undefined ? existing.otherTags : otherTags,
      });

    try {
      const replacementId = await withTimeout(this.createReminderImpl({
        listName: existing.listName,
        title: existing.title,
        dueAt: dueAt === undefined ? existing.dueAt : dueAt,
        notes,
      }), this.timeoutMs);
      await withTimeout(this.deleteReminderImpl(id), this.timeoutMs);
      return mapReminderItem({
        id: replacementId,
        listName: existing.listName,
        title: existing.title,
        dueAt: dueAt === undefined ? existing.dueAt : dueAt,
        completedAt: existing.completedAt,
        priority: existing.priority,
        isFlagged: existing.isFlagged,
        notes: notes ?? undefined,
      }, this.now().getTime());
    } catch (error) {
      mapProviderError(error);
    }
  }
}

export {
  compareCompletedReminders,
  compareOpenReminders,
  mapReminderItem,
};

export type {
  FetchRemindersArgs,
  NativeReminderItem,
  RemindersProviderDeps,
};
