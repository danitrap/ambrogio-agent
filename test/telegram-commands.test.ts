import { describe, expect, test } from "bun:test";
import { parseTelegramCommand } from "../src/telegram/commands";

describe("parseTelegramCommand", () => {
  test("parses bare command", () => {
    expect(parseTelegramCommand("/help")).toEqual({ name: "help", args: "" });
  });

  test("parses command with bot suffix and args", () => {
    expect(parseTelegramCommand("/retry@ambrogio_bot now")).toEqual({ name: "retry", args: "now" });
  });

  test("parses command case-insensitively", () => {
    expect(parseTelegramCommand("/SkIlLs")).toEqual({ name: "skills", args: "" });
  });

  test("returns null for non-command text", () => {
    expect(parseTelegramCommand("ciao")).toBeNull();
  });
});
