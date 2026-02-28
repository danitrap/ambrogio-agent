import { describe, expect, test } from "bun:test";
import {
  extractCanonicalTags,
  parseReminderTagClassification,
  renderManagedTagsLine,
  replaceManagedTagsLine,
} from "../src/mac-tools/providers/reminders-tags";

describe("reminders-tags", () => {
  test("canonicalizes # and @ tags, deduplicates, and classifies GTD tags", () => {
    const parsed = parseReminderTagClassification(
      "Call supplier @NEXT #personal #personal",
      "body @calls #waiting",
      ["@next", "#home", ""],
    );

    expect(parsed.tags).toEqual(["#next", "#personal", "#calls", "#waiting", "#home"]);
    expect(parsed.statusTag).toBe("#next");
    expect(parsed.areaTag).toBe("#personal");
    expect(parsed.otherTags).toEqual(["#calls", "#waiting", "#home"]);
  });

  test("renders and replaces managed tag lines without touching surrounding notes", () => {
    const managed = renderManagedTagsLine(["#next", "#personal"]);
    expect(managed).toBe("ambrogio-tags: #next #personal");

    expect(replaceManagedTagsLine("Context line", ["#next", "#personal"])).toBe(
      "Context line\n\nambrogio-tags: #next #personal",
    );

    expect(replaceManagedTagsLine("Context\nambrogio-tags: #waiting", ["#tickler"])).toBe(
      "Context\n\nambrogio-tags: #tickler",
    );
  });

  test("extractCanonicalTags returns only normalized unique tags", () => {
    expect(extractCanonicalTags("x @Next #NEXT #foo-bar", "y @foo-bar", undefined)).toEqual(["#next", "#foo-bar"]);
  });
});
