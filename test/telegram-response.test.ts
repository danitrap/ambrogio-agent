import { describe, expect, test } from "bun:test";
import { parseTelegramResponse } from "../src/telegram/response-mode";

describe("parseTelegramResponse", () => {
  test("parses response mode and telegram document tags", () => {
    const parsed = parseTelegramResponse([
      "<response_mode>text</response_mode>",
      "<telegram_document>/data/generated/scanned-pdfs/2026/02/08/giftcard_scannerizzato.pdf</telegram_document>",
      "Fatto, invio il documento.",
    ].join("\n"));

    expect(parsed).toEqual({
      mode: "text",
      documentPath: "/data/generated/scanned-pdfs/2026/02/08/giftcard_scannerizzato.pdf",
      text: "Fatto, invio il documento.",
    });
  });

  test("returns null documentPath when tag is missing", () => {
    const parsed = parseTelegramResponse("<response_mode>audio</response_mode>\nAudio pronto");
    expect(parsed).toEqual({
      mode: "audio",
      documentPath: null,
      text: "Audio pronto",
    });
  });
});
