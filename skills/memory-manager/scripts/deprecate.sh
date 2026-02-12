#!/usr/bin/env bash
# Deprecate a memory entry (mark as superseded)

set -euo pipefail

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Use bun to run ambrogioctl
AMBROGIOCTL="bun run $PROJECT_ROOT/src/cli/ambrogioctl.ts"

ID=""
TYPE=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)
      ID="$2"
      shift 2
      ;;
    --type)
      TYPE="$2"
      shift 2
      ;;
    --reason)
      REASON="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$ID" ]] || [[ -z "$TYPE" ]]; then
  echo "Error: --id and --type are required"
  echo "Usage: $0 --id <memory-id> --type <preference|fact|pattern> --reason \"<reason>\""
  exit 1
fi

# Get current memory
CURRENT=$($AMBROGIOCTL memory get --id "$ID" --type "$TYPE" --json 2>/dev/null || echo "{}")

if [[ "$CURRENT" == "{}" ]]; then
  echo "Error: Memory not found: $TYPE:$ID"
  exit 1
fi

# Parse current data and update status
UPDATED=$(echo "$CURRENT" | jq -r '.data' | jq --arg reason "$REASON" '. + {status: "deprecated", deprecatedReason: $reason, updatedAt: (now | todate)}')

# Delete old entry
$AMBROGIOCTL memory delete --id "$ID" --type "$TYPE" >/dev/null

# Re-add with updated data
echo "$UPDATED" | jq -r '@json' | xargs -I {} $AMBROGIOCTL state set --key "memory:$TYPE:$ID" --value {}

echo "Memory deprecated: $TYPE:$ID"
echo "Reason: $REASON"
