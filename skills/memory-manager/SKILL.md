---
name: memory-manager
description: Manage long-term semantic memory entries (preferences, facts, patterns) with local scripts and synchronized readable output.
---

# Memory Manager

## Use This Skill When
- The user asks to remember/forget/search persistent facts or preferences.

## Memory Types
- `preference`
- `fact`
- `pattern`

## Workflow
1. Create memory:
```bash
./scripts/add.sh --type <preference|fact|pattern> --content "<text>" [--source explicit] [--confidence 0-100] [--tags "a,b"] [--context "..."]
```
2. Search memory:
```bash
./scripts/search.sh --query "<text>"
```
3. List memory:
```bash
./scripts/list.sh [--type <type>]
```
4. Deprecate outdated memory:
```bash
./scripts/deprecate.sh --id <memory-id> --type <preference|fact|pattern> --reason "<reason>"
```
5. Regenerate readable sync file when needed:
```bash
ambrogioctl sync generate --skill memory-manager
```

## Output Contract
- For writes: confirm memory id/type/content summary.
- For reads: return relevant matches only.
- For deprecations: include reason and affected id.

## Guardrails
- Do not store secrets unless explicitly requested.
- Prefer `source=explicit` when user directly states memory intent.
- Deprecate instead of hard-deleting when history matters.
