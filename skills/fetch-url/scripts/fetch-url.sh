#!/usr/bin/env bash
set -euo pipefail

CACHE_TTL_SECONDS=300  # 5 minutes

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <url> [base-name]" >&2
  exit 1
fi

url="$1"
base_name="${2:-}"

if [[ ! "$url" =~ ^https?:// ]]; then
  echo "Error: URL must start with http:// or https://" >&2
  exit 1
fi

# Generate cache key from URL
url_hash="$(echo -n "$url" | sha256sum | cut -d' ' -f1)"
cache_key="fetch-url:cache:${url_hash}"

# Check cache first
cache_entry=""
if command -v ambrogioctl >/dev/null 2>&1; then
  cache_entry="$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2- || true)"
fi

if [[ -n "$cache_entry" ]]; then
  # Parse cache entry (format: JSON string stored in state)
  cached_timestamp="$(echo "$cache_entry" | grep -o '"timestamp":"[^"]*"' | cut -d'"' -f4 || true)"
  
  if [[ -n "$cached_timestamp" ]]; then
    # Check if cache is still valid (not expired)
    cached_epoch="$(date -d "$cached_timestamp" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$cached_timestamp" +%s 2>/dev/null || echo 0)"
    current_epoch="$(date +%s)"
    age_seconds=$((current_epoch - cached_epoch))
    
    if [[ $age_seconds -lt $CACHE_TTL_SECONDS ]]; then
      # Cache hit - return cached paths
      cached_text="$(echo "$cache_entry" | grep -o '"text_path":"[^"]*"' | cut -d'"' -f4 || true)"
      cached_html="$(echo "$cache_entry" | grep -o '"html_path":"[^"]*"' | cut -d'"' -f4 || true)"
      cached_status="$(echo "$cache_entry" | grep -o '"status_code":[0-9]*' | cut -d':' -f2 || true)"
      
      if [[ -f "$cached_text" && -f "$cached_html" ]]; then
        echo "URL: $url"
        echo "STATUS: ${cached_status:-200}"
        echo "HTML: $cached_html"
        echo "TEXT: $cached_text"
        echo "META: (cached)"
        echo "CACHE: hit"
        exit 0
      fi
    fi
  fi
fi

# Cache miss or expired - proceed with fetch
date_path="$(date +%Y/%m/%d)"
out_dir="/data/generated/web-fetch/${date_path}"
mkdir -p "$out_dir"

if [[ -z "$base_name" ]]; then
  slug="$(echo "$url" | sed 's#^https\?://##' | tr '/:?&=#' '-' | tr -cd '[:alnum:]-._' | cut -c1-120)"
  if [[ -z "$slug" ]]; then
    slug="page"
  fi
else
  slug="$(echo "$base_name" | tr '/:?&=#' '-' | tr -cd '[:alnum:]-._' | cut -c1-80)"
  if [[ -z "$slug" ]]; then
    echo "Error: invalid base-name" >&2
    exit 1
  fi
fi

ts="$(date +%Y%m%d-%H%M%S)"
prefix="${out_dir}/${ts}-${slug}"
html_path="${prefix}.html"
text_path="${prefix}.txt"
meta_path="${prefix}.json"

status=""
if command -v curl >/dev/null 2>&1; then
  status="$(curl -L --silent --show-error --max-time 30 --output "$html_path" --write-out '%{http_code}' "$url")"
elif command -v wget >/dev/null 2>&1; then
  hdr_file="${prefix}.headers"
  wget -q -O "$html_path" --server-response "$url" 2> "$hdr_file"
  status="$(grep -E '^  HTTP/|^HTTP/' "$hdr_file" | tail -n 1 | awk '{print $2}')"
else
  echo "Error: missing dependency: curl or wget" >&2
  exit 1
fi

if [[ ! "$status" =~ ^[0-9]{3}$ ]]; then
  echo "Error: could not determine HTTP status" >&2
  exit 1
fi

if (( status >= 400 )); then
  echo "Error: HTTP $status" >&2
  exit 1
fi

perl -0777 -pe 's/<script\b[^>]*>.*?<\/script>//gis; s/<style\b[^>]*>.*?<\/style>//gis; s/<noscript\b[^>]*>.*?<\/noscript>//gis; s/<[^>]+>/ /g; s/&nbsp;/ /g; s/&amp;/&/g; s/&lt;/</g; s/&gt;/>/g; s/\s+/ /g;' "$html_path" | fold -s -w 120 > "$text_path"

now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{\n  "url": "%s",\n  "status": %s,\n  "fetchedAt": "%s",\n  "htmlPath": "%s",\n  "textPath": "%s"\n}\n' \
  "$url" "$status" "$now_iso" "$html_path" "$text_path" > "$meta_path"

# Update cache
cache_value="{\"timestamp\":\"${now_iso}\",\"text_path\":\"${text_path}\",\"html_path\":\"${html_path}\",\"status_code\":${status}}"
if command -v ambrogioctl >/dev/null 2>&1; then
  ambrogioctl state set "$cache_key" "$cache_value" >/dev/null 2>&1 || true
fi

echo "URL: $url"
echo "STATUS: $status"
echo "HTML: $html_path"
echo "TEXT: $text_path"
echo "META: $meta_path"
echo "CACHE: miss"
