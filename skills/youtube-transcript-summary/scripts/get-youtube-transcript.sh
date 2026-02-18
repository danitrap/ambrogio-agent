#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "STATUS=error"
  echo "ERROR=usage: get-youtube-transcript.sh <youtube-url>"
  exit 1
fi

URL="$1"

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "STATUS=error"
  echo "ERROR=yt-dlp not found in PATH"
  exit 1
fi

case "$URL" in
  *youtube.com/*|*youtu.be/*) ;;
  *)
    echo "STATUS=error"
    echo "ERROR=unsupported url: provide a youtube.com or youtu.be url"
    exit 1
    ;;
esac

OUT_ROOT="${AMBROGIO_TRANSCRIPTS_DIR:-/data/generated/transcripts}"
mkdir -p "$OUT_ROOT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$OUT_ROOT/yt-${STAMP}-$$"
MANUAL_DIR="$RUN_DIR/manual"
AUTO_DIR="$RUN_DIR/auto"
mkdir -p "$MANUAL_DIR" "$AUTO_DIR"

find_subtitle_file() {
  local dir="$1"
  local candidate
  for candidate in \
    "$dir"/*.it*.vtt "$dir"/*.it*.srt "$dir"/*.it*.ttml \
    "$dir"/*.en*.vtt "$dir"/*.en*.srt "$dir"/*.en*.ttml \
    "$dir"/*.vtt "$dir"/*.srt "$dir"/*.ttml; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

extract_plain_text() {
  local input="$1"
  local output="$2"

  awk '
    BEGIN { prev = "" }
    {
      gsub(/\r/, "")
      line = $0
      if (line ~ /^WEBVTT/) next
      if (line ~ /^NOTE/) next
      if (line ~ /^[0-9]+$/) next
      if (line ~ /-->/) next
      gsub(/<[^>]*>/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (line == "") next
      if (line == prev) next
      print line
      prev = line
    }
  ' "$input" > "$output"
}

run_yt_dlp() {
  local mode="$1"
  local out_dir="$2"
  local subtitle_flag="$3"

  local log_file="$out_dir/yt-dlp.log"

  if ! yt-dlp \
    --no-warnings \
    --skip-download \
    "$subtitle_flag" \
    --sub-langs "it.*,en.*" \
    --sub-format "vtt/srt/ttml/best" \
    --output "$out_dir/video.%(ext)s" \
    "$URL" >"$log_file" 2>&1; then
    return 1
  fi

  local subtitle_file
  if ! subtitle_file="$(find_subtitle_file "$out_dir")"; then
    return 1
  fi

  local language="unknown"
  case "$(basename "$subtitle_file")" in
    *it*) language="it" ;;
    *en*) language="en" ;;
  esac

  local transcript_path="$out_dir/transcript.txt"
  extract_plain_text "$subtitle_file" "$transcript_path"

  if [[ ! -s "$transcript_path" ]]; then
    return 1
  fi

  echo "STATUS=ok"
  echo "SOURCE=$mode"
  echo "LANGUAGE=$language"
  echo "TRANSCRIPT_PATH=$transcript_path"
  return 0
}

if run_yt_dlp "manual" "$MANUAL_DIR" "--write-subs"; then
  exit 0
fi

if run_yt_dlp "auto" "$AUTO_DIR" "--write-auto-subs"; then
  exit 0
fi

echo "STATUS=error"
echo "ERROR=transcript unavailable (no subtitles found, restricted video, or extraction blocked)"
exit 1
