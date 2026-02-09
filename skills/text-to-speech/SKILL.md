---
name: text-to-speech
description: Convert text to speech using ElevenLabs voice AI. Use when generating audio from text, creating voiceovers, building voice apps, or synthesizing speech in 70+ languages. Includes intelligent caching to avoid regenerating identical audio.
license: MIT
compatibility: Requires internet access and an ElevenLabs API key (ELEVENLABS_API_KEY).
metadata: {"openclaw": {"requires": {"env": ["ELEVENLABS_API_KEY"]}, "primaryEnv": "ELEVENLABS_API_KEY"}}
---

# ElevenLabs Text-to-Speech

Generate natural speech from text - supports 74+ languages, multiple models for quality vs latency tradeoffs.

## Invio Audio via Telegram

Per inviare l'audio generato su Telegram, usa `ambrogioctl`:

```bash
# Genera audio e invialo
ambrogioctl telegram send-audio --path "/path/to/audio.mp3" --json

# Oppure invia come documento
ambrogioctl telegram send-document --path "/path/to/audio.mp3" --json
```

> **Setup:** See [Installation Guide](references/installation.md). For JavaScript, use `@elevenlabs/*` packages only.

## Audio Caching

To avoid regenerating identical audio and wasting API credits, use the caching helper:

```bash
# Check if audio already exists for this text
bash /data/skills/text-to-speech/scripts/check-cache.sh "Your text here" "voice_id"

# Returns: cached audio path or empty if not found
```

Cache details:
- **Key format**: `tts:audio:<sha256_hash_of_text_and_voice>`
- **TTL**: 24 hours (86400 seconds)
- **Stored data**: JSON with `audio_path`, `timestamp`, `voice_id`, `model_id`, `character_count`
- **Storage location**: `/data/generated/tts/YYYY/MM/DD/`

### Python with Caching

```python
from elevenlabs.client import ElevenLabs
import hashlib
import json
import subprocess
import os

client = ElevenLabs()

text = "Hello, welcome to ElevenLabs!"
voice_id = "JBFqnCBsd6RMkjVDRZzb"  # George
model_id = "eleven_multilingual_v2"

# Generate cache key from text + voice_id
cache_key = f"tts:audio:{hashlib.sha256(f'{text}:{voice_id}'.encode()).hexdigest()}"

# Check cache via ambrogioctl
try:
    result = subprocess.run(
        ["ambrogioctl", "state", "get", cache_key],
        capture_output=True, text=True, timeout=5
    )
    if result.returncode == 0:
        cached_data = json.loads(result.stdout.split("=", 1)[1])
        # Check if cache is still valid (< 24 hours)
        from datetime import datetime, timezone
        cached_time = datetime.fromisoformat(cached_data["timestamp"].replace("Z", "+00:00"))
        age_hours = (datetime.now(timezone.utc) - cached_time).total_seconds() / 3600
        if age_hours < 24 and os.path.exists(cached_data["audio_path"]):
            print(f"Using cached audio: {cached_data['audio_path']}")
            # Use cached file
            with open(cached_data["audio_path"], "rb") as f:
                audio = f.read()
        else:
            raise Exception("Cache expired")
    else:
        raise Exception("Cache miss")
except Exception:
    # Cache miss - generate new audio
    audio = client.text_to_speech.convert(
        text=text,
        voice_id=voice_id,
        model_id=model_id
    )
    
    # Save to file
    date_path = datetime.now().strftime("%Y/%m/%d")
    out_dir = f"/data/generated/tts/{date_path}"
    os.makedirs(out_dir, exist_ok=True)
    
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    text_slug = "".join(c if c.isalnum() else "_" for c in text[:30])
    audio_path = f"{out_dir}/{ts}-{text_slug}.mp3"
    
    with open(audio_path, "wb") as f:
        for chunk in audio:
            f.write(chunk)
    
    # Update cache
    cache_value = json.dumps({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "audio_path": audio_path,
        "voice_id": voice_id,
        "model_id": model_id,
        "character_count": len(text)
    })
    subprocess.run(
        ["ambrogioctl", "state", "set", cache_key, cache_value],
        capture_output=True, timeout=5
    )
    print(f"Generated and cached: {audio_path}")
```

### JavaScript with Caching

```javascript
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createWriteStream, existsSync, readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { createHash } from "crypto";
import { spawn } from "child_process";
import path from "path";

const client = new ElevenLabsClient();

const text = "Hello, welcome to ElevenLabs!";
const voiceId = "JBFqnCBsd6RMkjVDRZzb";
const modelId = "eleven_multilingual_v2";

// Generate cache key
const cacheKey = `tts:audio:${createHash("sha256").update(`${text}:${voiceId}`).digest("hex")}`;

// Check cache function
async function checkCache(key) {
  return new Promise((resolve) => {
    const proc = spawn("ambrogioctl", ["state", "get", key]);
    let output = "";
    proc.stdout.on("data", (data) => output += data);
    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const value = output.split("=")[1];
          const data = JSON.parse(value);
          const ageHours = (Date.now() - new Date(data.timestamp).getTime()) / (1000 * 3600);
          if (ageHours < 24 && existsSync(data.audio_path)) {
            resolve(data);
            return;
          }
        } catch {}
      }
      resolve(null);
    });
  });
}

// Set cache function
async function setCache(key, value) {
  return new Promise((resolve) => {
    const proc = spawn("ambrogioctl", ["state", "set", key, JSON.stringify(value)]);
    proc.on("close", () => resolve());
  });
}

const cached = await checkCache(cacheKey);

if (cached) {
  console.log(`Using cached audio: ${cached.audio_path}`);
  const audio = readFileSync(cached.audio_path);
  // Use audio...
} else {
  // Generate new audio
  const audio = await client.textToSpeech.convert(voiceId, {
    text,
    modelId,
  });
  
  // Save to file
  const now = new Date();
  const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  const outDir = `/data/generated/tts/${datePath}`;
  await mkdir(outDir, { recursive: true });
  
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const textSlug = text.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_");
  const audioPath = path.join(outDir, `${ts}-${textSlug}.mp3`);
  
  audio.pipe(createWriteStream(audioPath));
  
  // Update cache
  await setCache(cacheKey, {
    timestamp: now.toISOString(),
    audio_path: audioPath,
    voice_id: voiceId,
    model_id: modelId,
    character_count: text.length
  });
  
  console.log(`Generated and cached: ${audioPath}`);
}
```

### cURL (with cache check)

```bash
TEXT="Hello!"
VOICE_ID="JBFqnCBsd6RMkjVDRZzb"
CACHE_KEY="tts:audio:$(echo -n "${TEXT}:${VOICE_ID}" | sha256sum | cut -d' ' -f1)"

# Check cache
CACHED=$(ambrogioctl state get "$CACHE_KEY" 2>/dev/null | cut -d= -f2-)
if [[ -n "$CACHED" ]]; then
  CACHED_PATH=$(echo "$CACHED" | grep -o '"audio_path":"[^"]*"' | cut -d'"' -f4)
  if [[ -f "$CACHED_PATH" ]]; then
    echo "Using cached: $CACHED_PATH"
    exit 0
  fi
fi

# Fetch new audio
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d "{\"text\": \"$TEXT\", \"model_id\": \"eleven_multilingual_v2\"}" --output output.mp3

# Store in cache (simplified - in practice, also store path, timestamp, etc.)
ambrogioctl state set "$CACHE_KEY" "{\"audio_path\":\"/path/to/output.mp3\",\"timestamp\":\"$(date -Iseconds)\"}"
```

## Quick Start (No Caching)

### Python

```python
from elevenlabs.client import ElevenLabs

client = ElevenLabs()

audio = client.text_to_speech.convert(
    text="Hello, welcome to ElevenLabs!",
    voice_id="JBFqnCBsd6RMkjVDRZzb",  # George
    model_id="eleven_multilingual_v2"
)

with open("output.mp3", "wb") as f:
    for chunk in audio:
        f.write(chunk)
```

### JavaScript

```javascript
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createWriteStream } from "fs";

const client = new ElevenLabsClient();
const audio = await client.textToSpeech.convert("JBFqnCBsd6RMkjVDRZzb", {
  text: "Hello, welcome to ElevenLabs!",
  modelId: "eleven_multilingual_v2",
});
audio.pipe(createWriteStream("output.mp3"));
```

### cURL

```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d '{"text": "Hello!", "model_id": "eleven_multilingual_v2"}' --output output.mp3
```

## Models

| Model ID | Languages | Latency | Best For |
|----------|-----------|---------|----------|
| `eleven_v3` | 74 | Standard | Highest quality, emotional range |
| `eleven_multilingual_v2` | 29 | Standard | High quality, most use cases |
| `eleven_flash_v2_5` | 32 | ~75ms | Ultra-low latency, real-time |
| `eleven_flash_v2` | English | ~75ms | English-only, fastest |
| `eleven_turbo_v2_5` | 32 | Low | Balanced quality/speed |

## Voice IDs

Use pre-made voices or create custom voices in the dashboard.

**Popular voices:**
- `JBFqnCBsd6RMkjVDRZzb` - George (male, narrative)
- `EXAVITQu4vr4xnSDxMaL` - Sarah (female, soft)
- `onwK4e9ZLuTAKqWW03F9` - Daniel (male, authoritative)
- `XB0fDUnXU5powFXDhCwa` - Charlotte (female, conversational)

```python
voices = client.voices.get_all()
for voice in voices.voices:
    print(f"{voice.voice_id}: {voice.name}")
```

## Voice Settings

Fine-tune how the voice sounds:

- **Stability**: How consistent the voice stays. Lower values = more emotional range and variation, but can sound unstable. Higher = steady, predictable delivery.
- **Similarity boost**: How closely to match the original voice sample. Higher values sound more like the original but may amplify audio artifacts.
- **Style**: Exaggerates the voice's unique style characteristics (only works with v2+ models).
- **Speaker boost**: Post-processing that enhances clarity and voice similarity.

```python
from elevenlabs import VoiceSettings

audio = client.text_to_speech.convert(
    text="Customize my voice settings.",
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    voice_settings=VoiceSettings(
        stability=0.5,
        similarity_boost=0.75,
        style=0.5,
        use_speaker_boost=True
    )
)
```

## Language Enforcement

Force specific language for pronunciation:

```python
audio = client.text_to_speech.convert(
    text="Bonjour, comment allez-vous?",
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    model_id="eleven_multilingual_v2",
    language_code="fr"  # ISO 639-1 code
)
```

## Text Normalization

Controls how numbers, dates, and abbreviations are converted to spoken words. For example, "01/15/2026" becomes "January fifteenth, twenty twenty-six":

- `"auto"` (default): Model decides based on context
- `"on"`: Always normalize (use when you want natural speech)
- `"off"`: Speak literally (use when you want "zero one slash one five...")

```python
audio = client.text_to_speech.convert(
    text="Call 1-800-555-0123 on 01/15/2026",
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    apply_text_normalization="on"
)
```

## Request Stitching

When generating long audio in multiple requests, the audio can have pops, unnatural pauses, or tone shifts at the boundaries. Request stitching solves this by letting each request know what comes before/after it:

```python
# First request
audio1 = client.text_to_speech.convert(
    text="This is the first part.",
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    next_text="And this continues the story."
)

# Second request using previous context
audio2 = client.text_to_speech.convert(
    text="And this continues the story.",
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    previous_text="This is the first part."
)
```

## Output Formats

| Format | Description |
|--------|-------------|
| `mp3_44100_128` | MP3 44.1kHz 128kbps (default) - compressed, good for web/apps |
| `mp3_44100_192` | MP3 44.1kHz 192kbps (Creator+) - higher quality compressed |
| `pcm_16000` | Raw uncompressed audio at 16kHz - use for real-time processing |
| `pcm_22050` | Raw uncompressed audio at 22.05kHz |
| `pcm_24000` | Raw uncompressed audio at 24kHz - good balance for streaming |
| `pcm_44100` | Raw uncompressed audio at 44.1kHz (Pro+) - CD quality |
| `ulaw_8000` | μ-law compressed 8kHz - standard for phone systems (Twilio, telephony) |

## Streaming

For real-time applications:

```python
audio_stream = client.text_to_speech.convert(
    text="This text will be streamed as audio.",
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    model_id="eleven_flash_v2_5"  # Ultra-low latency
)

for chunk in audio_stream:
    play_audio(chunk)
```

See [references/streaming.md](references/streaming.md) for WebSocket streaming.

## Error Handling

```python
try:
    audio = client.text_to_speech.convert(
        text="Generate speech",
        voice_id="invalid-voice-id"
    )
except Exception as e:
    print(f"API error: {e}")
```

Common errors:
- **401**: Invalid API key
- **422**: Invalid parameters (check voice_id, model_id)
- **429**: Rate limit exceeded

## Tracking Costs

Monitor character usage via response headers (`x-character-count`, `request-id`):

```python
response = client.text_to_speech.convert.with_raw_response(
    text="Hello!", voice_id="JBFqnCBsd6RMkjVDRZzb", model_id="eleven_multilingual_v2"
)
audio = response.parse()
print(f"Characters used: {response.headers.get('x-character-count')}")
```

## Cache Management Commands

```bash
# List all cached TTS entries
ambrogioctl state list --pattern "tts:audio:*"

# Delete specific cache entry
ambrogioctl state delete "tts:audio:<hash>"

# Clear all TTS cache
ambrogioctl state list --pattern "tts:audio:*" --json | jq -r '.entries[].key' | xargs ambrogioctl state delete
```

## References

- [Installation Guide](references/installation.md)
- [Streaming Audio](references/streaming.md)
- [Voice Settings](references/voice-settings.md)
