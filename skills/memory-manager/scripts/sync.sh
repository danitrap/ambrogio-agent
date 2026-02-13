#!/usr/bin/env bash
# Sync memory database to MEMORY.md file

set -euo pipefail

# Use ambrogioctl from PATH
AMBROGIOCTL="ambrogioctl"

# Use environment variable if set (new way), otherwise use default (old way)
OUTPUT="${SYNC_OUTPUT_FILE:-${DATA_ROOT:-/data}/MEMORY.md}"

# Parse command line args for backward compatibility
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
