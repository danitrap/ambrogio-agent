#!/usr/bin/env bash
# Wrapper script for Python-based GTFS query tool
set -euo pipefail

# Find the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="${SCRIPT_DIR}/check-tram-schedule.py"

# Check if Python script exists
if [[ ! -f "$PYTHON_SCRIPT" ]]; then
  echo "Error: Python script not found at $PYTHON_SCRIPT" >&2
  exit 1
fi

# Check if python3 is available
if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 non disponibile" >&2
  exit 1
fi

# Execute Python script with all arguments
exec python3 "$PYTHON_SCRIPT" "$@"
