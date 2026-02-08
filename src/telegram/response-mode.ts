export type ResponseMode = "text" | "audio";

export type ParsedResponseMode = {
  mode: ResponseMode;
  text: string;
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
