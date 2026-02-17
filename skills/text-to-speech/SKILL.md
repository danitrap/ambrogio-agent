---
name: text-to-speech
description: Generate speech from text using ElevenLabs with cache-first behavior and optional Telegram delivery.
license: MIT
compatibility: Requires internet access and an ElevenLabs API key (ELEVENLABS_API_KEY).
metadata: {"openclaw": {"requires": {"env": ["ELEVENLABS_API_KEY"]}, "primaryEnv": "ELEVENLABS_API_KEY"}}
---

# Text to Speech (ElevenLabs)

## Use This Skill When
- The user asks to convert text into spoken audio.

## Preconditions
- `ELEVENLABS_API_KEY` is configured.
- Network access available.

## Workflow
1. Validate input text and target voice/model.
2. Check cache first:
```bash
bash /data/.codex/skills/text-to-speech/scripts/check-cache.sh "<text>" "<voice_id>"
```
3. On cache miss, generate audio via ElevenLabs SDK/API and save under `/data/generated/tts/YYYY/MM/DD/`.
4. Persist cache metadata key:
- `tts:audio:<sha256(text:voice)>`
5. If requested, send audio:
```bash
ambrogioctl telegram send-audio --path "<audio.mp3>" --json
```

## Output Contract
- Report whether cache hit or fresh generation.
- Return final audio path and format.

## Guardrails
- Never print or expose API keys.
- Fail clearly on auth/network/provider errors.
- Do not regenerate identical recent audio when cache is valid.
