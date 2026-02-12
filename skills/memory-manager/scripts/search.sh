#!/usr/bin/env bash
# Search memory entries

set -euo pipefail

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Use bun to run ambrogioctl
AMBROGIOCTL="bun run $PROJECT_ROOT/src/cli/ambrogioctl.ts"

QUERY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --query)
      QUERY="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$QUERY" ]]; then
  echo "Error: --query is required"
  echo "Usage: $0 --query \"<search-term>\""
  exit 1
fi

$AMBROGIOCTL memory search --query "$QUERY"
