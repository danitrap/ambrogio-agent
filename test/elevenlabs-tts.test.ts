import { describe, expect, test } from "bun:test";
import { ElevenLabsTts } from "../src/model/elevenlabs-tts";

describe("ElevenLabsTts", () => {
  test("calls ElevenLabs API and returns audio blob", async () => {
    const calls: Array<{ url: string; method: string; apiKey: string; accept: string; contentType: string; body: string }> = [];
    const fakeFetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        apiKey: String((init?.headers as Record<string, string>)?.["xi-api-key"] ?? ""),
        accept: String((init?.headers as Record<string, string>)?.accept ?? ""),
        contentType: String((init?.headers as Record<string, string>)?.["content-type"] ?? ""),
        body: String(init?.body ?? ""),
      });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const tts = new ElevenLabsTts("eleven-key", fakeFetch);
    const audio = await tts.synthesize("Ciao da Ambrogio");

    expect(audio.size).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.apiKey).toBe("eleven-key");
    expect(calls[0]?.accept).toBe("audio/mpeg");
    expect(calls[0]?.contentType).toBe("application/json");
    expect(calls[0]?.body).toContain("\"model_id\":\"eleven_multilingual_v2\"");
  });
});
