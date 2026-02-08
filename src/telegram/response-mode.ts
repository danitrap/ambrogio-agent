export type ParsedTelegramResponse = {
  text: string;
};

export function parseTelegramResponse(rawText: string): ParsedTelegramResponse {
  return {
    text: rawText.trim(),
  };
}
