# Mac Mini Apple Ecosystem Integration Plan

**Date:** 2026-02-10
**Author:** Claude Sonnet 4.5
**Status:** Design Complete

## Context

This plan enables read-only access to Mac Mini's Apple Reminders and Calendar from the ambrogio-agent Telegram bot. The user wants to query their Mac Mini's Apple ecosystem data through natural language (e.g., "What's on my calendar today?" or "Show my grocery list") while maintaining a clean separation between the VPS-hosted agent and the Mac Mini.

**Why this is needed:**
- Natural language access to personal reminders and calendar via Telegram
- Read-only guarantee (no accidental modifications)
- Remote access from VPS to Mac Mini over LAN
- Consistent with existing RPC patterns in the codebase

**Architecture choice:**
- Mac Mini hosts standalone HTTP RPC server (similar protocol to existing Unix socket RPC)
- ambrogio-agent calls Mac Mini server via HTTP client
- CLI tools on Mac Mini (`reminders-cli`, `icalBuddy`) provide Apple ecosystem access
- New skill enables natural language queries

## Architecture Diagram

```
VPS (Docker) ──────HTTP over LAN─────> Mac Mini
│                                       │
├─ task-rpc-server.ts                  ├─ mac-mini-rpc-server
│  └─ mac.* operations                 │  ├─ HTTP server (port 3100)
│                                       │  ├─ Bearer token auth
├─ mac-rpc-client.ts (HTTP)            │  └─ CLI executors:
│  └─ Calls Mac Mini                   │     ├─ reminders-cli
│                                       │     └─ icalBuddy
├─ ambrogioctl mac ...                 │
│                                       └─ Apple APIs (read-only)
└─ skills/mac-control
   └─ Natural language queries
```

## Implementation Steps

### Phase 1: Mac Mini RPC Server (Standalone Component)

#### 1.1 Install CLI Tools on Mac Mini

```bash
brew install keith/formulae/reminders-cli
brew install ical-buddy
```

#### 1.2 Create Mac Mini Server Project

**New directory structure:**
```
mac-mini-server/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── server.ts          # HTTP server entry point
│   ├── handlers.ts        # RPC operation handlers
│   ├── cli-executors/
│   │   ├── reminders.ts   # Wrap reminders-cli commands
│   │   └── calendar.ts    # Wrap icalBuddy commands
│   └── types.ts           # Shared RPC types
└── launchd/
    └── com.ambrogio.mac-rpc-server.plist
```

**Key implementation:**

`server.ts` - HTTP server with RPC endpoint:
```typescript
// Similar to task-rpc-server.ts but over HTTP
const server = Bun.serve({
  port: 3100,
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/rpc") {
      return new Response("Not Found", { status: 404 });
    }

    // Validate Bearer token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== process.env.MAC_RPC_AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await req.json();
    const response = await handleRequest(body);
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  },
});
```

`handlers.ts` - Operation routing (mirrors task-rpc-server.ts pattern):
```typescript
// Reuse error codes: BAD_REQUEST, NOT_FOUND, INTERNAL
// Reuse validation helpers: readString(), readNumber()

async function handleRequest(request: RpcRequest): Promise<RpcResponse> {
  const op = readString(request.op);
  if (!op) {
    return rpcError("BAD_REQUEST", "Missing operation.");
  }

  const args = request.args ?? {};

  if (op === "mac.reminders.list-lists") {
    const lists = await executeRemindersCli("show-lists");
    return rpcOk({ lists: parseRemindersLists(lists) });
  }

  if (op === "mac.reminders.list") {
    const list = readString(args.list);
    if (!list) {
      return rpcError("BAD_REQUEST", "list parameter required");
    }
    const items = await executeRemindersCli(`show "${list}"`);
    return rpcOk({ items: parseRemindersItems(items) });
  }

  if (op === "mac.calendar.today") {
    const events = await executeIcalBuddy("eventsToday");
    return rpcOk({ events: parseCalendarEvents(events) });
  }

  if (op === "mac.calendar.events") {
    const startDate = readString(args.startDate);
    const endDate = readString(args.endDate);
    if (!startDate || !endDate) {
      return rpcError("BAD_REQUEST", "startDate and endDate required");
    }
    const events = await executeIcalBuddy(`eventsFrom:${startDate} to:${endDate}`);
    return rpcOk({ events: parseCalendarEvents(events) });
  }

  return rpcError("BAD_REQUEST", `Unknown operation: ${op}`);
}
```

`cli-executors/reminders.ts`:
```typescript
// Execute reminders-cli commands via Bun.spawn()
// Parse text output into JSON structures
// Read-only enforcement: only allow "show", "show-lists" commands
// Reject any write commands ("add", "complete", "delete")
```

#### 1.3 Create launchd Service (Auto-start on Boot)

`launchd/com.ambrogio.mac-rpc-server.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ambrogio.mac-rpc-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/daniele/.bun/bin/bun</string>
        <string>run</string>
        <string>/Users/daniele/services/mac-mini-server/src/server.ts</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/daniele/Library/Logs/mac-rpc-server.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/daniele/Library/Logs/mac-rpc-server-error.log</string>
</dict>
</plist>
```

### Phase 2: Ambrogio Agent Integration

#### 2.1 Create HTTP RPC Client

**New file:** `src/runtime/mac-rpc-client.ts`

```typescript
export type MacRpcClientOptions = {
  baseUrl: string;           // e.g., "http://192.168.1.100:3100/rpc"
  authToken: string;         // Bearer token
  timeoutMs?: number;        // Default: 10000
  maxRetries?: number;       // Default: 3
  fetchFn?: typeof fetch;    // For testing
};

export class MacRpcClient {
  constructor(private readonly options: MacRpcClientOptions) {}

  async call(op: string, args: Record<string, unknown>): Promise<RpcResponse> {
    const { baseUrl, authToken, timeoutMs = 10000, maxRetries = 3, fetchFn = fetch } = this.options;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetchFn(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify({ op, args }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json() as RpcResponse;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    // All retries exhausted
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Mac Mini unreachable: ${lastError?.message ?? "unknown error"}`,
      },
    };
  }
}
```

**Pattern reused from:** `src/model/elevenlabs-tts.ts` (fetch with error handling)

#### 2.2 Extend task-rpc-server.ts

**File:** `src/runtime/task-rpc-server.ts`

**Modify type (around line 30):**
```typescript
type TaskRpcServerOptions = {
  socketPath: string;
  stateStore: StateStore;
  retryTaskDelivery: (taskId: string) => Promise<string>;
  getStatus?: () => Promise<Record<string, unknown>>;
  telegram?: { /* ... */ };
  media?: { /* ... */ };
  mac?: {  // NEW
    call: (op: string, args: Record<string, unknown>) => Promise<RpcResponse>;
  };
};
```

**Add handler in handleRequest (after line 547, before final return):**
```typescript
  // Mac Mini operations (NEW)
  if (op.startsWith("mac.")) {
    if (!options.mac) {
      return rpcError("BAD_REQUEST", "Mac operations are not available.");
    }
    try {
      const response = await options.mac.call(op, args);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return rpcError("INTERNAL", `Mac RPC failed: ${message}`);
    }
  }

  return rpcError("BAD_REQUEST", `Unknown operation: ${op}`);
```

#### 2.3 Update Configuration

**File:** `src/config/env.ts`

Add to config type:
```typescript
export type Config = {
  // ... existing fields
  macRpcUrl: string | null;        // NEW
  macRpcAuthToken: string | null;  // NEW
};
```

Add to loadConfig():
```typescript
return {
  // ... existing fields
  macRpcUrl: Bun.env.MAC_RPC_URL ?? null,
  macRpcAuthToken: Bun.env.MAC_RPC_AUTH_TOKEN ?? null,
};
```

#### 2.4 Modify main.ts

**File:** `src/main.ts`

**Import mac client (around line 18):**
```typescript
import { MacRpcClient } from "./runtime/mac-rpc-client";
```

**Instantiate client (around line 252, after tts initialization):**
```typescript
const macRpcClient = config.macRpcUrl && config.macRpcAuthToken
  ? new MacRpcClient({
      baseUrl: config.macRpcUrl,
      authToken: config.macRpcAuthToken,
    })
  : null;

if (macRpcClient) {
  logger.info("mac_rpc_client_initialized", { url: config.macRpcUrl });
}
```

**Pass to RPC server (around line 605):**
```typescript
await startTaskRpcServer({
  socketPath: rpcSocketPath,
  stateStore,
  retryTaskDelivery,
  getStatus: getRuntimeStatus,
  telegram: { /* ... */ },
  media: { /* ... */ },
  mac: macRpcClient ? {  // NEW
    call: async (op, args) => await macRpcClient.call(op, args),
  } : undefined,
});
```

#### 2.5 Extend ambrogioctl.ts

**File:** `src/cli/ambrogioctl.ts`

**Add handler (after line 620, before final scope check):**
```typescript
  if (scope === "mac") {
    if (!action) {
      stderr("Usage: ambrogioctl mac <reminders|calendar> <action> [options]");
      return 2;
    }

    const json = hasFlag(args, "--json");
    let op = "";
    let payload: Record<string, unknown> = {};

    if (action === "reminders") {
      const subAction = args[0];
      if (subAction === "list-lists") {
        op = "mac.reminders.list-lists";
      } else if (subAction === "list") {
        op = "mac.reminders.list";
        const list = readFlag(args, "--list");
        if (list) payload.list = list;
      } else if (subAction === "search") {
        op = "mac.reminders.search";
        const query = readFlag(args, "--query");
        if (!query) {
          stderr("--query is required for search");
          return 2;
        }
        payload.query = query;
      } else {
        stderr(`Unknown reminders action: ${subAction}`);
        return 2;
      }
    } else if (action === "calendar") {
      const subAction = args[0];
      if (subAction === "today") {
        op = "mac.calendar.today";
      } else if (subAction === "events") {
        op = "mac.calendar.events";
        const startDate = readFlag(args, "--start");
        const endDate = readFlag(args, "--end");
        if (!startDate || !endDate) {
          stderr("--start and --end are required for events");
          return 2;
        }
        payload.startDate = startDate;
        payload.endDate = endDate;
      } else if (subAction === "list-calendars") {
        op = "mac.calendar.list-calendars";
      } else {
        stderr(`Unknown calendar action: ${subAction}`);
        return 2;
      }
    } else {
      stderr(`Unknown mac action: ${action}`);
      return 2;
    }

    try {
      const response = await sendRpc(op, payload);
      if (!response.ok) {
        stderr(response.error.message);
        return mapErrorCodeToExit(response.error.code);
      }
      if (json) {
        stdout(JSON.stringify(response.result));
      } else {
        stdout(formatResult(op, response.result));
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(message);
      return 10;
    }
  }
```

**Pattern reused from:** Lines 152-229 (telegram scope), 231-350 (state scope)

### Phase 3: Natural Language Skill

**New file:** `skills/mac-control/SKILL.md`

```markdown
---
name: mac-control
description: Query Mac Mini's Apple Reminders and Calendar in natural language using read-only RPC operations. Use this skill when Signor Daniele asks about his calendar, schedule, or reminder lists (e.g., "What's on my calendar today?", "Show my grocery list", "Do I have any meetings tomorrow?").
---

# Mac Control

Provides read-only access to Mac Mini's Apple ecosystem data.

## Hard Rules

- **Read-only operations only** - no creating, editing, or deleting
- **Always use --json flag** with ambrogioctl commands
- **Parse JSON before replying** to the user
- **Do not invent data** - only report what's returned by the API
- **If Mac Mini is unreachable**, report clearly: "Non riesco a raggiungere il Mac Mini"

## Supported Natural Language Queries

### Reminders
- "Show my grocery list" → `ambrogioctl mac reminders list --list "Groceries" --json`
- "What's on my todo list?" → `ambrogioctl mac reminders list --json`
- "Search for milk in reminders" → `ambrogioctl mac reminders search --query "milk" --json`
- "What reminder lists do I have?" → `ambrogioctl mac reminders list-lists --json`

### Calendar
- "What's on my calendar today?" → `ambrogioctl mac calendar today --json`
- "Show my schedule for this week" → `ambrogioctl mac calendar events --start "2026-02-10" --end "2026-02-17" --json`
- "Do I have meetings tomorrow?" → Compute tomorrow's date, then use `calendar events`
- "List my calendars" → `ambrogioctl mac calendar list-calendars --json`

## Workflow

1. **Identify intent**: Reminders or calendar query?
2. **Map to operation**: Select appropriate ambrogioctl command
3. **Compute dates**: For date ranges, convert natural language ("next Monday") to ISO dates (YYYY-MM-DD)
4. **Execute command**: Run ambrogioctl with --json flag
5. **Parse JSON**: Extract relevant data from response
6. **Format response**: Create user-friendly reply in Italian or English

## Example Execution

**User:** "What's on my calendar today?"

**Agent:**
1. Recognize calendar query for today
2. Execute: `ambrogioctl mac calendar today --json`
3. Parse JSON: `{"events": [{"title": "Meeting", "start": "2026-02-10T10:00:00", "end": "2026-02-10T11:00:00"}]}`
4. Reply: "Oggi hai 1 evento: Meeting alle 10:00"

## Error Handling

- `INTERNAL`: "Non riesco a raggiungere il Mac Mini. Verifica che sia acceso e connesso."
- `NOT_FOUND`: "Non ho trovato la lista '<list-name>'. Vuoi vedere tutte le liste disponibili?"
- `BAD_REQUEST`: "Specifica quale lista vuoi vedere."

## Response Style

- Concise and conversational (Italian or English)
- Show up to 10 items for lists (truncate if more)
- For calendar: Include time, title, location if available
- For reminders: Include title, due date if present
- Use relative time when helpful ("tra 2 ore", "domani alle 15:00")
```

**Pattern reused from:** `skills/telegram-media-sender/SKILL.md` (RPC-based skill)

### Phase 4: Testing

#### 4.1 Unit Tests

**New file:** `test/mac-rpc-client.test.ts`

```typescript
import { expect, test, mock } from "bun:test";
import { MacRpcClient } from "../src/runtime/mac-rpc-client";

test("successful RPC call", async () => {
  const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({
    ok: true,
    result: { items: [] },
  }))));

  const client = new MacRpcClient({
    baseUrl: "http://test",
    authToken: "token",
    fetchFn: mockFetch,
  });

  const response = await client.call("mac.reminders.list-lists", {});
  expect(response.ok).toBe(true);
});

test("network error with retry", async () => {
  let attempts = 0;
  const mockFetch = mock(() => {
    attempts++;
    return Promise.reject(new Error("Network error"));
  });

  const client = new MacRpcClient({
    baseUrl: "http://test",
    authToken: "token",
    maxRetries: 3,
    fetchFn: mockFetch,
  });

  const response = await client.call("mac.test", {});
  expect(response.ok).toBe(false);
  expect(response.error?.code).toBe("INTERNAL");
  expect(attempts).toBe(3);
});
```

**Pattern reused from:** `test/task-rpc-server.test.ts`

#### 4.2 Mac Mini Server Tests

Test Mac Mini server locally:
```bash
cd mac-mini-server

# Start server
bun run src/server.ts

# Test in another terminal
curl -X POST http://localhost:3100/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{"op":"mac.reminders.list-lists","args":{}}'

# Expected response:
# {"ok":true,"result":{"lists":[{"name":"Groceries","id":"...","count":5}]}}
```

#### 4.3 Integration Test

Test full integration from VPS:
```bash
# From VPS container
docker exec ambrogio-agent sh -lc 'ambrogioctl mac reminders list-lists --json'

# Test via Telegram
# Send message: "What reminder lists do I have?"
# Verify: Bot responds with list names
```

### Phase 5: Deployment

#### 5.1 Mac Mini Setup

```bash
# Install CLI tools
brew install keith/formulae/reminders-cli ical-buddy

# Install Bun
curl -fsSL https://bun.sh/install | bash

# Deploy server
cd ~/services
git clone <mac-mini-server-repo>
cd mac-mini-server
bun install

# Configure
cp .env.example .env
# Edit .env: Set MAC_RPC_AUTH_TOKEN (generate with: openssl rand -hex 32)
nano .env

# Test
bun run src/server.ts

# Install launchd service
cp launchd/com.ambrogio.mac-rpc-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ambrogio.mac-rpc-server.plist
launchctl list | grep ambrogio

# Find Mac Mini IP
ifconfig | grep "inet " | grep -v 127.0.0.1
# Note IP (e.g., 192.168.1.100)
```

#### 5.2 VPS Setup

```bash
# Update .env on VPS
echo "MAC_RPC_URL=http://192.168.1.100:3100/rpc" >> .env
echo "MAC_RPC_AUTH_TOKEN=<same-token-as-mac-mini>" >> .env

# Rebuild and restart
docker compose build
docker compose up -d

# Verify
docker compose logs -f ambrogio-agent | grep mac_rpc
```

## Security Considerations

1. **Authentication**: Bearer token (32-byte random hex) in `.env` on both sides
2. **Read-only enforcement**: Only allow CLI commands that read data (`show`, `eventsToday`)
3. **Network**: LAN-only (Mac Mini binds to local IP, not 0.0.0.0)
4. **Firewall**: Mac Mini firewall allows VPS IP only
5. **Rate limiting**: Max 10 requests/minute from VPS (implement in Mac Mini server)
6. **Error messages**: Never expose file paths or system details
7. **Audit logging**: Log all operations on Mac Mini with timestamps and request IPs

## RPC Operations Summary

### Reminders Operations
- `mac.reminders.list-lists` → `{ lists: [{name, id, count}] }`
- `mac.reminders.list` (args: `{list?}`) → `{ items: [{id, title, completed, list, dueDate?}] }`
- `mac.reminders.search` (args: `{query}`) → `{ items: [{id, title, completed, list}] }`

### Calendar Operations
- `mac.calendar.today` → `{ events: [{title, start, end, calendar, location?, notes?}] }`
- `mac.calendar.events` (args: `{startDate, endDate}`) → `{ events: [{title, start, end, calendar}] }`
- `mac.calendar.list-calendars` → `{ calendars: [{name, color?}] }`

## Verification Steps

1. **Mac Mini server responds**: `curl http://mac-mini-ip:3100/rpc` with auth returns data
2. **VPS can reach Mac Mini**: `docker exec ambrogio-agent sh -lc 'ambrogioctl mac reminders list-lists --json'` succeeds
3. **Skill integration works**: Send Telegram message "What's on my calendar today?" → Receives calendar data
4. **Error handling works**: Stop Mac Mini server → Telegram message returns "Non riesco a raggiungere il Mac Mini"
5. **Read-only enforced**: No write commands available in CLI or handlers

## Files Modified

- `src/runtime/task-rpc-server.ts` (add mac.* handler)
- `src/cli/ambrogioctl.ts` (add mac scope)
- `src/config/env.ts` (add macRpcUrl, macRpcAuthToken)
- `src/main.ts` (instantiate mac client, pass to RPC server)

## Files Created

- `src/runtime/mac-rpc-client.ts` (HTTP RPC client)
- `skills/mac-control/SKILL.md` (natural language skill)
- `test/mac-rpc-client.test.ts` (unit tests)
- `mac-mini-server/` directory (separate project - Mac Mini RPC server)

## Extension Possibilities (Future)

- Add Notes access via AppleScript
- Add Contacts query via `contacts` CLI
- Implement write operations with approval-gate skill
- Add recurring queries ("Check calendar every morning at 7am")
- Smart date parsing ("next Monday at 3pm" → ISO conversion)
