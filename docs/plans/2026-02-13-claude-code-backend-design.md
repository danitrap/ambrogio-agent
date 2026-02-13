# Claude Code Backend Alternative Design

**Date:** 2026-02-13
**Status:** Approved
**Type:** Feature Enhancement

## Overview

Add Claude Code as an alternative backend to the ambrogio-agent system while maintaining support for the existing Codex backend. Users can select their preferred backend via environment variable at startup.

## Background

Currently, ambrogio-agent uses OpenAI's Codex CLI (`codex exec`) as its model backend. This design adds Claude Code CLI (`claude -p`) as an alternative backend, allowing the system to work with either AI provider based on configuration.

## Goals

1. Add Claude Code as a fully functional backend alternative
2. Preserve existing Codex backend functionality
3. Maintain backward compatibility with existing deployments
4. Use environment variable for backend selection
5. Ensure both backends work with the existing skill system
6. Support Docker containerized deployment for both backends

## Non-Goals

- Automatic backend routing based on request type
- Per-request backend selection via Telegram commands
- Running both backends simultaneously
- API-based integration (using CLI only for both backends)

## Architecture

### Component Structure

```
src/model/
├── types.ts (existing - ModelBridge interface)
├── bridge-factory.ts (new - creates appropriate bridge)
├── codex-bridge.ts (new - refactored from ExecBridge)
├── claude-bridge.ts (new - Claude Code implementation)
└── exec-bridge.ts (deprecated - temporary reference)
```

### Bridge Interface

Both backends implement the existing `ModelBridge` interface:

```typescript
interface ModelBridge {
  respond(request: ModelRequest): Promise<ModelResponse>;
  getLastExecutionSummary(): ModelExecutionSummary | null;
}
```

### Factory Pattern

```typescript
// bridge-factory.ts
export function createModelBridge(
  backend: 'codex' | 'claude',
  config: BridgeConfig,
  logger: Logger
): ModelBridge {
  switch (backend) {
    case 'codex':
      return new CodexBridge(config.codexCommand, config.codexArgs, logger, config.options);
    case 'claude':
      return new ClaudeBridge(config.claudeCommand, config.claudeArgs, logger, config.options);
  }
}
```

## Implementation Details

### Codex Bridge

Refactored from existing `ExecBridge` with minimal changes:

**Command Pattern:**
```bash
codex exec --skip-git-repo-check \
  --output-last-message /tmp/output.txt \
  --cd /data \
  --dangerously-bypass-approvals-and-sandbox \
  -
```

**Key Characteristics:**
- Reads prompt from stdin
- Writes final response to file specified by `--output-last-message`
- Audit actions parsed from stderr (shell commands, web searches)
- Exit code indicates success/failure

### Claude Code Bridge

New implementation using Claude Code CLI:

**Command Pattern:**
```bash
claude -p \
  --dangerously-skip-permissions \
  --add-dir /data \
  --output-format json \
  --no-session-persistence
```

**Key Characteristics:**
- Reads prompt from stdin (same as Codex)
- Returns structured JSON response via stdout
- No temporary file needed (unlike Codex)
- Includes usage metrics in response
- Tool usage available in structured format

**Response Format:**
```typescript
interface ClaudeJsonResponse {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  result: string;  // The actual assistant response
  duration_ms: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    server_tool_use: {
      web_search_requests: number;
      web_fetch_requests: number;
    };
  };
  session_id: string;
  total_cost_usd: number;
  stop_reason: string | null;
}
```

**Audit Actions:**
Extract from `usage.server_tool_use`:
- `web_search_requests` → count of web searches
- `web_fetch_requests` → count of web fetches
- Can be logged similarly to Codex stderr parsing

**Error Handling:**
1. Check `is_error` field in JSON response
2. Non-zero exit code indicates failure
3. JSON parse failure → fall back to raw stdout text
4. Empty response → log warning, return "unavailable" message

## Configuration

### Environment Variables

```bash
# Backend selection (default: codex)
BACKEND=codex|claude

# Codex-specific (existing)
CODEX_COMMAND=codex  # default
CODEX_ARGS="--dangerously-bypass-approvals-and-sandbox -c instructions=codex_fs"

# Claude Code-specific (new)
CLAUDE_COMMAND=claude  # default
CLAUDE_ARGS=""  # optional additional arguments
```

### Config Schema Changes

```typescript
// src/config/env.ts
export type AppConfig = {
  // ... existing fields
  backend: 'codex' | 'claude';
  claudeCommand: string;
  claudeArgs: string[];
};

export function loadConfig(): AppConfig {
  // ...
  return {
    // ... existing config
    backend: (Bun.env.BACKEND ?? 'codex') as 'codex' | 'claude',
    claudeCommand: Bun.env.CLAUDE_COMMAND ?? 'claude',
    claudeArgs: Bun.env.CLAUDE_ARGS
      ? Bun.env.CLAUDE_ARGS.split(' ').map(s => s.trim()).filter(Boolean)
      : [],
  };
}
```

### Startup Integration

```typescript
// src/main.ts
const config = loadConfig();
const modelBridge = createModelBridge(
  config.backend,
  {
    codexCommand: config.codexCommand,
    codexArgs: config.codexArgs,
    claudeCommand: config.claudeCommand,
    claudeArgs: config.claudeArgs,
    options: {
      cwd: config.dataRoot,
      env: {
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        HOME: homeDir,
        NO_COLOR: Bun.env.NO_COLOR ?? '1',
      },
    },
  },
  logger
);
```

## Docker & Container Integration

### Dockerfile Changes

```dockerfile
# Install Codex (existing)
RUN npm install -g @openai/codex

# Install Claude Code (new)
RUN curl -fsSL https://claude.ai/install.sh | sh

# Create Claude home directory
ENV CLAUDE_HOME=/data/.claude
RUN mkdir -p /data/.claude
```

### Authentication

**Codex (existing):**
```bash
docker exec -it ambrogio-agent sh -lc \
  'HOME=/data CODEX_HOME=/data/.codex codex login --device-auth'
```

**Claude Code (new):**
```bash
docker exec -it ambrogio-agent sh -lc \
  'HOME=/data CLAUDE_HOME=/data/.claude claude setup-token'
```

Claude Code uses token-based authentication via `setup-token` command, which requires a Claude subscription and stores a long-lived token in `CLAUDE_HOME`.

### Skills Synchronization

**Current behavior:** Skills sync from `./skills` → `/data/.codex/skills`

**Updated behavior:** Dual sync to support both backends:

```typescript
// Update src/skills/bootstrap.ts
const codexSkillsRoot = `${codexHome}/skills`;
const claudeSkillsRoot = `${claudeHome}/skills`;

// Sync to both locations
await bootstrapProjectSkills({
  sourceRoot: projectSkillsRoot,
  destinationRoot: codexSkillsRoot,
});

await bootstrapProjectSkills({
  sourceRoot: projectSkillsRoot,
  destinationRoot: claudeSkillsRoot,
});
```

**Rationale:** Sync to both directories regardless of active backend to enable seamless switching without restart.

### AGENTS.md System Prompt

Both backends need access to the system prompt file:

**Location:** `/data/AGENTS.md`

**Codex:** Reads via `CODEX_HOME` environment variable
**Claude Code:** Can read from same location via `--add-dir /data` flag

No changes needed - both backends can access the same file.

### Skills Discovery

Update discovery to use backend-specific path:

```typescript
// src/main.ts
const skillsRoot = config.backend === 'codex'
  ? `${codexHome}/skills`
  : `${claudeHome}/skills`;

const skills = new SkillDiscovery(skillsRoot);
```

## Data Flow

```
Telegram message
  ↓
main.ts (factory creates bridge based on BACKEND env)
  ↓
ModelBridge.respond(request)
  ↓
CodexBridge OR ClaudeBridge
  ↓
Spawn child process (codex exec OR claude -p)
  ↓
Write prompt to stdin
  ↓
Parse response:
  - Codex: Read from output file
  - Claude: Parse JSON from stdout
  ↓
Extract audit actions:
  - Codex: Parse stderr for shell/web patterns
  - Claude: Extract from usage.server_tool_use
  ↓
Return ModelResponse
  ↓
Existing message handling continues unchanged
```

## Error Handling

Both bridges handle the same error scenarios:

1. **Command not found**
   - Log error with command details
   - Return "Model backend unavailable right now."

2. **Non-zero exit code**
   - Log stderr and stdout
   - Extract error message if available
   - Return error message or generic unavailable message

3. **Process timeout (60s)**
   - AbortSignal terminates process
   - Background job created (existing behavior)
   - User notified immediately

4. **Empty response**
   - Log warning with stderr/stdout previews
   - Return "Model backend unavailable right now."

5. **Parse failure (Claude JSON only)**
   - Log JSON parse error
   - Fall back to raw stdout text
   - If still empty, return generic unavailable message

## Testing Strategy

### Unit Tests

1. **Factory tests** (`bridge-factory.test.ts`)
   - Verify correct bridge returned for each backend
   - Test config validation

2. **ClaudeBridge tests** (`claude-bridge.test.ts`)
   - Mock child process spawn
   - Test JSON parsing with various response formats
   - Test error handling (parse failures, empty responses, errors)
   - Test audit action extraction

3. **CodexBridge tests** (`codex-bridge.test.ts`)
   - Refactor existing `ExecBridge` tests
   - Ensure no regression in existing behavior

### Integration Tests

1. **Codex backend** (existing tests continue to work)
   - Set `BACKEND=codex` or use default
   - All existing integration tests pass

2. **Claude backend** (new manual test)
   - Set `BACKEND=claude`
   - Test end-to-end flow: Telegram → Claude → response
   - Verify skills are discovered and work correctly
   - Check audit logs contain execution summaries

### Manual Verification

1. Start container with `BACKEND=codex` - verify existing behavior
2. Authenticate both backends (device-auth for Codex, setup-token for Claude)
3. Switch to `BACKEND=claude` - verify responses
4. Test skill invocation with both backends
5. Verify background jobs work with timeouts
6. Check heartbeat execution with both backends

## Migration & Rollout

### Phase 1: Development
- Implement factory and Claude bridge
- Refactor ExecBridge → CodexBridge
- Update config and main.ts
- Add Docker changes
- Write tests

### Phase 2: Staging
- Deploy with `BACKEND=codex` (default, no behavior change)
- Authenticate Claude backend
- Test with `BACKEND=claude` manually
- Validate skills work correctly
- Check performance and cost metrics

### Phase 3: Production
- Deploy with `BACKEND=codex` initially (safe default)
- Monitor stability for 1-2 days
- Switch to `BACKEND=claude` if metrics are favorable
- Monitor for issues
- Keep ability to rollback to Codex

### Phase 4: Cleanup
- After 1-2 weeks of stable Claude operation
- Consider deprecating Codex if Claude proves superior
- Or keep both as permanent options for flexibility

## Risks & Mitigations

### Risk: Claude Code CLI behavior changes
**Mitigation:** Version lock the Claude installation, test before updates

### Risk: JSON parsing breaks with unexpected response format
**Mitigation:** Robust error handling, fall back to text mode, log parse failures

### Risk: Skills don't work with Claude Code
**Mitigation:** Test skill discovery and invocation during staging phase

### Risk: Performance/cost differences between backends
**Mitigation:** Log and monitor execution time and cost metrics, allow easy switching

### Risk: Docker image size increase
**Mitigation:** Both CLIs are relatively small (~50MB each), acceptable overhead

## Success Metrics

1. **Functional parity:** Claude backend handles all request types that Codex does
2. **No regressions:** Existing Codex backend tests continue to pass
3. **Skills compatibility:** All skills work with both backends
4. **Audit logging:** Execution summaries captured for both backends
5. **Error handling:** Graceful degradation on failures for both backends

## Open Questions

None - all clarified during design phase.

## References

- Claude Code CLI documentation: `claude --help`
- Existing ExecBridge implementation: `src/model/exec-bridge.ts`
- Skills bootstrap logic: `src/skills/bootstrap.ts`
- Config loader: `src/config/env.ts`
