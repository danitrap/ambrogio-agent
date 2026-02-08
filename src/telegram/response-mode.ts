export type ResponseMode = "text" | "audio";

export type ParsedResponseMode = {
  mode: ResponseMode;
  text: string;
};

export type ParsedTelegramResponse = ParsedResponseMode & {
  documentPath: string | null;
};

export function parseResponseMode(rawText: string): ParsedResponseMode {
  const trimmed = rawText.trim();
  const match = trimmed.match(/^<response_mode>\s*(audio|text)\s*<\/response_mode>\s*/i);
  if (!match) {
    return {
      mode: "text",
      text: trimmed,
    };
  }

  const mode = match[1]?.toLowerCase() === "audio" ? "audio" : "text";
  const text = trimmed.slice(match[0].length).trim();
  return {
    mode,
    text,
  };
}

export function parseTelegramResponse(rawText: string): ParsedTelegramResponse {
  const modeParsed = parseResponseMode(rawText);
  const documentMatch = modeParsed.text.match(/<telegram_document>\s*([^<]+?)\s*<\/telegram_document>\s*/i);
  if (!documentMatch) {
    return {
      mode: modeParsed.mode,
      text: modeParsed.text,
      documentPath: null,
    };
  }

  const documentPath = documentMatch[1]?.trim() ?? "";
  const text = modeParsed.text.replace(documentMatch[0], "").trim();
  return {
    mode: modeParsed.mode,
    text,
    documentPath: documentPath.length > 0 ? documentPath : null,
  };
}
