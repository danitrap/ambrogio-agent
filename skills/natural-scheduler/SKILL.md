---
name: natural-scheduler
description: Manage background jobs (immediate, one-shot, and recurring) in natural language by calling ambrogioctl over the local job RPC socket.
---

# Natural Scheduler

Handle background job operations directly from natural-language requests.

## Scope

- Background jobs only (`background`, `delayed`, and `recurring` jobs handled by Ambrogio runtime).
- For TODO list operations, delegate to the `todo-manager` skill.

## Background Job Types

The Ambrogio runtime manages three types of background jobs:

1. **Immediate jobs** (kind='background') - Chat request took too long, execution continues in background with delivery retry
2. **One-shot jobs** (kind='delayed') - Future execution at a specific time (e.g., "remind me to buy groceries tomorrow at 10am")
3. **Recurring jobs** (kind='recurring') - Repeating scheduled execution (e.g., "tell me if it will rain in Milan, every day at 6am")

## Hard Rules

- Do not output JSON to the user.
- Do not invent job IDs.
- Always execute job operations through `ambrogioctl`.
- If request is ambiguous between runtime job and TODO, ask explicit confirmation before executing.
- Always append `--json` to ambrogioctl commands and parse results before replying.
- **CRITICAL**: When creating delayed or recurring jobs, transform the user request into a delivery-ready prompt that does NOT look like a new request. See "Prompt Transformation Rules" below.

## Supported Intents

### One-Shot and Immediate Jobs

- List jobs:
  - `ambrogioctl jobs list --json`
- Inspect job:
  - `ambrogioctl jobs inspect --id <jobId> --json`
- Create one-shot delayed job:
  - `ambrogioctl jobs create --run-at <ISO> --prompt "<text>" --user-id <id> --chat-id <id> --json`
- Cancel job:
  - `ambrogioctl jobs cancel --id <jobId> --json`
- Retry delivery:
  - `ambrogioctl jobs retry --id <jobId> --json`

### Recurring Jobs

- Create recurring job:
  - `ambrogioctl jobs create-recurring --run-at <ISO> --prompt "<text>" --user-id <id> --chat-id <id> --type <interval|cron> --expression <expr> [--max-runs <N>] --json`
- List recurring jobs:
  - `ambrogioctl jobs list-recurring [--limit <N>] --json`
- Pause recurring job:
  - `ambrogioctl jobs pause --id <jobId> --json`
- Resume recurring job:
  - `ambrogioctl jobs resume --id <jobId> --json`
- Update recurrence schedule:
  - `ambrogioctl jobs update-recurrence --id <jobId> --expression <expr> --json`
- Cancel recurring job (permanently):
  - `ambrogioctl jobs cancel --id <jobId> --json` (works for all job types)

## Prompt Transformation Rules

When creating delayed or recurring jobs, the `--prompt` parameter will be executed later by Ambrogio and sent to the user. **You MUST transform the user's request into a delivery-ready message that does NOT look like a new request.**

### ❌ WRONG Examples (will cause infinite loops):
- User: "Ricordami di cucinare il riso"
- **BAD prompt**: `"Ricorda a Signor Daniele di cucinare il riso"` ← This looks like a NEW request!
- Result: When executed, Ambrogio will ask "a che ora?" instead of delivering the reminder

### ✅ CORRECT Examples:

1. **Simple reminder (Italian):**
   - User: "Ricordami di cucinare il riso alle 12:40"
   - **Good prompt**: `"Promemoria: è ora di cucinare il riso."`
   - Or: `"Signor Daniele, è ora di cucinare il riso."`

2. **Reminder with details:**
   - User: "Ricordami di comprare il latte domani"
   - **Good prompt**: `"Promemoria: comprare il latte."`

3. **Recurring job (English):**
   - User: "Tell me if it will rain in Milan, every day at 6am"
   - **Good prompt**: `"Check weather forecast for Milan and tell me if it will rain today"`

4. **Reminder with recipe/instructions:**
   - User: "Ricordami di cucinare la pasta con ricetta alle 19:40"
   - **Good prompt**: `"Promemoria: cucinare la pasta. Ricetta: [insert recipe here]"`

### Transformation Pattern:

```
"Ricordami di X" → "Promemoria: X." or "È ora di X."
"Remind me to X" → "Reminder: X." or "Time to X."
"Dimmi X" → "X" (already imperative, keep as-is)
"Tell me X" → "X" (already imperative, keep as-is)
```

**Key principle**: The prompt should be what you want to SAY to the user when the task runs, NOT a description of what to remember.

## Time Handling

- Convert natural-time requests to absolute ISO timestamp before creating jobs.
- If time is missing/ambiguous, ask for clarification.
- If user says "tra X minuti", compute from current local time and confirm the resolved schedule in response.

## Recurrence Expression Format

### Interval Format (Simple)

Primary format for most use cases: `"<N><unit>"` where unit is:
- `m` = minutes (e.g., `"30m"` = every 30 minutes)
- `h` = hours (e.g., `"1h"` = every hour, `"2h"` = every 2 hours)
- `d` = days (e.g., `"1d"` = daily, `"7d"` = weekly)

### Cron Format (Advanced)

Standard cron expressions prefixed with `"cron:"` (optional, for complex schedules):
- Format: `"minute hour * * *"`
- Example: `"0 9 * * *"` = daily at 9:00 AM
- Example: `"30 18 * * *"` = daily at 6:30 PM
- Example: `"0 */2 * * *"` = every 2 hours

### Natural Language Mapping

When user provides natural language, map to recurrence expressions:

**Italian:**
- "ogni ora" → `--type interval --expression "1h"`
- "ogni 30 minuti" → `--type interval --expression "30m"`
- "ogni giorno alle 6" → `--type cron --expression "0 6 * * *"`
- "tutti i giorni alle 18" → `--type cron --expression "0 18 * * *"`
- "ogni 2 ore" → `--type interval --expression "2h"`

**English:**
- "every hour" → `--type interval --expression "1h"`
- "every 30 minutes" → `--type interval --expression "30m"`
- "daily at 6am" → `--type cron --expression "0 6 * * *"`
- "every day at 6pm" → `--type cron --expression "0 18 * * *"`
- "every 2 hours" → `--type interval --expression "2h"`

## Muting Jobs

Users can temporarily mute jobs to prevent notifications until a specified time.

### Mute Commands

- Mute specific job:
  - `ambrogioctl jobs mute --id <jobId> --until <ISO> --json`
- Mute multiple jobs by pattern:
  - `ambrogioctl jobs mute-pattern --pattern <text> --until <ISO> --json`
- Unmute job:
  - `ambrogioctl jobs unmute --id <jobId> --json`
- List muted jobs:
  - `ambrogioctl jobs list-muted [--limit <N>] --json`

### Natural Language Muting Examples

**Italian:**

- "Sono sul tram, non mandarmi più promemoria per il tram" → Find jobs matching "tram", mute until tomorrow 7:00am
- "Muta il job meteo fino a lunedì" → Mute weather job until next Monday 7:00am
- "Non disturbarmi più oggi" → Mute all scheduled jobs until tomorrow morning
- "Riattiva i promemoria del tram" → Unmute all tram-related jobs
- "Quali job sono mutati?" → List muted jobs

**English:**

- "I'm on the tram, stop alerting me" → Find jobs matching "tram", mute until tomorrow 7:00am
- "Mute the weather job until next week" → Mute weather job until next Monday
- "Don't bother me today" → Mute all scheduled jobs until tomorrow
- "Unmute the tram reminders" → Clear mute on tram jobs
- "Show muted jobs" → List muted jobs

### Mute Until Time Calculation

When user says "stop for today" or "I'm on the tram":

- Calculate: tomorrow at 7:00am local time
- Format: ISO 8601 timestamp

When user says "until next week":

- Calculate: next Monday at 7:00am local time
- Format: ISO 8601 timestamp

### Pattern Matching Strategy

1. Extract keywords from user message (e.g., "tram", "weather", "meteo")
2. Use `jobs mute-pattern --pattern <keyword>` to match prompts/previews
3. Confirm number of jobs muted
4. Reply with confirmation including unmute time

### Example Interaction: Contextual Muting

**User:** "Sono sul tram"

**Agent Response:**

1. Identify context: user is on the tram
2. Find tram-related jobs: `ambrogioctl jobs list-recurring --json | grep -i tram`
3. Calculate mute until: tomorrow 7:00am
4. Mute jobs:
   ```bash
   ambrogioctl jobs mute-pattern --pattern "tram" --until "2026-02-14T07:00:00+01:00" --json
   ```
5. Reply: "Ok Signor Daniele, ho mutato 3 promemoria del tram fino a domani mattina alle 7:00."

## Example Interactions

### Example 1: Simple Reminder (One-Shot)

**User:** "Ricordami di cucinare il riso alle 12:40"

**Agent Response:**
1. Parse time: "12:40" → ISO timestamp for today at 12:40
2. Transform prompt: "Ricordami di cucinare il riso" → "Promemoria: è ora di cucinare il riso."
3. Create job:
   ```bash
   ambrogioctl jobs create \
     --run-at "2026-02-10T12:40:00+01:00" \
     --prompt "Promemoria: è ora di cucinare il riso." \
     --user-id 450717824 \
     --chat-id 450717824 \
     --json
   ```
4. Reply: "Signor Daniele, promemoria impostato per oggi alle 12:40. ID: `dl-rpc-xyz`."

### Example 2: Daily Weather Check (Recurring)

**User:** "Dimmi se pioverà a Milano, ogni giorno alle 6 di mattina"

**Agent Response:**
1. Parse: "ogni giorno alle 6" → cron `"0 6 * * *"`
2. Calculate first run: tomorrow at 6:00 AM (or today if before 6am)
3. Prompt is already imperative: "Dimmi se pioverà" → keep as task instruction
4. Create job:
   ```bash
   ambrogioctl jobs create-recurring \
     --run-at "2026-02-11T06:00:00.000Z" \
     --prompt "Check weather forecast for Milan and tell me if it will rain today" \
     --user-id 123 \
     --chat-id 123 \
     --type cron \
     --expression "0 6 * * *" \
     --json
   ```
5. Reply: "Ok! Ti dirò se pioverà a Milano ogni giorno alle 6:00. (Job ID: rc-xyz)"

### Example 3: Hourly Disk Space Check (Recurring)

**User:** "Check disk space every hour"

**Agent Response:**
1. Parse: "every hour" → interval `"1h"`
2. Calculate first run: current time + 1 hour
3. Prompt is already imperative, keep as-is
4. Create job:
   ```bash
   ambrogioctl jobs create-recurring \
     --run-at "2026-02-10T16:00:00.000Z" \
     --prompt "Check disk space and alert if usage is above 80%" \
     --user-id 123 \
     --chat-id 123 \
     --type interval \
     --expression "1h" \
     --json
   ```
5. Reply: "Ok! I'll check disk space every hour. (Job ID: rc-xyz)"

### Example 4: Pause/Resume

**User:** "Pause the weather job"

**Agent Response:**
1. List recurring jobs to find matching job
2. Pause:
   ```bash
   ambrogioctl jobs pause --id rc-xyz --json
   ```
3. Reply: "Job rc-xyz paused."

**User:** "Resume it"

**Agent Response:**
1. Resume:
   ```bash
   ambrogioctl jobs resume --id rc-xyz --json
   ```
2. Reply: "Job rc-xyz resumed."

## Disambiguation Policy

- If user says generic "lista", "job", "promemoria", "todo" and domain is unclear:
  - Ask: "Vuole i background jobs runtime o la TODO list?"
- Execute only after explicit user confirmation.
- If user says "ricordami" (remind me), determine if one-shot or recurring:
  - "ricordami domani" → one-shot delayed job (use `jobs create`)
  - "ricordami ogni giorno" → recurring job (use `jobs create-recurring`)

## Response Style

- Keep response concise and user-facing.
- Include job ID when action creates/cancels/retries a specific job.
- For list operations, summarize top entries and key statuses.
