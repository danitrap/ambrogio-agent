import { describe, expect, test } from "bun:test";
import { parseTelegramResponse } from "../src/telegram/response-mode";

describe("parseTelegramResponse", () => {
  test("keeps xml-like tags as plain text", () => {
    const parsed = parseTelegramResponse([
      "<response_mode>text</response_mode>",
      "<telegram_document>/data/generated/scanned-pdfs/2026/02/08/giftcard_scannerizzato.pdf</telegram_document>",
      "Fatto, invio il documento.",
    ].join("\n"));

    expect(parsed).toEqual({
      text: [
        "<response_mode>text</response_mode>",
        "<telegram_document>/data/generated/scanned-pdfs/2026/02/08/giftcard_scannerizzato.pdf</telegram_document>",
        "Fatto, invio il documento.",
      ].join("\n"),
    });
  });

  test("returns plain text unchanged", () => {
    const parsed = parseTelegramResponse("<response_mode>audio</response_mode>\nAudio pronto");
    expect(parsed).toEqual({
      text: "<response_mode>audio</response_mode>\nAudio pronto",
    });
  });
});
