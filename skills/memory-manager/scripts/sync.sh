#!/usr/bin/env bash
# Sync memory database to MEMORY.md file

set -euo pipefail

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Use bun to run ambrogioctl
AMBROGIOCTL="bun run $PROJECT_ROOT/src/cli/ambrogioctl.ts"

OUTPUT="${DATA_ROOT:-/data}/MEMORY.md"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

$AMBROGIOCTL memory sync --output "$OUTPUT"
