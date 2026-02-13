#!/usr/bin/env bash
# Sync structured notes to NOTES.md

set -euo pipefail

# Use ambrogioctl from PATH
AMBROGIOCTL="ambrogioctl"

# Use environment variable if set, otherwise use default
OUTPUT="${SYNC_OUTPUT_FILE:-${DATA_ROOT:-/data}/NOTES.md}"

# Get all notes entries
notes_json=$($AMBROGIOCTL state list --pattern "notes:entry:*" --json 2>/dev/null || echo '{"entries":[]}')

# Generate markdown
cat > "$OUTPUT" <<'HEADER'
# Structured Notes

Generated from SQLite state store.

HEADER

# Parse and format notes by type
echo "$notes_json" | python3 - "$OUTPUT" <<'PY'
import json
import sys
from datetime import datetime

notes_json = sys.stdin.read()
output_file = sys.argv[1]

try:
    data = json.loads(notes_json)
    entries = data.get('entries', [])

    # Parse notes
    notes = []
    for entry in entries:
        try:
            note = json.loads(entry['value'])
            notes.append(note)
        except:
            continue

    # Sort by created_at (newest first)
    notes.sort(key=lambda x: x.get('created_at', ''), reverse=True)

    # Group by type
    by_type = {}
    for note in notes:
        note_type = note.get('type', 'other')
        if note_type not in by_type:
            by_type[note_type] = []
        by_type[note_type].append(note)

    # Write to file
    with open(output_file, 'a') as f:
        if not notes:
            f.write("\n## No Notes Yet\n\n")
            f.write("Use `ambrogioctl state set` to create notes.\n")
        else:
            for note_type in ['project', 'decision', 'log']:
                if note_type not in by_type:
                    continue

                f.write(f"\n## {note_type.title()} Notes\n\n")

                for note in by_type[note_type]:
                    title = note.get('title', 'Untitled')
                    status = note.get('status', 'open')
                    tags = note.get('tags', [])
                    project = note.get('project')
                    body = note.get('body', '')
                    created = note.get('created_at', '')

                    f.write(f"### {title}\n\n")
                    f.write(f"**Status:** {status}")
                    if project:
                        f.write(f" | **Project:** {project}")
                    if tags:
                        f.write(f" | **Tags:** {', '.join(tags)}")
                    f.write(f"\n**Created:** {created}\n\n")
                    f.write(f"{body}\n\n")
                    f.write("---\n\n")

except Exception as e:
    with open(output_file, 'a') as f:
        f.write(f"\nError parsing notes: {e}\n")

PY

echo "Notes synced to $OUTPUT"
