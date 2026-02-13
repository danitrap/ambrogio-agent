# Generic Skill Sync System Design

**Date:** 2026-02-13
**Status:** Approved
**Version:** 1.0

## Overview

Enable skills to sync their SQLite state to human-readable markdown files for auditability. The system uses a lightweight convention-based approach where skills declare sync configuration in a SYNC.json manifest and provide a custom generator script.

## Motivation

The memory-manager skill successfully syncs SQLite → MEMORY.md for auditability. Other skills with user-facing data (structured-notes) could benefit from the same pattern. Rather than hardcoding sync logic per skill, we need a generic system that:

- Allows skills to declare sync intent via manifest
- Gives skills full control over data formatting
- Provides discovery and orchestration via CLI
- Keeps the implementation simple and extensible

## Goals

1. **Auditability** - User-facing data visible in human-readable files
2. **Skill autonomy** - Each skill owns its data format and presentation
3. **Simplicity** - Minimal new infrastructure, leverage existing patterns
4. **Extensibility** - Easy for new skills to add sync capability

## Non-Goals (Phase 1)

- Bidirectional sync (disk → SQLite)
- Auto-sync on write
- Shared formatting library
- Multiple output formats beyond markdown
- Sync for analytics/metadata (only user-facing data)

## Architecture

### Key Principles

- **Explicit control** - Skills call `ambrogioctl sync generate` when they want to sync
- **Convention over configuration** - Simple manifest format + generator script pattern
- **Skill autonomy** - Each skill owns its data format and presentation
- **Read-only for now** - Generated files are documentation, not primary storage

### Components

1. **SYNC.json manifest** - Declares sync configuration per skill
2. **Generator script** - Skill-owned script that formats SQLite → markdown
3. **ambrogioctl sync** - CLI command to discover manifests and run generators
4. **Skill bootstrap** - Optional auto-sync during skill initialization

## SYNC.json Manifest Schema

Each skill that wants sync capabilities creates a `SYNC.json` file alongside `SKILL.md`:

```json
{
  "version": "1",
  "outputFile": "/data/MEMORY.md",
  "patterns": ["memory:*"],
  "generator": "./scripts/sync.sh",
  "description": "Syncs semantic memory to human-readable file"
}
```

### Fields

- `version` (required, string) - Schema version (currently "1"), allows future evolution
- `outputFile` (required, string) - Absolute path to generated markdown file (usually in `/data/`)
- `patterns` (required, array of strings) - SQLite key patterns to include (e.g., `["memory:*"]`, `["notes:entry:*"]`)
- `generator` (required, string) - Relative path to generator script from skill directory
- `description` (optional, string) - Human-readable description of what gets synced

### Example: structured-notes

```json
{
  "version": "1",
  "outputFile": "/data/NOTES.md",
  "patterns": ["notes:entry:*"],
  "generator": "./scripts/sync.sh",
  "description": "Syncs structured notes to consolidated view"
}
```

## Generator Script Contract

Each skill provides a generator script that:
- Reads from SQLite using `ambrogioctl state list/get`
- Formats data as markdown
- Writes to the outputFile specified in SYNC.json

### Script Interface

```bash
#!/usr/bin/env bash
# skills/<skill-name>/scripts/sync.sh

# Environment provided by ambrogioctl:
# - SYNC_OUTPUT_FILE: target file path from SYNC.json
# - SYNC_PATTERNS: comma-separated patterns from SYNC.json
# - SKILL_DIR: absolute path to skill directory

set -euo pipefail

output_file="${SYNC_OUTPUT_FILE}"
patterns="${SYNC_PATTERNS}"

# 1. Query state
entries=$(ambrogioctl state list --pattern "$patterns" --json)

# 2. Format as markdown (skill-specific logic)
# ... custom formatting ...

# 3. Write atomically
temp_file="${output_file}.tmp"
cat > "$temp_file" <<EOF
# Generated File
...
EOF
mv "$temp_file" "$output_file"

echo "Synced to $output_file"
```

### Requirements

- Must be executable (`chmod +x`)
- Should write atomically (tmp file + mv)
- Should be idempotent
- Should handle missing data gracefully
- Exit 0 on success, non-zero on failure

## CLI Commands

New `ambrogioctl sync` scope:

```bash
# Generate sync file for specific skill
ambrogioctl sync generate --skill <skill-name>

# Generate for all skills with SYNC.json
ambrogioctl sync generate --all

# List all skills with sync capability
ambrogioctl sync list

# Validate SYNC.json manifest
ambrogioctl sync validate --skill <skill-name>
```

### Implementation Details

- Discovers skills in `/data/.codex/skills/` (and optionally `./skills/`)
- Reads SYNC.json if present
- Validates schema
- Executes generator script with environment variables set
- Reports success/failure

### Error Handling

- Missing SYNC.json → skip skill (not an error for `--all`)
- Invalid SYNC.json → validation error
- Generator script fails → propagate error, don't write partial file
- Missing generator script → error
- Invalid patterns → error

## Data Flow

```
┌─────────────────┐
│  Skill writes   │
│  to SQLite via  │
│  ambrogioctl    │
│  state set      │
└────────┬────────┘
         │
         │ (explicit trigger)
         ▼
┌─────────────────┐
│  Skill calls    │
│  ambrogioctl    │
│  sync generate  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  CLI discovers  │
│  SYNC.json in   │
│  skill dir      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  CLI executes   │
│  generator.sh   │
│  with env vars  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Generator      │
│  queries SQLite │
│  formats to MD  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  /data/*.md     │
│  updated        │
│  atomically     │
└─────────────────┘
```

### Key Points

- Skills control when sync happens (explicit)
- Generator script owns formatting logic
- CLI provides discovery and orchestration only
- Atomic writes prevent partial updates

## Migration Path: memory-manager

### Current State

- `skills/memory-manager/scripts/sync.sh` exists and works
- Hardcoded to `/data/MEMORY.md`
- Called directly from skill

### Migration Steps

1. Create `skills/memory-manager/SYNC.json`:
   ```json
   {
     "version": "1",
     "outputFile": "/data/MEMORY.md",
     "patterns": ["memory:*"],
     "generator": "./scripts/sync.sh",
     "description": "Syncs semantic memory to human-readable file"
   }
   ```

2. Update `scripts/sync.sh` to use environment variables:
   ```bash
   # OLD: output_file="/data/MEMORY.md"
   # NEW: output_file="${SYNC_OUTPUT_FILE:-/data/MEMORY.md}"
   ```

3. Update SKILL.md to use new command:
   ```bash
   # OLD: ./scripts/sync.sh
   # NEW: ambrogioctl sync generate --skill memory-manager
   ```

### Backwards Compatibility

- Old direct script call still works (uses default path)
- New CLI call uses SYNC.json configuration
- No breaking changes

## Implementation Plan

### Phase 1: Core Infrastructure

1. **CLI sync scope** - Add `ambrogioctl sync` commands
2. **Manifest discovery** - Read and validate SYNC.json
3. **Generator execution** - Run scripts with environment variables
4. **Error handling** - Proper exit codes and error messages

### Phase 2: Migration

5. **memory-manager migration** - Add SYNC.json, update scripts
6. **Testing** - Verify backward compatibility
7. **Documentation** - Update SKILL.md

### Phase 3: New Skills

8. **structured-notes sync** - Create SYNC.json and generator
9. **Validation** - Test multi-skill sync with `--all`

## Testing Strategy

### Unit Tests

- SYNC.json schema validation
- Manifest discovery logic
- Environment variable passing

### Integration Tests

- Generator script execution
- Atomic file writes
- Error propagation
- Multi-skill sync

### Manual Tests

- memory-manager backward compatibility
- structured-notes new implementation
- Invalid manifest handling

## Future Enhancements (Not in Scope)

**Phase 2 - Optional features to add later if needed:**

1. **Bidirectional sync** - Parse markdown back to SQLite
2. **Sync helpers library** - Shared formatting functions (`render_table()`, `render_sections()`)
3. **Auto-sync on write** - Trigger sync automatically with debouncing
4. **Heartbeat integration** - Check for drift and auto-sync if stale
5. **Multiple output formats** - Support JSON, YAML alongside markdown
6. **Conflict detection** - Warn if manual edits detected in generated file
7. **Incremental sync** - Only regenerate if SQLite changed since last sync

## Security Considerations

- Generator scripts run with same permissions as ambrogioctl
- Output files written to `/data/` only (no arbitrary paths)
- Validate SYNC.json schema to prevent injection
- Generator scripts must be from trusted skill directories

## Rollout Plan

1. **Week 1**: Implement CLI infrastructure
2. **Week 1**: Migrate memory-manager with backward compatibility
3. **Week 2**: Add structured-notes sync capability
4. **Week 2**: Documentation and testing
5. **Week 2**: Deploy and monitor

## Success Metrics

- All existing memory-manager functionality works unchanged
- At least 2 skills using sync system (memory-manager, structured-notes)
- Zero sync-related errors in production logs
- Positive user feedback on auditability

## Open Questions

None - all design questions resolved during brainstorming.

## Appendix: Example Generator Script

See `skills/memory-manager/scripts/sync.sh` for reference implementation.
