import { describe, expect, test } from "bun:test";
import { parseTelegramResponse } from "../src/telegram/response-mode";

describe("parseTelegramResponse", () => {
  test("defaults to text mode when tag is missing", () => {
    expect(parseTelegramResponse("Ciao")).toEqual({
      mode: "text",
      text: "Ciao",
      documentPaths: [],
    });
  });

  test("parses audio mode tag and strips it from output", () => {
    expect(parseTelegramResponse("<response_mode>audio</response_mode>\nCiao Signor Daniele")).toEqual({
      mode: "audio",
      text: "Ciao Signor Daniele",
      documentPaths: [],
    });
  });

  test("parses text mode tag and strips it from output", () => {
    expect(parseTelegramResponse("<response_mode>text</response_mode>\nCiao")).toEqual({
      mode: "text",
      text: "Ciao",
      documentPaths: [],
    });
  });
});
