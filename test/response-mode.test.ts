import { describe, expect, test } from "bun:test";
import { parseResponseMode } from "../src/telegram/response-mode";

describe("parseResponseMode", () => {
  test("defaults to text mode when tag is missing", () => {
    expect(parseResponseMode("Ciao")).toEqual({
      mode: "text",
      text: "Ciao",
    });
  });

  test("parses audio mode tag and strips it from output", () => {
    expect(parseResponseMode("<response_mode>audio</response_mode>\nCiao Signor Daniele")).toEqual({
      mode: "audio",
      text: "Ciao Signor Daniele",
    });
  });

  test("parses text mode tag and strips it from output", () => {
    expect(parseResponseMode("<response_mode>text</response_mode>\nCiao")).toEqual({
      mode: "text",
      text: "Ciao",
    });
  });
});
