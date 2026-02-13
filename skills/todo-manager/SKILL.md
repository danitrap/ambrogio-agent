---
name: todo-manager
description: Manage TODO tasks in /data/TODO.md with minimal CRUD operations (add, complete, remove, show) using simple markdown checkboxes. Tracks task metadata like creation and completion times.
---

# TODO Manager

Manage tasks in `/data/TODO.md` using a minimal checklist format.

## File contract

- Target file: `/data/TODO.md`
- Format: markdown checklist only
  - Open task: `- [ ] Task text`
  - Completed task: `- [x] Task text`
- Keep a single section unless the file already has additional sections.
- Preserve existing lines that are not task lines.

## If file is missing

Create `/data/TODO.md` with:

```md
# TODO

- [ ] First task
```

## Supported operations

- Add task:
  - Append as `- [ ] ...`.
  - Avoid exact duplicates (case-insensitive trimmed match).
  - Track metadata: store creation time in state (`todo:meta:<task_hash>`).
- Complete task:
  - Convert matching `- [ ]` to `- [x]`.
  - If multiple matches, update all obvious matches and report count.
  - Track metadata: update with completion time and calculate duration.
- Reopen task:
  - Convert matching `- [x]` to `- [ ]` when user asks to reopen/riaprire.
  - Update metadata: clear completion time.
- Remove task:
  - Remove matching checklist lines only.
  - Optionally clean up metadata (optional - old metadata can persist for analytics).
- Show/list tasks:
  - Summarize open and completed counts.
  - Show open tasks first.
  - Optional: show age of oldest open tasks using metadata.

## Task Metadata Tracking

The skill tracks task lifecycle using `ambrogioctl state`:

- **Key format**: `todo:meta:<sha256_hash_of_task_text>`
- **Value format**: JSON with `created_at`, `completed_at`, `reopened_at`, `priority_score`
- **No TTL**: Metadata persists for analytics

### Recording Metadata

When adding a task:
```bash
task_text="Buy milk"
task_hash=$(echo -n "$task_text" | sha256sum | cut -d' ' -f1)
cache_key="todo:meta:${task_hash}"

# Store creation timestamp
ambrogioctl state set "$cache_key" "{\"created_at\":\"$(date -Iseconds)\",\"completed_at\":null,\"reopened_at\":null,\"priority_score\":0}"
```

When completing a task:
```bash
# Update with completion time
current_data=$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2-)
if [[ -n "$current_data" ]]; then
  created_at=$(echo "$current_data" | grep -o '"created_at":"[^"]*"' | cut -d'"' -f4)
  ambrogioctl state set "$cache_key" "{\"created_at\":\"$created_at\",\"completed_at\":\"$(date -Iseconds)\",\"reopened_at\":null,\"priority_score\":0}"
fi
```

### Calculating Task Age

```bash
get_task_age() {
  local task_text="$1"
  local task_hash=$(echo -n "$task_text" | sha256sum | cut -d' ' -f1)
  local cache_key="todo:meta:${task_hash}"
  
  local meta=$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2-)
  if [[ -n "$meta" ]]; then
    local created=$(echo "$meta" | grep -o '"created_at":"[^"]*"' | cut -d'"' -f4)
    local created_epoch=$(date -d "$created" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$created" +%s 2>/dev/null)
    local now_epoch=$(date +%s)
    local age_days=$(( (now_epoch - created_epoch) / 86400 ))
    echo "$age_days"
  else
    echo "unknown"
  fi
}

# Example usage
age=$(get_task_age "Buy milk")
echo "Task is $age days old"
```

### Priority Scoring

Use age and other factors to calculate priority:

```bash
calculate_priority() {
  local task_text="$1"
  local age_days="$2"
  local has_due_date="$3"  # true/false
  
  local score=0
  
  # Older tasks get higher priority
  if [[ "$age_days" -gt 7 ]]; then
    score=$((score + 10))
  elif [[ "$age_days" -gt 3 ]]; then
    score=$((score + 5))
  fi
  
  # Tasks with due dates get bonus
  if [[ "$has_due_date" == "true" ]]; then
    score=$((score + 3))
  fi
  
  # Keyword-based priority
  if echo "$task_text" | grep -qi "urgent\|important\|asap\|deadline"; then
    score=$((score + 5))
  fi
  
  echo "$score"
}
```

## Analytics Queries

```bash
# List all task metadata
ambrogioctl state list --pattern "todo:meta:*"

# Find stale tasks (not completed, created > 30 days ago)
# This requires iterating through metadata entries

# Get completion rate for recent period
# Count completed_at timestamps within date range
```

## Matching rules

- Prefer exact text match (normalized whitespace, case-insensitive).
- If user references an index (e.g. "task 2"), map to visible open-task order unless user says otherwise.
- If ambiguous, ask one concise clarifying question.

## Response style

- Be concise and operational.
- After modifications, report:
  - action performed,
  - affected task(s),
  - updated open/completed totals.
- Optional: mention task age for old open tasks (>7 days).

## Example Workflow with Metadata

```bash
#!/bin/bash

add_task() {
  local task="$1"
  local todo_file="/data/TODO.md"
  
  # Add to file
  echo "- [ ] $task" >> "$todo_file"
  
  # Record metadata
  local task_hash=$(echo -n "$task" | sha256sum | cut -d' ' -f1)
  ambrogioctl state set "todo:meta:${task_hash}" \
    "{\"created_at\":\"$(date -Iseconds)\",\"completed_at\":null,\"reopened_at\":null,\"priority_score\":0}"
  
  echo "Added: $task"
}

complete_task() {
  local task="$1"
  local todo_file="/data/TODO.md"
  
  # Mark complete in file (simplified - actual implementation needs proper matching)
  sed -i "s/- \[ \] $task/- [x] $task/" "$todo_file"
  
  # Update metadata
  local task_hash=$(echo -n "$task" | sha256sum | cut -d' ' -f1)
  local cache_key="todo:meta:${task_hash}"
  local existing=$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2-)
  
  if [[ -n "$existing" ]]; then
    local created=$(echo "$existing" | grep -o '"created_at":"[^"]*"' | cut -d'"' -f4)
    ambrogioctl state set "$cache_key" \
      "{\"created_at\":\"$created\",\"completed_at\":\"$(date -Iseconds)\",\"reopened_at\":null,\"priority_score\":0}"
  fi
  
  echo "Completed: $task"
}
```

## Sync Analytics

Generate analytics report from task metadata:

```bash
# Generate analytics with completion rates, durations, and long-running tasks
ambrogioctl sync generate --skill todo-manager

# View the analytics
cat /data/TODO_ANALYTICS.md
```

The analytics report includes:
- Completion rate statistics
- Average task completion time
- Recently completed tasks with durations
- Long-running open tasks sorted by age
```
