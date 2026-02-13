#!/usr/bin/env bash
# Sync TODO metadata to analytics report

set -euo pipefail

# Use ambrogioctl from PATH
AMBROGIOCTL="ambrogioctl"

# Use environment variable if set, otherwise use default
OUTPUT="${SYNC_OUTPUT_FILE:-${DATA_ROOT:-/data}/TODO_ANALYTICS.md}"

# Get all todo metadata entries
metadata_json=$($AMBROGIOCTL state list --pattern "todo:meta:*" --json 2>/dev/null || echo '{"entries":[]}')

# Generate analytics report
cat > "$OUTPUT" <<'HEADER'
# TODO Analytics

Generated from task metadata in SQLite state store.

HEADER

# Parse and generate analytics
echo "$metadata_json" | python3 - "$OUTPUT" <<'PY'
import json
import sys
from datetime import datetime, timezone
from collections import defaultdict

metadata_json = sys.stdin.read()
output_file = sys.argv[1]

try:
    data = json.loads(metadata_json)
    entries = data.get('entries', [])

    # Parse metadata
    tasks = []
    for entry in entries:
        try:
            meta = json.loads(entry['value'])
            tasks.append(meta)
        except:
            continue

    with open(output_file, 'a') as f:
        if not tasks:
            f.write("\n## No Task Metadata\n\n")
            f.write("Tasks will appear here once you add them to TODO.md.\n")
        else:
            # Statistics
            total_tasks = len(tasks)
            completed_tasks = [t for t in tasks if t.get('completed_at')]
            open_tasks = [t for t in tasks if not t.get('completed_at')]

            f.write(f"\n## Summary\n\n")
            f.write(f"- **Total tracked tasks:** {total_tasks}\n")
            f.write(f"- **Completed:** {len(completed_tasks)}\n")
            f.write(f"- **Open:** {len(open_tasks)}\n\n")

            # Completion rate
            if total_tasks > 0:
                completion_rate = (len(completed_tasks) / total_tasks) * 100
                f.write(f"- **Completion rate:** {completion_rate:.1f}%\n\n")

            # Average completion time
            durations = []
            for task in completed_tasks:
                created = task.get('created_at')
                completed = task.get('completed_at')
                if created and completed:
                    try:
                        c_time = datetime.fromisoformat(created.replace('Z', '+00:00'))
                        comp_time = datetime.fromisoformat(completed.replace('Z', '+00:00'))
                        duration = (comp_time - c_time).total_seconds()
                        durations.append(duration)
                    except:
                        pass

            if durations:
                avg_duration = sum(durations) / len(durations)
                hours = avg_duration / 3600
                f.write(f"- **Average completion time:** {hours:.1f} hours\n\n")

            # Recently completed
            if completed_tasks:
                f.write("\n## Recently Completed\n\n")
                completed_tasks.sort(key=lambda x: x.get('completed_at', ''), reverse=True)
                for task in completed_tasks[:10]:
                    text = task.get('task_text', 'Unknown')
                    completed_at = task.get('completed_at', '')
                    created_at = task.get('created_at', '')

                    f.write(f"- **{text}**\n")
                    f.write(f"  - Created: {created_at}\n")
                    f.write(f"  - Completed: {completed_at}\n")

                    if created_at and completed_at:
                        try:
                            c_time = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                            comp_time = datetime.fromisoformat(completed_at.replace('Z', '+00:00'))
                            duration = (comp_time - c_time).total_seconds()
                            hours = duration / 3600
                            f.write(f"  - Duration: {hours:.1f} hours\n")
                        except:
                            pass
                    f.write("\n")

            # Long-running open tasks
            if open_tasks:
                f.write("\n## Long-Running Open Tasks\n\n")
                now = datetime.now(timezone.utc)

                # Calculate age for each open task
                aged_tasks = []
                for task in open_tasks:
                    created = task.get('created_at')
                    if created:
                        try:
                            c_time = datetime.fromisoformat(created.replace('Z', '+00:00'))
                            age = (now - c_time).total_seconds()
                            aged_tasks.append((task, age))
                        except:
                            pass

                # Sort by age (oldest first)
                aged_tasks.sort(key=lambda x: x[1], reverse=True)

                for task, age in aged_tasks[:10]:
                    text = task.get('task_text', 'Unknown')
                    created_at = task.get('created_at', '')
                    hours = age / 3600
                    days = age / 86400

                    f.write(f"- **{text}**\n")
                    f.write(f"  - Created: {created_at}\n")
                    if days >= 1:
                        f.write(f"  - Age: {days:.1f} days\n")
                    else:
                        f.write(f"  - Age: {hours:.1f} hours\n")
                    f.write("\n")

except Exception as e:
    with open(output_file, 'a') as f:
        f.write(f"\nError generating analytics: {e}\n")

PY

echo "TODO analytics synced to $OUTPUT"
