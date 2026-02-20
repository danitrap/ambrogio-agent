import { describe, expect, test } from "bun:test";
import { buildPersonalizationHints, type MemoryStore } from "../src/runtime/memory-context";

function createMemory(params: {
  id: string;
  type: "preference" | "fact" | "pattern";
  content: string;
  confidence?: number;
  status?: "active" | "deprecated" | "archived";
  tags?: string[];
  context?: string;
  updatedAt?: string;
}): string {
  return JSON.stringify({
    id: params.id,
    type: params.type,
    content: params.content,
    confidence: params.confidence ?? 100,
    status: params.status ?? "active",
    tags: params.tags ?? [],
    context: params.context ?? "",
    updatedAt: params.updatedAt ?? "2026-02-20T08:00:00.000Z",
  });
}

function storeFrom(values: string[]): MemoryStore {
  return {
    getAllRuntimeKeys: () =>
      values.map((value, index) => ({
        key: `memory:test:${index}`,
        value,
        updatedAt: "2026-02-20T08:00:00.000Z",
      })),
  };
}

describe("buildPersonalizationHints", () => {
  test("returns up to 10 most relevant hints", () => {
    const values = Array.from({ length: 12 }, (_, idx) =>
      createMemory({
        id: `mem-${idx}`,
        type: idx % 2 === 0 ? "preference" : "fact",
        content: `Usa bun in progetto ${idx}`,
        tags: ["bun", "typescript"],
      }),
    );
    const hints = buildPersonalizationHints({
      message: "usa bun in questo progetto typescript",
      memoryStore: storeFrom(values),
    });

    expect(hints.length).toBe(10);
    expect(hints.every((hint) => hint.startsWith("- ["))).toBe(true);
  });

  test("filters out low-confidence and non-active memories", () => {
    const hints = buildPersonalizationHints({
      message: "workflow",
      memoryStore: storeFrom([
        createMemory({ id: "ok", type: "preference", content: "Preferisce workflow GTD", confidence: 95 }),
        createMemory({ id: "low", type: "preference", content: "Bassa confidenza", confidence: 60 }),
        createMemory({ id: "arch", type: "fact", content: "Dato archiviato", status: "archived" }),
        createMemory({ id: "dep", type: "fact", content: "Dato deprecated", status: "deprecated" }),
      ]),
    });

    expect(hints.length).toBe(1);
    expect(hints[0]).toContain("workflow GTD");
  });

  test("deduplicates and respects max char budget", () => {
    const longText = "preferenza molto lunga ".repeat(20);
    const hints = buildPersonalizationHints({
      message: "preferenza",
      memoryStore: storeFrom([
        createMemory({ id: "a", type: "preference", content: longText }),
        createMemory({ id: "b", type: "preference", content: longText }),
        createMemory({ id: "c", type: "pattern", content: "si trova bene con checklist operative" }),
      ]),
      maxChars: 120,
    });

    const totalChars = hints.reduce((acc, hint) => acc + hint.length, 0);
    expect(totalChars).toBeLessThanOrEqual(120);
    expect(hints.length).toBe(1);
  });
});
