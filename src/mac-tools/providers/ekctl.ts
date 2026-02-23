import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MacToolsError } from "../types";

const execFileAsync = promisify(execFile);

function normalizeMessage(error: unknown): string {
  if (!error) {
    return "unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function extractStdio(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
  const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  return `${stdout}\n${stderr}`.trim();
}

function isEkctlTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "ETIMEDOUT") {
    return true;
  }
  const killed = "killed" in error ? Boolean((error as { killed?: unknown }).killed) : false;
  const signal = "signal" in error ? String((error as { signal?: unknown }).signal ?? "") : "";
  return killed && signal === "SIGTERM";
}

export function isPermissionDeniedErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("access denied")
    || normalized.includes("not authorized")
    || normalized.includes("permission denied")
    || normalized.includes("not permitted")
    || normalized.includes("tcc")
    || normalized.includes("operation not permitted");
}

function parseJsonFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("ekctl returned empty JSON output.");
  }
  return JSON.parse(trimmed);
}

export async function runEkctlJson(args: string[], timeoutMs: number): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("ekctl", args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = parseJsonFromStdout(stdout) as { status?: string; error?: string };
    if (parsed && typeof parsed === "object" && parsed.status === "error") {
      throw new Error(parsed.error ?? "ekctl returned status=error");
    }
    return parsed;
  } catch (error) {
    mapEkctlExecutionError(error, timeoutMs);
  }
}

export function mapEkctlExecutionError(error: unknown, timeoutMs: number): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "ENOENT") {
      throw new MacToolsError("internal_error", "ekctl not found in PATH.", {
        instructions: [
          "Install ekctl from https://github.com/schappim/ekctl",
          "Ensure ekctl is available in PATH for the mac-tools host process",
          "Restart mac-tools:host",
        ],
      });
    }
  }

  if (isEkctlTimeoutError(error)) {
    throw new MacToolsError("timeout", `ekctl command timed out after ${timeoutMs}ms.`);
  }

  const message = `${normalizeMessage(error)}\n${extractStdio(error)}`.trim();
  throw new Error(message);
}

type EkctlCalendar = {
  id: string;
  title: string;
  type?: string;
};

type EkctlEvent = {
  id: string;
  title: string;
  startDate?: string;
  endDate?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  calendar?: {
    id?: string;
    title?: string;
  };
};

type EkctlReminder = {
  id: string;
  title: string;
  isCompleted?: boolean;
  priority?: number;
  dueDate?: string;
  notes?: string;
  list?: {
    id?: string;
    title?: string;
  };
};

export async function listEkctlCalendars(timeoutMs: number): Promise<EkctlCalendar[]> {
  const payload = await runEkctlJson(["list", "calendars"], timeoutMs) as { calendars?: EkctlCalendar[] };
  return Array.isArray(payload.calendars) ? payload.calendars : [];
}

export async function listEkctlEventsByCalendar(params: {
  calendarId: string;
  fromIso: string;
  toIso: string;
  timeoutMs: number;
}): Promise<EkctlEvent[]> {
  const normalizeIso = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  };
  const payload = await runEkctlJson(
    [
      "list",
      "events",
      "--calendar",
      params.calendarId,
      "--from",
      normalizeIso(params.fromIso),
      "--to",
      normalizeIso(params.toIso),
    ],
    params.timeoutMs,
  ) as { events?: EkctlEvent[] };
  return Array.isArray(payload.events) ? payload.events : [];
}

export async function listEkctlRemindersByCalendar(params: {
  calendarId: string;
  includeCompleted: boolean;
  timeoutMs: number;
}): Promise<EkctlReminder[]> {
  const payload = await runEkctlJson(
    ["list", "reminders", "--list", params.calendarId, "--completed", String(params.includeCompleted)],
    params.timeoutMs,
  ) as { reminders?: EkctlReminder[] };
  return Array.isArray(payload.reminders) ? payload.reminders : [];
}

export type {
  EkctlCalendar,
  EkctlEvent,
  EkctlReminder,
};
