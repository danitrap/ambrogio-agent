import type { BoardColumn, BoardItem } from "./types";

function parseTodoChecklistLine(line: string): { status: "open" | "done"; text: string } | null {
  const openMatch = line.match(/^\s*[-*]\s*\[\s\]\s+(.+?)\s*$/);
  if (openMatch?.[1]) {
    return { status: "open", text: openMatch[1].trim() };
  }

  const doneMatch = line.match(/^\s*[-*]\s*\[[xX]\]\s+(.+?)\s*$/);
  if (doneMatch?.[1]) {
    return { status: "done", text: doneMatch[1].trim() };
  }

  return null;
}

function toColumnId(prefix: "todo" | "grocery", title: string, index: number): string {
  const normalized = title
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return `${prefix}-col-${normalized || "section"}-${index}`;
}

export function parseTodoMarkdown(content: string): { columns: BoardColumn[] } {
  const lines = content.split("\n");
  const hasSections = lines.some((line) => /^\s*##\s+/.test(line));

  if (!hasSections) {
    const open: BoardItem[] = [];
    const done: BoardItem[] = [];
    for (const line of lines) {
      const parsed = parseTodoChecklistLine(line);
      if (!parsed) {
        continue;
      }
      if (parsed.status === "open") {
        open.push({ id: `todo-col-open-1-item-${open.length + 1}`, text: parsed.text });
      } else {
        done.push({ id: `todo-col-done-2-item-${done.length + 1}`, text: parsed.text });
      }
    }
    return {
      columns: [
        { id: "todo-col-open-1", title: "Open", items: open },
        { id: "todo-col-done-2", title: "Done", items: done },
      ],
    };
  }

  const columns: BoardColumn[] = [];
  let currentColumn: BoardColumn | null = null;
  for (const line of lines) {
    const headingMatch = line.match(/^\s*##\s+(.+?)\s*$/);
    if (headingMatch?.[1]) {
      const title = headingMatch[1].trim();
      currentColumn = {
        id: toColumnId("todo", title, columns.length + 1),
        title,
        items: [],
      };
      columns.push(currentColumn);
      continue;
    }
    if (!currentColumn) {
      continue;
    }
    const parsed = parseTodoChecklistLine(line);
    if (!parsed) {
      continue;
    }
    currentColumn.items.push({
      id: `${currentColumn.id}-item-${currentColumn.items.length + 1}`,
      text: parsed.text,
    });
  }

  return { columns };
}

function parseSectionBullet(line: string): string | null {
  const checklist = parseTodoChecklistLine(line);
  if (checklist) {
    return checklist.text;
  }

  const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
  if (bullet?.[1]) {
    return bullet[1].trim();
  }

  return null;
}

export function parseGroceriesMarkdown(content: string): { columns: BoardColumn[] } {
  const columns: BoardColumn[] = [];
  let currentColumn: BoardColumn | null = null;

  for (const line of content.split("\n")) {
    const headingMatch = line.match(/^\s*##\s+(.+?)\s*$/);
    if (headingMatch?.[1]) {
      const title = headingMatch[1].trim();
      currentColumn = {
        id: toColumnId("grocery", title, columns.length + 1),
        title,
        items: [],
      };
      columns.push(currentColumn);
      continue;
    }
    if (!currentColumn) {
      continue;
    }
    const itemText = parseSectionBullet(line);
    if (!itemText) {
      continue;
    }
    currentColumn.items.push({
      id: `${currentColumn.id}-item-${currentColumn.items.length + 1}`,
      text: itemText,
    });
  }

  return { columns };
}
