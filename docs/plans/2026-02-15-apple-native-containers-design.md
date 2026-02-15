# Apple Native Containers Architecture Design

**Date:** 2026-02-15  
**Status:** Approved  
**Author:** Assistant + User Collaboration

## Overview

This document describes the migration from Docker to Apple Native Containers for the Ambrogio Agent architecture. The new design runs the agent natively on macOS (for full Apple Framework access) while executing bridge operations (Codex/Claude) in ephemeral Apple containers for security isolation.

## Goals

- **Native macOS Access:** Agent runs on host with full access to AppleScript, EventKit (Reminders, Calendar), and other macOS frameworks
- **Security Isolation:** Each bridge execution runs in a fresh, ephemeral container with no persistence between runs
- **Credential Protection:** macOS authentication tokens (Calendar, Reminders) never leave the host environment
- **Context Preservation:** All bridge executions share the same `/data` workspace for seamless conversation context

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         macOS Host                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Ambrogio Agent (Native)                │   │
│  │  • Telegram Bot Handler                            │   │
│  │  • AppleScript / EventKit APIs                     │   │
│  │  • Unix Socket Server (/data/ambrogio-agent.sock)  │   │
│  │  • Container Orchestrator                          │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│              spawns ephemeral containers                   │
│                          │                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │        Apple Container (Ephemeral per execution)    │   │
│  │  ┌──────────────────────────────────────────────┐  │   │
│  │  │  Bridge Runtime (Codex/Claude)               │  │   │
│  │  │  • Node.js / Bun runtime                     │  │   │
│  │  │  • Codex CLI / Claude Code                   │  │   │
│  │  │  • ambrogioctl wrapper                       │  │   │
│  │  └──────────────────────────────────────────────┘  │   │
│  │                        │                           │   │
│  │           communicates via socket                  │   │
│  │                        │                           │   │
│  │  ┌──────────────────────────────────────────────┐  │   │
│  │  │  Unix Socket → Host Agent                    │  │   │
│  │  └──────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│              shared volume mount                           │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  /data (Shared Workspace)                           │   │
│  │  • attachments/     - Downloaded files              │   │
│  │  • skills/          - Project skills                │   │
│  │  • .codex/          - Codex configuration           │   │
│  │  • *.md             - State files, notes            │   │
│  │  • ambrogio-agent.sock - RPC socket                │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

**Ambrogio Agent (Host)**
- Runs natively on macOS with full framework access
- Handles Telegram bot polling and message processing
- Manages conversation state and context
- Spawns containers for bridge execution
- Executes privileged operations via `ambrogioctl` RPC
- Accesses Reminders, Calendar, AppleScript without container limitations

**Apple Container (Ephemeral)**
- Created fresh for each bridge execution
- Contains only: runtime (Node/Bun), bridge CLI (Codex/Claude), ambrogioctl wrapper
- Mounts `/data` read-write for workspace access
- Communicates with host via Unix socket
- Automatically removed after execution (`--rm`)

**Unix Socket Communication**
- Path: `/data/ambrogio-agent.sock`
- Protocol: JSON-RPC between container and host agent
- Enables bridge to request privileged operations without direct macOS access

## Data Flow

### 1. Message Reception

```
Telegram → Agent (Host) → Process Message → Requires Bridge?
                                                    │
                              ┌────────────────────┘
                              ▼
                    Create Container + Execute
                              │
                              ▼
                    Bridge reads /data context
                              │
                              ▼
                    Bridge may call ambrogioctl
                              │
                              ▼
                    Host executes, returns result
                              │
                              ▼
                    Bridge completes, container destroyed
                              │
                              ▼
                    Agent sends response to Telegram
```

### 2. Attachment Handling

When a user sends a photo or document:

1. **Agent (host)** downloads the file from Telegram
2. Saves to `data/attachments/YYYY/MM/DD/<updateId>-<sequence>-<kind>-<filename>`
3. Builds prompt context with file paths
4. Spawns container with `/data` mounted
5. **Bridge (container)** reads file at relative path from prompt context
6. Processes as needed, can write output to `/data/`

### 3. ambrogioctl RPC Flow

When bridge code calls `ambrogioctl telegram send-message`:

1. Wrapper script in container writes JSON-RPC request to Unix socket
2. Agent (host) receives request on socket server
3. Agent executes operation with full macOS privileges
4. Response returned via socket to container
5. Bridge continues execution

## Container Configuration

### Containerfile (ambrogio-bridge)

```dockerfile
FROM oven/bun:1.3.6

WORKDIR /app

# Install runtime dependencies
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash curl nodejs npm git \
  && rm -rf /var/lib/apt/lists/*

# Install bridge CLIs
RUN npm install -g @openai/codex @anthropic-ai/claude-code

# Install ambrogioctl wrapper
COPY ambrogioctl-wrapper.sh /usr/local/bin/ambrogioctl
RUN chmod +x /usr/local/bin/ambrogioctl

# Default workdir will be overridden at runtime
WORKDIR /data
```

### Container Execution

```bash
container run --rm \
  --name "ambrogio-bridge-${TASK_ID}" \
  --mount "${DATA_ROOT}:/data:rw" \
  --workdir /data \
  --env "DATA_ROOT=/data" \
  --env "CODEX_HOME=/data/.codex" \
  --env "TASK_ID=${TASK_ID}" \
  --env "TELEGRAM_CHAT_ID=${CHAT_ID}" \
  ambrogio-bridge:latest \
  bash -c "codex --model gpt-4o ${PROMPT_FILE}"
```

## Workspace Organization

The `/data` directory is shared between host and all container executions:

```
data/
├── attachments/           # Downloaded files from Telegram
│   └── 2026/
│       └── 02/
│           └── 15/
│               └── 12345-0-photo-image.jpg
├── skills/               # Project-specific skills
├── .codex/
│   └── skills/          # Codex-specific skills
├── .claude/
│   └── skills/          # Claude-specific skills
├── ambrogio-agent.sock  # Unix socket for RPC
├── state.md             # Conversation state
└── [other state files]  # Notes, context, etc.
```

**Key Points:**
- All containers see the same `/data` workspace
- Files written by one bridge are visible to the next
- Attachments are organized by date, not by task ID
- Socket file lives in shared space for easy mounting

## Error Handling

| Scenario | Response |
|----------|----------|
| Container fails to start | Log error, notify user via Telegram with generic message |
| Bridge timeout | Send SIGTERM, wait 5s, SIGKILL if needed, notify user |
| Socket unreachable | Bridge command fails with exit code, error in output |
| Bridge CLI error | Capture stdout/stderr, send to user for debugging |
| Container image missing | Fallback to native execution or maintenance mode |

## Security Considerations

1. **Container Isolation:** Each execution runs in fresh container with no inherited state
2. **No macOS Access:** Containers cannot access AppleScript, Calendar, or Reminders directly
3. **Controlled RPC:** Only exposed operations via ambrogioctl socket
4. **Volume Limits:** Container only sees `/data`, not full host filesystem
5. **No Secrets:** macOS credentials never mounted into containers

## Testing Strategy

### Unit Tests
- Mock `container` CLI calls
- Verify command generation with correct volume mounts
- Test socket RPC protocol

### Integration Tests
- Build container image
- Spawn test container with mock bridge
- Verify volume mounts and socket communication
- Test file persistence across container restarts

### E2E Tests
- Full flow: Telegram message → container spawn → execution → response
- Test attachment handling with real file downloads
- Verify ambrogioctl operations work through socket

## Migration Steps

1. **Install Apple Container tool:** `brew install container`
2. **Create Containerfile:** Convert Dockerfile to Apple Container format
3. **Build bridge image:** `container build -t ambrogio-bridge:latest .`
4. **Update agent code:** Replace Docker calls with `container` CLI
5. **Test locally:** Verify single execution works
6. **Deploy:** Remove Docker dependency, run agent natively

## Open Questions

- **Container startup time:** ~1-2s overhead acceptable for user experience?
- **Image updates:** How to rebuild/pull updated bridge images?
- **Multi-chat:** Each chat gets separate socket or shared?
- **Logs:** How to collect container logs for debugging?

## References

- [Apple Container GitHub](https://github.com/apple/container)
- [Containerization Swift Package](https://developer.apple.com/documentation/containerization)
- [WWDC 2025: Meet Containerization](https://developer.apple.com/videos/play/wwdc2025/346/)
