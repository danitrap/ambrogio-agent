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

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "Error: agent-browser is required." >&2
  exit 1
fi

date_path="$(date +%Y/%m/%d)"
out_dir="/data/generated/screenshots/${date_path}"
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
out_path="${out_dir}/${ts}-${slug}.png"
session="screenshot-${ts}-$$"

cleanup() {
  agent-browser --session "$session" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! agent-browser --session "$session" open "$url"; then
  echo "Error: agent-browser open failed." >&2
  exit 1
fi

if ! agent-browser --session "$session" screenshot --full "$out_path"; then
  echo "Error: agent-browser screenshot failed. Install browser/deps with: agent-browser install --with-deps" >&2
  exit 1
fi

size="$(wc -c < "$out_path" | tr -d ' ')"
echo "URL: $url"
echo "PNG: $out_path"
echo "SIZE: $size"
