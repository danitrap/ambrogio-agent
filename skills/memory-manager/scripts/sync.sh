#!/usr/bin/env bash
# Sync memory database to MEMORY.md file

set -euo pipefail

# Use ambrogioctl from PATH
AMBROGIOCTL="ambrogioctl"

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
