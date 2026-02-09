# ambrogioctl State & Conversation Commands

This document describes the state management and conversation management commands available in `ambrogioctl`.

## State Management Commands

State management commands provide CLI access to the SQLite-based runtime key-value store. This is useful for skills that need to track persistent state across executions.

### state get

Retrieve a single runtime value by key.

```bash
# Using positional argument
ambrogioctl state get mykey

# Using flag
ambrogioctl state get --key mykey

# JSON output
ambrogioctl state get mykey --json
```

**Exit codes:**
- `0`: Success
- `2`: Bad request (missing key)
- `3`: Not found (key doesn't exist)
- `10`: Internal error

### state set

Store a runtime value.

```bash
# Using positional arguments
ambrogioctl state set mykey "my value"

# Using flags
ambrogioctl state set --key mykey --value "my value"

# JSON output
ambrogioctl state set mykey "my value" --json
```

**Exit codes:**
- `0`: Success
- `2`: Bad request (missing key or value)
- `10`: Internal error

### state delete

Delete one or more keys.

```bash
# Delete single key
ambrogioctl state delete mykey

# Delete multiple keys
ambrogioctl state delete key1 key2 key3

# JSON output
ambrogioctl state delete key1 key2 --json
```

**Exit codes:**
- `0`: Success
- `2`: Bad request (no keys provided)
- `10`: Internal error

### state list

List all keys, optionally filtered by glob pattern.

```bash
# List all keys
ambrogioctl state list

# List with pattern (glob syntax: * and ?)
ambrogioctl state list --pattern "heartbeat:*"
ambrogioctl state list --pattern "user:*"

# JSON output
ambrogioctl state list --json
```

**Output format:**
- Human-readable: `key=value` (one per line)
- JSON: Array of objects with `key`, `value`, and `updatedAt` fields

**Exit codes:**
- `0`: Success
- `2`: Bad request
- `10`: Internal error

## Conversation Management Commands

Conversation management commands expose conversation history operations for debugging and skill development.

### conversation stats

Get conversation statistics for a user.

```bash
# With explicit user ID
ambrogioctl conversation stats --user-id 123456

# Using environment variable fallback
export TELEGRAM_ALLOWED_USER_ID=123456
ambrogioctl conversation stats

# JSON output
ambrogioctl conversation stats --user-id 123456 --json
```

**Output:**
- `userId`: The user ID
- `entries`: Total conversation entries
- `userTurns`: Number of user messages
- `assistantTurns`: Number of assistant messages
- `hasContext`: Whether any conversation exists

**Exit codes:**
- `0`: Success
- `2`: Bad request (missing user ID)
- `10`: Internal error

### conversation list

List recent conversation entries.

```bash
# Default limit (12 entries)
ambrogioctl conversation list --user-id 123456

# Custom limit
ambrogioctl conversation list --user-id 123456 --limit 5

# Using environment variable for user ID
export TELEGRAM_ALLOWED_USER_ID=123456
ambrogioctl conversation list --limit 10

# JSON output
ambrogioctl conversation list --user-id 123456 --json
```

**Output format:**
- Human-readable: Numbered list with role and truncated text
- JSON: Array of objects with `role` and `text` fields

**Exit codes:**
- `0`: Success
- `2`: Bad request (missing user ID or invalid limit)
- `10`: Internal error

### conversation export

Export full conversation with timestamps.

```bash
# Text format (default)
ambrogioctl conversation export --user-id 123456

# JSON format
ambrogioctl conversation export --user-id 123456 --format json

# Using --json flag (same as --format json)
ambrogioctl conversation export --user-id 123456 --json

# Save to file
ambrogioctl conversation export --user-id 123456 > conversation.txt
```

**Output format:**
- Text: Multi-line format with timestamps and statistics header
- JSON: Full conversation with `entries`, `stats`, and `userId` fields

**Exit codes:**
- `0`: Success
- `2`: Bad request (missing user ID or invalid format)
- `10`: Internal error

### conversation clear

Clear conversation history for a user.

```bash
# Clear conversation
ambrogioctl conversation clear --user-id 123456

# Using environment variable
export TELEGRAM_ALLOWED_USER_ID=123456
ambrogioctl conversation clear

# JSON output
ambrogioctl conversation clear --user-id 123456 --json
```

**Exit codes:**
- `0`: Success
- `2`: Bad request (missing user ID)
- `10`: Internal error

## Usage Examples for Skills

### Heartbeat Responder: Track Notification Times

```bash
#!/bin/bash
# Check if we already notified about disk space recently
LAST_NOTIFIED=$(ambrogioctl state get heartbeat:notified:disk_space 2>/dev/null | cut -d= -f2-)

if [ -z "$LAST_NOTIFIED" ] || [ $(($(date +%s) - $(date -d "$LAST_NOTIFIED" +%s))) -gt 7200 ]; then
  # More than 2 hours ago or never notified
  echo "Disk space is low!"

  # Record notification time
  ambrogioctl state set heartbeat:notified:disk_space "$(date -Iseconds)"
fi
```

### Meal Planning: Avoid Repetition

```bash
#!/bin/bash
# Track last 7 suggested meals
for i in {0..6}; do
  MEAL=$(ambrogioctl state get meal:recent:$i 2>/dev/null | cut -d= -f2-)
  if [ "$MEAL" == "pasta carbonara" ]; then
    echo "Already suggested pasta carbonara recently, skipping..."
    exit 0
  fi
done

# Suggest meal and rotate history
ambrogioctl state set meal:recent:0 "pasta carbonara"
```

### Grocery List: Track Recently Added Items

```bash
#!/bin/bash
ITEM="milk"
LAST_ADDED=$(ambrogioctl state get grocery:last_added:$ITEM 2>/dev/null | cut -d= -f2-)

if [ -n "$LAST_ADDED" ]; then
  HOURS_AGO=$(( ($(date +%s) - $(date -d "$LAST_ADDED" +%s)) / 3600 ))
  if [ $HOURS_AGO -lt 24 ]; then
    echo "$ITEM was already added $HOURS_AGO hours ago"
    exit 0
  fi
fi

# Add item to list
echo "Adding $ITEM to grocery list..."
ambrogioctl state set grocery:last_added:$ITEM "$(date -Iseconds)"
```

### Text-to-Speech: Cache Audio Generation

```bash
#!/bin/bash
TEXT="Hello world"
TEXT_HASH=$(echo -n "$TEXT" | sha256sum | cut -d' ' -f1)
CACHED=$(ambrogioctl state get tts:generated:$TEXT_HASH 2>/dev/null)

if [ -n "$CACHED" ]; then
  echo "Using cached audio for: $TEXT"
  exit 0
fi

# Generate audio
echo "Generating audio for: $TEXT"
# ... generation code ...

# Cache the result
ambrogioctl state set tts:generated:$TEXT_HASH "$(date -Iseconds)"
```

### Fetch URL: Cache with Timestamps

```bash
#!/bin/bash
URL="https://example.com/api/data"
URL_HASH=$(echo -n "$URL" | sha256sum | cut -d' ' -f1)
CACHED_TIME=$(ambrogioctl state get url:cached:$URL_HASH 2>/dev/null | cut -d= -f2-)

if [ -n "$CACHED_TIME" ]; then
  AGE=$(( $(date +%s) - $(date -d "$CACHED_TIME" +%s) ))
  if [ $AGE -lt 300 ]; then
    echo "Using cached data (age: ${AGE}s)"
    exit 0
  fi
fi

# Fetch URL
echo "Fetching: $URL"
# ... fetch code ...

# Update cache timestamp
ambrogioctl state set url:cached:$URL_HASH "$(date -Iseconds)"
```

## Pattern Matching

The `state list --pattern` command supports glob-style pattern matching:

- `*` matches any sequence of characters
- `?` matches any single character

Examples:

```bash
# All heartbeat keys
ambrogioctl state list --pattern "heartbeat:*"

# All user-specific keys
ambrogioctl state list --pattern "user:*:*"

# Specific pattern
ambrogioctl state list --pattern "cache:????"
```

## Environment Variables

- `AMBROGIO_SOCKET_PATH`: Path to the RPC socket (default: `/tmp/ambrogio-agent.sock`)
- `TELEGRAM_ALLOWED_USER_ID`: Default user ID for conversation commands

## Notes

- All state values are stored as strings
- Keys and values are trimmed and must not be empty
- Conversation commands require a valid user ID
- The conversation history is limited by the `maxEntries` parameter (default: 12)
- Pattern matching uses SQL LIKE syntax internally (`*` → `%`, `?` → `_`)
