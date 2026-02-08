import { describe, expect, test } from "bun:test";
import { parseTelegramResponse } from "../src/telegram/response-mode";

describe("parseTelegramResponse", () => {
  test("returns trimmed text", () => {
    expect(parseTelegramResponse("Ciao")).toEqual({
      text: "Ciao",
    });
  });

  test("does not parse xml-like tags", () => {
    expect(parseTelegramResponse("<response_mode>audio</response_mode>\nCiao Signor Daniele")).toEqual({
      text: "<response_mode>audio</response_mode>\nCiao Signor Daniele",
    });
  });
});
