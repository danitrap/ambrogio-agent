#!/usr/bin/env bash
set -euo pipefail

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

date_path="$(date +%Y/%m/%d)"
out_dir="/data/generated/web-fetch/${date_path}"
mkdir -p "$out_dir"

if [[ -z "$base_name" ]]; then
  slug="$(echo "$url" | sed 's#^https\?://##' | tr '/:?&=#' '-' | tr -cd '[:alnum:]-._' | cut -c1-120)"
  if [[ -z "$slug" ]]; then
    slug="page"
  fi
else
  slug="$(echo "$base_name" | tr '/:?&=# ' '-' | tr -cd '[:alnum:]-._' | cut -c1-80)"
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

echo "URL: $url"
echo "STATUS: $status"
echo "HTML: $html_path"
echo "TEXT: $text_path"
echo "META: $meta_path"
