import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_RECENT_TELEGRAM_MESSAGES = 50;
const HISTORY_RELATIVE_PATH = "runtime/recent-telegram-messages.json";

function getHistoryPath(dataRoot: string): string {
  return path.join(dataRoot, HISTORY_RELATIVE_PATH);
}

export async function loadRecentTelegramMessages(dataRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(getHistoryPath(dataRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const normalized = parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return normalized.slice(-MAX_RECENT_TELEGRAM_MESSAGES);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    return [];
  }
}

export async function saveRecentTelegramMessages(dataRoot: string, messages: string[]): Promise<void> {
  const normalized = messages
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .slice(-MAX_RECENT_TELEGRAM_MESSAGES);
  const historyPath = getHistoryPath(dataRoot);
  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, JSON.stringify(normalized, null, 2), "utf8");
}

export async function appendRecentTelegramMessage(dataRoot: string, message: string): Promise<string[]> {
  const history = await loadRecentTelegramMessages(dataRoot);
  history.push(message);
  const normalized = history.slice(-MAX_RECENT_TELEGRAM_MESSAGES);
  await saveRecentTelegramMessages(dataRoot, normalized);
  return normalized;
}

export async function clearRecentTelegramMessages(dataRoot: string): Promise<void> {
  await saveRecentTelegramMessages(dataRoot, []);
}
