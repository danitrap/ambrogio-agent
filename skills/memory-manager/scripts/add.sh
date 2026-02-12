#!/usr/bin/env bash
# Add a new memory entry

set -euo pipefail

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Use bun to run ambrogioctl
AMBROGIOCTL="bun run $PROJECT_ROOT/src/cli/ambrogioctl.ts"

# Parse arguments
TYPE=""
CONTENT=""
SOURCE="explicit"
CONFIDENCE="100"
TAGS=""
CONTEXT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      TYPE="$2"
      shift 2
      ;;
    --content)
      CONTENT="$2"
      shift 2
      ;;
    --source)
      SOURCE="$2"
      shift 2
      ;;
    --confidence)
      CONFIDENCE="$2"
      shift 2
      ;;
    --tags)
      TAGS="$2"
      shift 2
      ;;
    --context)
      CONTEXT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate required arguments
if [[ -z "$TYPE" ]] || [[ -z "$CONTENT" ]]; then
  echo "Error: --type and --content are required"
  echo "Usage: $0 --type <preference|fact|pattern> --content \"<text>\" [options]"
  exit 1
fi

# Build command
CMD="$AMBROGIOCTL memory add --type \"$TYPE\" --content \"$CONTENT\" --source \"$SOURCE\" --confidence \"$CONFIDENCE\""

if [[ -n "$TAGS" ]]; then
  CMD="$CMD --tags \"$TAGS\""
fi

if [[ -n "$CONTEXT" ]]; then
  CMD="$CMD --context \"$CONTEXT\""
fi

# Execute
eval "$CMD"
