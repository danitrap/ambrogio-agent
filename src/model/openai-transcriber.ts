const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

type FetchFn = typeof fetch;

export class OpenAiTranscriber {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly model: string = DEFAULT_TRANSCRIPTION_MODEL,
  ) {}

  async transcribe(fileBlob: Blob, fileName: string, mimeType?: string | null): Promise<string> {
    const body = new FormData();
    const normalizedFileName = normalizeAudioFileName(fileName);
    const resolvedMimeType = (mimeType ?? fileBlob.type) || "application/octet-stream";
    const file = new File([fileBlob], normalizedFileName, {
      type: resolvedMimeType,
    });

    body.append("model", this.model);
    body.append("file", file);

    const response = await this.fetchFn(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 500);
      throw new Error(`OpenAI transcription failed: ${response.status} ${errorText}`);
    }

    const payload = (await response.json()) as { text?: string };
    const text = payload.text?.trim();
    if (!text) {
      throw new Error("OpenAI transcription returned empty text");
    }

    return text;
  }
}

function normalizeAudioFileName(fileName: string): string {
  return fileName.toLowerCase().endsWith(".oga")
    ? `${fileName.slice(0, -4)}.ogg`
    : fileName;
}
