#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <approval-id>" >&2
  exit 1
fi

id="$1"
root="/data/runtime/approval-gate"
cmd_file="${root}/${id}.sh"
meta_file="${root}/${id}.meta"
log_file="${root}/${id}.log"

if [[ ! -f "$cmd_file" || ! -f "$meta_file" ]]; then
  echo "Error: approval id not found: $id" >&2
  exit 1
fi

if grep -q '^status=executed$' "$meta_file"; then
  echo "Error: approval id already executed: $id" >&2
  exit 1
fi

set +e
"$cmd_file" > "$log_file" 2>&1
exit_code=$?
set -e

if [[ $exit_code -eq 0 ]]; then
  sed -i '' 's/^status=pending$/status=executed/' "$meta_file" 2>/dev/null || sed -i 's/^status=pending$/status=executed/' "$meta_file"
else
  sed -i '' 's/^status=pending$/status=failed/' "$meta_file" 2>/dev/null || sed -i 's/^status=pending$/status=failed/' "$meta_file"
fi

printf 'APPROVAL_ID=%s\n' "$id"
printf 'EXIT_CODE=%s\n' "$exit_code"
printf 'LOG=%s\n' "$log_file"
exit "$exit_code"
