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
      documentPaths: ["/data/generated/scanned-pdfs/2026/02/08/giftcard_scannerizzato.pdf"],
      text: "Fatto, invio il documento.",
    });
  });

  test("returns empty documentPaths when tag is missing", () => {
    const parsed = parseTelegramResponse("<response_mode>audio</response_mode>\nAudio pronto");
    expect(parsed).toEqual({
      mode: "audio",
      documentPaths: [],
      text: "Audio pronto",
    });
  });

  test("parses multiple telegram document tags", () => {
    const parsed = parseTelegramResponse([
      "<telegram_document>/data/generated/scanned-pdfs/a.pdf</telegram_document>",
      "<telegram_document>/data/generated/scanned-pdfs/b.pdf</telegram_document>",
      "Invio due file.",
    ].join("\n"));

    expect(parsed.documentPaths).toEqual([
      "/data/generated/scanned-pdfs/a.pdf",
      "/data/generated/scanned-pdfs/b.pdf",
    ]);
    expect(parsed.text).toBe("Invio due file.");
  });
});
