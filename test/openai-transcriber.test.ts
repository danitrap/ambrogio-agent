import { describe, expect, test } from "bun:test";
import { OpenAiTranscriber } from "../src/model/openai-transcriber";

describe("OpenAiTranscriber", () => {
  test("calls OpenAI audio transcription API and returns text", async () => {
    const calls: Array<{ url: string; method: string; authorization: string; bodyType: string; model: string | null }> = [];
    const fakeFetch = (async (input: unknown, init?: RequestInit) => {
      const body = init?.body;
      const model = body instanceof FormData ? body.get("model") : null;
      calls.push({
        url: String(input),
        method: String(init?.method),
        authorization: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
        bodyType: body instanceof FormData ? "formdata" : typeof body,
        model: typeof model === "string" ? model : null,
      });

      return new Response(JSON.stringify({ text: "ciao dal vocale" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const transcriber = new OpenAiTranscriber("api-key", fakeFetch);
    const text = await transcriber.transcribe(new Blob(["audio"]), "voice.oga", "audio/ogg");

    expect(text).toBe("ciao dal vocale");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.authorization).toBe("Bearer api-key");
    expect(calls[0]?.bodyType).toBe("formdata");
    expect(calls[0]?.model).toBe("gpt-4o-mini-transcribe");
  });

  test("normalizes .oga filename to .ogg before upload", async () => {
    let uploadedName = "";
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      const body = init?.body;
      if (body instanceof FormData) {
        const uploaded = body.get("file");
        if (uploaded instanceof File) {
          uploadedName = uploaded.name;
        }
      }

      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const transcriber = new OpenAiTranscriber("api-key", fakeFetch);
    await transcriber.transcribe(new Blob(["audio"]), "voice.oga", "audio/ogg");

    expect(uploadedName).toBe("voice.ogg");
  });
});
