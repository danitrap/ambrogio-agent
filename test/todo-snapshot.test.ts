import { describe, expect, test } from "bun:test";
import { parseOpenTodoItems } from "../src/runtime/todo-snapshot";

describe("parseOpenTodoItems", () => {
  test("parses standard markdown unchecked todos", () => {
    const content = [
      "# TODO",
      "- [ ] first task",
      "- [x] done task",
      "- [ ] second task",
    ].join("\n");
    expect(parseOpenTodoItems(content)).toEqual(["first task", "second task"]);
  });

  test("supports star bullets and flexible spaces", () => {
    const content = [
      "* [ ] one",
      "  -   [ ]    two   ",
      " - [x] nope",
    ].join("\n");
    expect(parseOpenTodoItems(content)).toEqual(["one", "two"]);
  });

  test("respects limit", () => {
    const content = [
      "- [ ] a",
      "- [ ] b",
      "- [ ] c",
    ].join("\n");
    expect(parseOpenTodoItems(content, 2)).toEqual(["a", "b"]);
  });
});
