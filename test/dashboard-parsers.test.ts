import { describe, expect, test } from "bun:test";
import { parseGroceriesMarkdown, parseTodoMarkdown } from "../src/dashboard/parsers";

describe("dashboard parsers", () => {
  test("parses todo markdown into Open/Done fallback columns", () => {
    const content = [
      "# TODO",
      "- [ ] Buy milk",
      "- [x] File taxes",
      "* [ ] Book dentist",
      "random line",
    ].join("\n");

    expect(parseTodoMarkdown(content)).toEqual({
      columns: [
        {
          id: "todo-col-open-1",
          title: "Open",
          items: [
            { id: "todo-col-open-1-item-1", text: "Buy milk" },
            { id: "todo-col-open-1-item-2", text: "Book dentist" },
          ],
        },
        {
          id: "todo-col-done-2",
          title: "Done",
          items: [{ id: "todo-col-done-2-item-1", text: "File taxes" }],
        },
      ],
    });
  });

  test("parses todo markdown dynamically by section headings", () => {
    const content = [
      "# TODO",
      "## Inbox",
      "- [ ] Task A",
      "## In Progress",
      "- [ ] Task B",
      "- [x] Task C",
      "## Done",
      "- [x] Task D",
    ].join("\n");

    expect(parseTodoMarkdown(content)).toEqual({
      columns: [
        {
          id: "todo-col-inbox-1",
          title: "Inbox",
          items: [{ id: "todo-col-inbox-1-item-1", text: "Task A" }],
        },
        {
          id: "todo-col-in-progress-2",
          title: "In Progress",
          items: [
            { id: "todo-col-in-progress-2-item-1", text: "Task B" },
            { id: "todo-col-in-progress-2-item-2", text: "Task C" },
          ],
        },
        {
          id: "todo-col-done-3",
          title: "Done",
          items: [{ id: "todo-col-done-3-item-1", text: "Task D" }],
        },
      ],
    });
  });

  test("parses groceries section items from To Buy and In Pantry headings", () => {
    const content = [
      "# Groceries",
      "",
      "## To Buy",
      "- Eggs",
      "- [ ] Bread",
      "",
      "## In Pantry",
      "- Pasta",
      "* [x] Tomato sauce",
      "",
      "## Notes",
      "- ignore me",
    ].join("\n");

    expect(parseGroceriesMarkdown(content)).toEqual({
      columns: [
        {
          id: "grocery-col-to-buy-1",
          title: "To Buy",
          items: [
            { id: "grocery-col-to-buy-1-item-1", text: "Eggs" },
            { id: "grocery-col-to-buy-1-item-2", text: "Bread" },
          ],
        },
        {
          id: "grocery-col-in-pantry-2",
          title: "In Pantry",
          items: [
            { id: "grocery-col-in-pantry-2-item-1", text: "Pasta" },
            { id: "grocery-col-in-pantry-2-item-2", text: "Tomato sauce" },
          ],
        },
        {
          id: "grocery-col-notes-3",
          title: "Notes",
          items: [{ id: "grocery-col-notes-3-item-1", text: "ignore me" }],
        },
      ],
    });
  });

  test("parses italian grocery headings with nested sub-sections", () => {
    const content = [
      "# Lista della spesa",
      "## Da comprare",
      "### Ortofrutta",
      "- Cipolla",
      "- Zucchine",
      "## Fuori rotazione",
      "- Ignore this",
      "## Presente in dispensa",
      "### Proteine",
      "- Uova",
      "- Tofu",
    ].join("\n");

    expect(parseGroceriesMarkdown(content)).toEqual({
      columns: [
        {
          id: "grocery-col-da-comprare-1",
          title: "Da comprare",
          items: [
            { id: "grocery-col-da-comprare-1-item-1", text: "Cipolla" },
            { id: "grocery-col-da-comprare-1-item-2", text: "Zucchine" },
          ],
        },
        {
          id: "grocery-col-fuori-rotazione-2",
          title: "Fuori rotazione",
          items: [{ id: "grocery-col-fuori-rotazione-2-item-1", text: "Ignore this" }],
        },
        {
          id: "grocery-col-presente-in-dispensa-3",
          title: "Presente in dispensa",
          items: [
            { id: "grocery-col-presente-in-dispensa-3-item-1", text: "Uova" },
            { id: "grocery-col-presente-in-dispensa-3-item-2", text: "Tofu" },
          ],
        },
      ],
    });
  });
});
