export type QuietHoursWindow = {
  startMinute: number;
  endMinute: number;
  raw: string;
};

function parseTimeToMinute(raw: string): number {
  const match = raw.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    throw new Error(`Invalid time: ${raw}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return (hour * 60) + minute;
}

export function parseQuietHours(raw: string | null | undefined): QuietHoursWindow | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^([0-2]?\d:[0-5]\d)\s*-\s*([0-2]?\d:[0-5]\d)$/);
  if (!match) {
    throw new Error(`Invalid HEARTBEAT_QUIET_HOURS format: ${trimmed}`);
  }

  const startMinute = parseTimeToMinute(match[1] ?? "");
  const endMinute = parseTimeToMinute(match[2] ?? "");
  return { startMinute, endMinute, raw: trimmed };
}

export function isInQuietHours(window: QuietHoursWindow | null, now: Date = new Date()): boolean {
  if (!window) {
    return false;
  }

  const nowMinute = (now.getHours() * 60) + now.getMinutes();
  if (window.startMinute === window.endMinute) {
    return true;
  }
  if (window.startMinute < window.endMinute) {
    return nowMinute >= window.startMinute && nowMinute < window.endMinute;
  }
  return nowMinute >= window.startMinute || nowMinute < window.endMinute;
}

