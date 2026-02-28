const TAG_PATTERN = /[#@][\w-]+/g;
const STATUS_TAGS = new Set(["#next", "#waiting", "#someday", "#tickler"]);
const AREA_TAGS = new Set(["#personal", "#work", "#home"]);

function normalizeTag(tag: string): string | null {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const body = normalized.startsWith("#") || normalized.startsWith("@") ? normalized.slice(1) : normalized;
  if (!body) {
    return null;
  }
  return `#${body}`;
}

function scanTags(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.match(TAG_PATTERN)?.map((tag) => normalizeTag(tag)).filter((tag): tag is string => tag !== null) ?? [];
}

export function extractCanonicalTags(title: string, notes: string | undefined, incomingTags: string[] | undefined): string[] {
  const ordered = [
    ...scanTags(title),
    ...scanTags(notes),
    ...(Array.isArray(incomingTags) ? incomingTags.map((tag) => normalizeTag(tag)).filter((tag): tag is string => tag !== null) : []),
  ];

  return [...new Set(ordered)];
}

export function parseReminderTagClassification(title: string, notes: string | undefined, incomingTags: string[] | undefined): {
  tags: string[];
  statusTag: string | null;
  areaTag: string | null;
  otherTags: string[];
} {
  const tags = extractCanonicalTags(title, notes, incomingTags);
  let statusTag: string | null = null;
  let areaTag: string | null = null;
  const otherTags: string[] = [];

  for (const tag of tags) {
    if (statusTag === null && STATUS_TAGS.has(tag)) {
      statusTag = tag;
      continue;
    }
    if (areaTag === null && AREA_TAGS.has(tag)) {
      areaTag = tag;
      continue;
    }
    otherTags.push(tag);
  }

  return {
    tags,
    statusTag,
    areaTag,
    otherTags,
  };
}

export function renderManagedTagsLine(tags: string[]): string {
  const normalized = [...new Set(tags.map((tag) => normalizeTag(tag)).filter((tag): tag is string => tag !== null))];
  return `ambrogio-tags: ${normalized.join(" ")}`;
}

export function replaceManagedTagsLine(notes: string | undefined, tags: string[]): string {
  const cleaned = (notes ?? "")
    .split("\n")
    .filter((line) => !line.trim().toLowerCase().startsWith("ambrogio-tags:"))
    .join("\n")
    .trim();
  const managedLine = renderManagedTagsLine(tags);
  return cleaned ? `${cleaned}\n\n${managedLine}` : managedLine;
}

export { AREA_TAGS, STATUS_TAGS };
