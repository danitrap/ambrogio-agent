#!/usr/bin/env bash
# List all memory entries

set -euo pipefail

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Use bun to run ambrogioctl
AMBROGIOCTL="bun run $PROJECT_ROOT/src/cli/ambrogioctl.ts"

TYPE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      TYPE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -n "$TYPE" ]]; then
  $AMBROGIOCTL memory list --type "$TYPE"
else
  $AMBROGIOCTL memory list
fi
