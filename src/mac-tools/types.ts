export type MacToolsRpcErrorCode =
  | "permission_denied"
  | "invalid_params"
  | "timeout"
  | "internal_error"
  | "method_not_found";

export type RpcId = string | number | null;

export type RpcRequest<TParams = unknown> = {
  jsonrpc?: "2.0";
  id?: RpcId;
  method?: string;
  params?: TParams;
};

export type RpcSuccess<TResult> = {
  jsonrpc: "2.0";
  id: RpcId;
  result: TResult;
};

export type RpcError = {
  jsonrpc: "2.0";
  id: RpcId;
  error: {
    code: MacToolsRpcErrorCode;
    message: string;
    data?: Record<string, unknown>;
  };
};

export type RpcResponse<TResult = unknown> = RpcSuccess<TResult> | RpcError;

export type PermissionState = "authorized" | "denied" | "not_determined" | "restricted";

export type SystemPingResult = {
  ok: true;
  service: "mac-tools-service";
  version: string;
};

export type SystemInfoResult = {
  service: "mac-tools-service";
  version: string;
  uptimeMs: number;
  socketPath: string;
  permissions: {
    calendar: PermissionState;
    reminders: PermissionState;
  };
};

export type CalendarUpcomingParams = {
  days?: number;
  limit?: number;
  timezone?: string;
};

export type CalendarEventDto = {
  id: string;
  calendarName: string;
  title: string;
  startAt: string;
  endAt: string;
  startLocalDate: string;
  startLocalTime: string;
  startWeekday: string;
  endLocalDate: string;
  endLocalTime: string;
  startAtEpochMs: number;
  endAtEpochMs: number;
  startInMinutes: number;
  endInMinutes: number;
  isStarted: boolean;
  isEnded: boolean;
  isOngoing: boolean;
  allDay: boolean;
  location?: string;
  notesPreview?: string;
};

export type CalendarUpcomingResult = {
  generatedAtEpochMs: number;
  window: {
    from: string;
    to: string;
    timezone: string;
  };
  events: CalendarEventDto[];
  count: number;
};

export type RemindersOpenParams = {
  limit?: number;
  includeNoDueDate?: boolean;
  tag?: string;
  listName?: string;
  state?: "open" | "completed";
  days?: number;
};

export type ReminderItemDto = {
  id: string;
  listName: string;
  title: string;
  dueAt: string | null;
  dueAtEpochMs: number | null;
  dueInMinutes: number | null;
  completedAt: string | null;
  completedAtEpochMs: number | null;
  isOverdue: boolean;
  priority: number;
  isFlagged: boolean;
  tags: string[];
  statusTag: "#next" | "#waiting" | "#someday" | "#tickler" | null;
  areaTag: "#personal" | "#work" | "#home" | null;
  otherTags: string[];
  notesFull: string | null;
};

export type RemindersOpenResult = {
  generatedAt: string;
  generatedAtEpochMs: number;
  timezone: string;
  items: ReminderItemDto[];
  count: number;
};

export type ReminderListDto = {
  id: string;
  name: string;
};

export type RemindersListsResult = {
  generatedAt: string;
  generatedAtEpochMs: number;
  lists: ReminderListDto[];
  count: number;
};

export type RemindersCreateParams = {
  listName: string;
  title: string;
  dueAt?: string | null;
  statusTag?: "#next" | "#waiting" | "#someday" | "#tickler" | null;
  areaTag?: "#personal" | "#work" | "#home" | null;
  otherTags?: string[];
  notes?: string | null;
};

export type RemindersUpdateParams = {
  id: string;
  dueAt?: string | null;
  statusTag?: "#next" | "#waiting" | "#someday" | "#tickler" | null;
  areaTag?: "#personal" | "#work" | "#home" | null;
  otherTags?: string[];
  notesMode?: "preserve" | "replace_managed_tags";
};

export class MacToolsError extends Error {
  readonly code: MacToolsRpcErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: MacToolsRpcErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "MacToolsError";
    this.code = code;
    this.data = data;
  }
}
