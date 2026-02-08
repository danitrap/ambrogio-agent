export function parseOpenTodoItems(content: string, limit = 10): string[] {
  const items: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*[-*]\s*\[\s\]\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const text = match[1]?.trim();
    if (!text) {
      continue;
    }
    items.push(text);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}
