---
name: grocery-list-manager
description: Manage and update the user's grocery list stored in the local file groceries.md. Use when the user asks to add, remove, update, or review items in their grocery list or pantry. Tracks purchase history and frequency for smart suggestions.
---

# Grocery List Manager

## Workflow

- Locate the grocery list file in `/data`: prefer `groceries.md`;
- Preserve the existing format if the file already has structure.
- If no file exists, create `groceries.md` with a simple Markdown structure:
  - Title line: `# Groceries`
  - Section: `## To Buy`
  - Section: `## In Pantry`
  - Optional: `## Notes`
- Apply the user's requested changes (add, remove, rename, mark purchased).
- Keep items as Markdown bullet lines (`- item`).
- Track purchase history in state when items move from `## To Buy` to `## In Pantry`.

## Editing Rules

- When marking an item as purchased, move it from `## To Buy` to `## In Pantry` unless the user asks for a different behavior.
- When removing, delete only the matching item line.
- When adding, keep items alphabetized within their section if the file is already alphabetized; otherwise append to the end of the section.
- Preserve comments, blank lines, and any extra sections that exist.

## Purchase History Tracking

The skill tracks purchase patterns using `ambrogioctl state`:

- **Key format**: `grocery:frequency:<normalized_item_name>`
- **Value format**: JSON with `purchase_count`, `last_purchased`, `avg_days_between`, `first_purchased`
- **No TTL**: History persists for analytics and smart suggestions
- **Item normalization**: Lowercase, remove quantities (e.g., "2x Milk" → "milk")

### Recording a Purchase

When an item moves from "To Buy" to "In Pantry":

```bash
record_purchase() {
  local item="$1"
  
  # Normalize item name (lowercase, remove quantities and common prefixes)
  local normalized=$(echo "$item" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[0-9]+x?\s*//g' | sed -E 's/^[0-9]+\s*(kg|g|ml|l|lb|oz)\s*//gi' | sed 's/^ *//;s/ *$//')
  local cache_key="grocery:frequency:${normalized}"
  
  # Get existing data
  local existing=$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2-)
  local now=$(date -Iseconds)
  
  if [[ -z "$existing" ]]; then
    # First purchase
    ambrogioctl state set "$cache_key" \
      "{\"purchase_count\":1,\"last_purchased\":\"$now\",\"first_purchased\":\"$now\",\"avg_days_between\":0}"
  else
    # Update existing
    local count=$(echo "$existing" | grep -o '"purchase_count":[0-9]*' | cut -d':' -f2)
    local last=$(echo "$existing" | grep -o '"last_purchased":"[^"]*"' | cut -d'"' -f4)
    local first=$(echo "$existing" | grep -o '"first_purchased":"[^"]*"' | cut -d'"' -f4)
    
    local new_count=$((count + 1))
    
    # Calculate average days between purchases
    local last_epoch=$(date -d "$last" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$last" +%s 2>/dev/null)
    local now_epoch=$(date +%s)
    local days_since_last=$(( (now_epoch - last_epoch) / 86400 ))
    
    if [[ $count -eq 1 ]]; then
      # Second purchase
      local avg_days=$days_since_last
    else
      # Update rolling average
      local prev_avg=$(echo "$existing" | grep -o '"avg_days_between":[0-9]*' | cut -d':' -f2)
      local avg_days=$(( (prev_avg * (count - 1) + days_since_last) / count ))
    fi
    
    ambrogioctl state set "$cache_key" \
      "{\"purchase_count\":$new_count,\"last_purchased\":\"$now\",\"first_purchased\":\"$first\",\"avg_days_between\":$avg_days}"
  fi
}
```

### Smart Suggestions

Suggest items based on purchase patterns:

```bash
suggest_items() {
  local suggestions=()
  
  # Get all tracked items
  local keys=$(ambrogioctl state list --pattern "grocery:frequency:*" --json 2>/dev/null | jq -r '.entries[].key' 2>/dev/null)
  
  for key in $keys; do
    local data=$(ambrogioctl state get "$key" 2>/dev/null | cut -d= -f2-)
    if [[ -n "$data" ]]; then
      local item=$(echo "$key" | sed 's/^grocery:frequency://')
      local last=$(echo "$data" | grep -o '"last_purchased":"[^"]*"' | cut -d'"' -f4)
      local avg=$(echo "$data" | grep -o '"avg_days_between":[0-9]*' | cut -d':' -f2)
      
      local last_epoch=$(date -d "$last" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$last" +%s 2>/dev/null)
      local now_epoch=$(date +%s)
      local days_since=$(( (now_epoch - last_epoch) / 86400 ))
      
      # Suggest if we're past the average purchase interval
      if [[ $avg -gt 0 && $days_since -ge $avg ]]; then
        local days_overdue=$((days_since - avg))
        suggestions+=("$item (purchased ${days_since}d ago, avg every ${avg}d, ${days_overdue}d overdue)")
      fi
    fi
  done
  
  if [[ ${#suggestions[@]} -gt 0 ]]; then
    echo "Suggested items to buy:"
    printf '%s\n' "${suggestions[@]}"
  else
    echo "No suggestions based on purchase history."
  fi
}
```

### Purchase Statistics

```bash
get_item_stats() {
  local item="$1"
  local normalized=$(echo "$item" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[0-9]+x?\s*//g' | sed -E 's/^[0-9]+\s*(kg|g|ml|l|lb|oz)\s*//gi' | sed 's/^ *//;s/ *$//')
  local cache_key="grocery:frequency:${normalized}"
  
  local data=$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2-)
  if [[ -n "$data" ]]; then
    local count=$(echo "$data" | grep -o '"purchase_count":[0-9]*' | cut -d':' -f2)
    local last=$(echo "$data" | grep -o '"last_purchased":"[^"]*"' | cut -d'"' -f4)
    local avg=$(echo "$data" | grep -o '"avg_days_between":[0-9]*' | cut -d':' -f2)
    
    echo "Item: $item"
    echo "  Purchases: $count"
    echo "  Last bought: $last"
    echo "  Avg interval: ${avg} days"
  else
    echo "No purchase history for: $item"
  fi
}
```

### Analytics Commands

```bash
# List all tracked items
ambrogioctl state list --pattern "grocery:frequency:*"

# Find frequently purchased items (>= 5 times)
# Requires iterating through entries

# Clear old history (> 1 year)
# Optional cleanup for obsolete items
```

## Quick Checks

- If the user is ambiguous about which section to edit, ask a brief clarifying question.
- If the file uses a different format, follow that format and avoid reformatting the whole file.
- When marking items as purchased, automatically update purchase history in state.

## Example Usage with History

```bash
#!/bin/bash

# Mark milk as purchased (moves to In Pantry)
mark_purchased() {
  local item="$1"
  local groceries_file="/data/groceries.md"
  
  # Move item in file (simplified)
  # In real implementation, parse and modify markdown properly
  
  # Record in history
  record_purchase "$item"
  
  echo "Marked as purchased: $item"
}

# Add new item with frequency info
add_item() {
  local item="$1"
  local groceries_file="/data/groceries.md"
  
  # Add to file
  # ...
  
  # Check if we have history for this item
  local normalized=$(echo "$item" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[0-9]+x?\s*//g')
  local cache_key="grocery:frequency:${normalized}"
  local history=$(ambrogioctl state get "$cache_key" 2>/dev/null | cut -d= -f2-)
  
  if [[ -n "$history" ]]; then
    local count=$(echo "$history" | grep -o '"purchase_count":[0-9]*' | cut -d':' -f2)
    local avg=$(echo "$history" | grep -o '"avg_days_between":[0-9]*' | cut -d':' -f2)
    echo "Added: $item (bought $count times before, avg every $avg days)"
  else
    echo "Added: $item (new item)"
  fi
}
```
