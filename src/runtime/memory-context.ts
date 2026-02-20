export type RuntimeKeyValueEntry = {
  key: string;
  value: string;
  updatedAt: string;
};

export type MemoryStore = {
  getAllRuntimeKeys: (pattern?: string) => RuntimeKeyValueEntry[];
};

type MemoryType = "preference" | "fact" | "pattern";
type MemoryStatus = "active" | "deprecated" | "archived";

type MemoryEntry = {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  updatedAt: string;
  tags?: string[];
  context?: string;
  status?: MemoryStatus;
};

type RankedMemory = {
  score: number;
  memory: MemoryEntry;
};

const MAX_HINTS = 10;
const MAX_HINTS_CHARS = 900;
const MAX_HINT_LINE_CHARS = 85;
const MIN_CONFIDENCE = 75;

function parseMemoryEntry(value: string): MemoryEntry | null {
  try {
    const parsed = JSON.parse(value) as Partial<MemoryEntry>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.content !== "string" || typeof parsed.type !== "string") {
      return null;
    }
    if (parsed.type !== "preference" && parsed.type !== "fact" && parsed.type !== "pattern") {
      return null;
    }
    const confidence = Number(parsed.confidence ?? 0);
    if (!Number.isFinite(confidence)) {
      return null;
    }
    return {
      id: typeof parsed.id === "string" ? parsed.id : "",
      type: parsed.type,
      content: parsed.content,
      confidence,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : [],
      context: typeof parsed.context === "string" ? parsed.context : "",
      status: parsed.status === "deprecated" || parsed.status === "archived" ? parsed.status : "active",
    };
  } catch {
    return null;
  }
}

function toQueryTerms(message: string): string[] {
  return Array.from(new Set(message.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
}

function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, " ").trim();
}

function truncateLine(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function typePrefix(type: MemoryType): string {
  if (type === "preference") {
    return "pref";
  }
  if (type === "pattern") {
    return "pat";
  }
  return "fact";
}

function computeScore(memory: MemoryEntry, messageTerms: string[], nowMs: number): number {
  const typeBoost = memory.type === "preference" ? 30 : memory.type === "pattern" ? 20 : 10;
  const confidenceBoost = Math.min(20, Math.max(0, Math.round(memory.confidence / 5)));

  const updatedAtMs = Date.parse(memory.updatedAt);
  const ageDays = Number.isFinite(updatedAtMs) ? Math.max(0, Math.floor((nowMs - updatedAtMs) / 86_400_000)) : 365;
  const recencyBoost = Math.max(0, 10 - Math.floor(ageDays / 30));

  const content = normalize(memory.content);
  const tags = normalize((memory.tags ?? []).join(" "));
  const context = normalize(memory.context ?? "");
  let termScore = 0;
  let matchedTerms = 0;

  for (const term of messageTerms) {
    if (content.includes(term)) {
      termScore += 8;
      matchedTerms += 1;
      continue;
    }
    if (tags.includes(term)) {
      termScore += 5;
      matchedTerms += 1;
      continue;
    }
    if (context.includes(term)) {
      termScore += 3;
      matchedTerms += 1;
    }
  }

  // Prefer memories with lexical overlap when the query has terms.
  const matchBoost = messageTerms.length > 0 && matchedTerms > 0 ? 15 : 0;

  return typeBoost + confidenceBoost + recencyBoost + termScore + matchBoost;
}

function toHint(memory: MemoryEntry): string {
  const payload = truncateLine(memory.content.replaceAll(/\s+/g, " ").trim(), MAX_HINT_LINE_CHARS);
  return `- [${typePrefix(memory.type)}|c${Math.round(memory.confidence)}] ${payload}`;
}

export function buildPersonalizationHints(params: {
  message: string;
  memoryStore?: MemoryStore;
  maxHints?: number;
  maxChars?: number;
}): string[] {
  const store = params.memoryStore;
  if (!store) {
    return [];
  }

  const entries = store.getAllRuntimeKeys("memory:*");
  if (entries.length === 0) {
    return [];
  }

  const nowMs = Date.now();
  const messageTerms = toQueryTerms(params.message);
  const ranked: RankedMemory[] = [];
  const seenContent = new Set<string>();

  for (const entry of entries) {
    const memory = parseMemoryEntry(entry.value);
    if (!memory) {
      continue;
    }
    if (memory.status !== "active" || memory.confidence < MIN_CONFIDENCE) {
      continue;
    }
    const normalizedContent = normalize(memory.content);
    if (!normalizedContent || seenContent.has(normalizedContent)) {
      continue;
    }
    seenContent.add(normalizedContent);
    ranked.push({
      score: computeScore(memory, messageTerms, nowMs),
      memory,
    });
  }

  if (ranked.length === 0) {
    return [];
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const aUpdated = Date.parse(a.memory.updatedAt);
    const bUpdated = Date.parse(b.memory.updatedAt);
    return (Number.isFinite(bUpdated) ? bUpdated : 0) - (Number.isFinite(aUpdated) ? aUpdated : 0);
  });

  const maxHints = params.maxHints ?? MAX_HINTS;
  const maxChars = params.maxChars ?? MAX_HINTS_CHARS;
  const hints: string[] = [];
  let usedChars = 0;

  for (const item of ranked) {
    if (hints.length >= maxHints) {
      break;
    }
    const hint = toHint(item.memory);
    if (usedChars + hint.length > maxChars) {
      continue;
    }
    hints.push(hint);
    usedChars += hint.length;
  }

  return hints;
}
