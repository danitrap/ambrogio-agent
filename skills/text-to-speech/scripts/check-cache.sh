#!/usr/bin/env bash
set -euo pipefail

CACHE_TTL_HOURS=24

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <text> [voice_id]" >&2
  exit 1
fi

text="$1"
voice_id="${2:-JBFqnCBsd6RMkjVDRZzb}"  # Default to George

# Generate cache key from text + voice_id
cache_key="tts:audio:$(echo -n "${text}:${voice_id}" | sha256sum | cut -d' ' -f1)"

# Check if ambrogioctl is available
if ! command -v ambrogioctl >/dev/null 2>&1; then
  echo ""  # No cache system available
  exit 0
fi

# Check cache
cache_entry="$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2- || true)"

if [[ -z "$cache_entry" ]]; then
  echo ""  # Cache miss
  exit 0
fi

# Parse cache entry
cached_timestamp="$(echo "$cache_entry" | grep -o '"timestamp":"[^"]*"' | cut -d'"' -f4 || true)"
cached_path="$(echo "$cache_entry" | grep -o '"audio_path":"[^"]*"' | cut -d'"' -f4 || true)"

if [[ -z "$cached_timestamp" || -z "$cached_path" ]]; then
  echo ""  # Invalid cache entry
  exit 0
fi

# Check if cache is still valid (< 24 hours)
cached_epoch="$(date -d "$cached_timestamp" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$cached_timestamp" +%s 2>/dev/null || echo 0)"
current_epoch="$(date +%s)"
age_hours=$(( (current_epoch - cached_epoch) / 3600 ))

if [[ $age_hours -ge $CACHE_TTL_HOURS ]]; then
  echo ""  # Cache expired
  exit 0
fi

# Check if file still exists
if [[ ! -f "$cached_path" ]]; then
  echo ""  # File deleted
  exit 0
fi

# Cache hit - return the path
echo "$cached_path"
