---
name: memory-manager
description: Manages Ambrogio's long-term semantic memory system. Provides tools for capturing, retrieving, and managing semantic memories that persist across sessions.
---

# memory-manager

Manages Ambrogio's long-term semantic memory system.

## Overview

This skill provides tools for capturing, retrieving, and managing semantic memories that persist across sessions. Memories are stored in both SQLite (source of truth) and `/data/MEMORY.md` (human-readable interface).

## Memory Types

1. **Preferences** - User's explicit choices and preferences
   - Tools, libraries, frameworks (e.g., "usa sempre bun")
   - Communication style (e.g., "parla formale")
   - Workflows and methodologies

2. **Facts** - Contextual information and knowledge
   - Credentials, passwords, API keys
   - Server IPs, URLs, endpoints
   - Project-specific details

3. **Patterns** - Observed behavioral patterns
   - Habits and tendencies
   - Common mistakes or oversights
   - Recurring needs

## Commands

### Add Memory

```bash
./scripts/add.sh --type <preference|fact|pattern> --content "<text>" [options]
```

**Options:**
- `--type` (required): Memory type (preference, fact, pattern)
- `--content` (required): Memory content
- `--source` (optional): Source (explicit, extracted) - defaults to "explicit"
- `--confidence` (optional): Confidence score 0-100 - defaults to 100
- `--tags` (optional): Comma-separated tags
- `--context` (optional): Additional context about the memory

**Example:**
```bash
./scripts/add.sh --type preference --content "usa sempre bun per i progetti TypeScript" --tags "tooling,package-manager"
```

### Search Memory

```bash
./scripts/search.sh --query "<search-query>"
```

Searches memory content and tags for the given query.

**Example:**
```bash
./scripts/search.sh --query "bun"
```

### List Memories

```bash
./scripts/list.sh [--type <type>]
```

Lists all memories, optionally filtered by type.

**Example:**
```bash
./scripts/list.sh --type preference
```

### Sync Memory

```bash
./scripts/sync.sh
```

Regenerates `/data/MEMORY.md` from SQLite database. Run this after manual edits to the database or when you want to ensure the file is up-to-date.

### Deprecate Memory

```bash
./scripts/deprecate.sh --id <memory-id> --reason "<reason>"
```

Marks a memory as deprecated (superseded by newer information).

**Example:**
```bash
./scripts/deprecate.sh --id mem-2026-02-12-abc123 --reason "User now prefers npm over bun"
```

## Usage Patterns

### Explicit Capture

When user says "ricorda che..." or "remember that...":

```bash
./scripts/add.sh --type preference --content "usa sempre bun" --context "User explicitly requested to remember this"
```

### Quick Search

When you need to check user preferences before suggesting something:

```bash
./scripts/search.sh --query "package manager"
```

### View All

To understand user's overall preferences and context:

```bash
./scripts/list.sh
# or read the human-readable file:
cat /data/MEMORY.md
```

## Integration with Heartbeat

The heartbeat system automatically receives top 5 active memories (confidence > 80%) for proactive reminders. No manual action needed.

## Memory Lifecycle

1. **Creation**: Via explicit capture or (future) automatic extraction
2. **Active**: Memory is being used and accessed regularly
3. **Deprecated**: Memory superseded by newer information (marked but not deleted)
4. **Archived**: Old memories no longer relevant (hidden from MEMORY.md)

## Best Practices

1. **Be specific**: Good: "usa sempre bun per progetti TypeScript". Bad: "usa bun"
2. **Add tags**: Makes searching more effective
3. **Set confidence**: Use lower confidence for uncertain/inferred patterns
4. **Check first**: Before adding, search to avoid duplicates
5. **Deprecate, don't delete**: Preserve history by marking as deprecated instead of deleting

## Technical Details

- **Storage**: SQLite `runtime_kv` table with pattern `memory:<type>:<id>`
- **Format**: JSON with full metadata (timestamps, tags, confidence, etc.)
- **Access**: Via RPC (`ambrogioctl memory`) or direct file read (`/data/MEMORY.md`)
- **Sync**: Bidirectional - edits to MEMORY.md should be synced back with `sync.sh`
