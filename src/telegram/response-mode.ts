export type ResponseMode = "text" | "audio";

export type ParsedTelegramResponse = {
  mode: ResponseMode;
  text: string;
  documentPaths: string[];
};

function parseResponseMode(rawText: string): { mode: ResponseMode; text: string } {
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
  const documentMatches = Array.from(
    modeParsed.text.matchAll(/<telegram_document>\s*([^<]+?)\s*<\/telegram_document>\s*/gi),
  );
  const documentPaths = documentMatches
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0);
  const text = modeParsed.text.replaceAll(/<telegram_document>\s*([^<]+?)\s*<\/telegram_document>\s*/gi, "").trim();

  return {
    mode: modeParsed.mode,
    text,
    documentPaths,
  };
}
