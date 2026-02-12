#!/usr/bin/env bash
# List all memory entries

set -euo pipefail

# Use ambrogioctl from PATH
AMBROGIOCTL="ambrogioctl"

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
