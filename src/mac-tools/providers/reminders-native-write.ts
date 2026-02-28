import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MacToolsError } from "../types";

const execFileAsync = promisify(execFile);

type RunAppleScript = (script: string, timeoutMs: number) => Promise<string>;

function normalizeReminderId(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^x-apple-reminder:\/\//i, "");
}

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

async function runAppleScriptDefault(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function monthNameFromIndex(index: number): string {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][index] ?? "January";
}

function buildAppleScriptDateBlock(variableName: string, isoValue: string): string {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    throw new MacToolsError("invalid_params", "dueAt must be a valid ISO date string.");
  }
  const secondsSinceMidnight = (date.getHours() * 3600) + (date.getMinutes() * 60) + date.getSeconds();
  return [
    `set ${variableName} to (current date)`,
    `set year of ${variableName} to ${date.getFullYear()}`,
    `set month of ${variableName} to ${monthNameFromIndex(date.getMonth())}`,
    `set day of ${variableName} to ${date.getDate()}`,
    `set time of ${variableName} to ${secondsSinceMidnight}`,
  ].join("\n");
}

function mapAppleScriptError(error: unknown, service: "reminders" = "reminders"): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("not authorized") || message.toLowerCase().includes("not permitted")) {
    throw new MacToolsError("permission_denied", "Reminders access not granted.", {
      service,
      instructions: [
        "Open System Settings > Privacy & Security > Reminders",
        "Enable access for your terminal or Ambrogio process",
        "Retry the command",
      ],
    });
  }
  throw new MacToolsError("internal_error", message);
}

export type RemindersNativeWriteDeps = {
  runAppleScript?: RunAppleScript;
  timeoutMs?: number;
};

export class RemindersNativeWrite {
  private readonly runAppleScript: RunAppleScript;
  private readonly timeoutMs: number;

  constructor(deps: RemindersNativeWriteDeps = {}) {
    this.runAppleScript = deps.runAppleScript ?? runAppleScriptDefault;
    this.timeoutMs = deps.timeoutMs ?? 30_000;
  }

  async createReminder(params: {
    listName: string;
    title: string;
    dueAt: string | null;
    notes: string | null;
  }): Promise<string> {
    const dueDateClause = params.dueAt
      ? `${buildAppleScriptDateBlock("targetDueDate", params.dueAt)}\nset due date of newReminder to targetDueDate\n`
      : "";
    const notesClause = params.notes ? `set body of newReminder to "${escapeAppleScript(params.notes)}"\n` : "";
    const script = `
tell application "Reminders"
  set targetList to first list whose name is "${escapeAppleScript(params.listName)}"
  set newReminder to make new reminder at end of reminders of targetList with properties {name:"${escapeAppleScript(params.title)}"}
  ${notesClause}${dueDateClause}
  return id of newReminder
end tell`.trim();
    try {
      return normalizeReminderId(await this.runAppleScript(script, this.timeoutMs));
    } catch (error) {
      mapAppleScriptError(error);
    }
  }

  async updateReminder(params: {
    id: string;
    dueAt?: string | null;
    notes?: string | null;
  }): Promise<void> {
    const reminderId = normalizeReminderId(params.id);
    const dueDateClause = params.dueAt === undefined
      ? ""
      : params.dueAt === null
        ? "set due date of targetReminder to missing value\n"
        : `${buildAppleScriptDateBlock("targetDueDate", params.dueAt)}\nset due date of targetReminder to targetDueDate\n`;
    const notesClause = params.notes === undefined ? "" : `set body of targetReminder to "${escapeAppleScript(params.notes ?? "")}"\n`;
    const script = `
tell application "Reminders"
  set targetReminder to first reminder whose id is "x-apple-reminder://${escapeAppleScript(reminderId)}"
  ${notesClause}${dueDateClause}
end tell`.trim();
    try {
      await this.runAppleScript(script, this.timeoutMs);
    } catch (error) {
      mapAppleScriptError(error);
    }
  }
}

export { buildAppleScriptDateBlock, normalizeReminderId };
