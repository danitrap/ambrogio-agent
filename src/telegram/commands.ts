export type TelegramCommand = {
  name: string;
  args: string;
};

export function parseTelegramCommand(text: string): TelegramCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  return {
    name: match[1]?.toLowerCase() ?? "",
    args: (match[2] ?? "").trim(),
  };
}
