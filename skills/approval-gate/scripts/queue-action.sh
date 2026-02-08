#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <description> <command>" >&2
  exit 1
fi

description="$1"
command_string="$2"

if [[ -z "$description" || -z "$command_string" ]]; then
  echo "Error: description and command must be non-empty" >&2
  exit 1
fi

root="/data/runtime/approval-gate"
mkdir -p "$root"

id="$(date +%Y%m%d-%H%M%S)-$$"
cmd_file="${root}/${id}.sh"
meta_file="${root}/${id}.meta"

cat > "$cmd_file" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
$command_string
SCRIPT
chmod 700 "$cmd_file"

cat > "$meta_file" <<META
id=$id
status=pending
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
description=$description
META

printf 'APPROVAL_ID=%s\n' "$id"
printf 'DESCRIPTION=%s\n' "$description"
printf 'RUN= bash /data/.codex/skills/approval-gate/scripts/run-action.sh "%s"\n' "$id"
