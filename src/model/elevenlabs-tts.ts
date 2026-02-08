const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

type FetchFn = typeof fetch;

export class ElevenLabsTts {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly voiceId: string = DEFAULT_VOICE_ID,
    private readonly modelId: string = DEFAULT_MODEL_ID,
  ) {}

  async synthesize(text: string): Promise<Blob> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text");
    }

    const response = await this.fetchFn(`${ELEVENLABS_TTS_URL}/${this.voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: trimmed,
        model_id: this.modelId,
      }),
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 500);
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${errorText}`);
    }

    const audioBlob = await response.blob();
    if (audioBlob.size === 0) {
      throw new Error("ElevenLabs TTS returned empty audio");
    }
    return audioBlob;
  }
}
