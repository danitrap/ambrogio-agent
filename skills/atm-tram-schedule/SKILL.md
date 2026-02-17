---
name: atm-tram-schedule
description: Check ATM Milano tram timetables from GTFS data. Use for requests like "quando passa il tram" with line/stop/day context.
---

# ATM Tram Schedule

## Use This Skill When
- The user asks for ATM tram schedules/departure times in Milan.
- Typical intents: "Quando passa il tram 9 a Duomo?", "Orari tram 12".

## Do Not Use This Skill When
- The user asks for real-time arrivals (this skill provides scheduled times only).

## Required Inputs
- `line` (required, e.g. `9`, `12`, `16`).
- `stop` (optional, e.g. `Duomo`).
- `type` (optional: `weekday` default, `saturday`, `sunday`).

## Workflow
1. Parse line/stop/day intent from user message.
2. Run:
```bash
bash /data/.codex/skills/atm-tram-schedule/scripts/check-tram-schedule.sh "<line>" "<stop>" "<type>"
```
3. Read the generated text file path returned by the script.
4. Reply in Italian with key departures.
5. Explicitly state that times are scheduled GTFS times, not live tracking.

## Output Contract
- Include queried line/stop/day type.
- Include key departure windows or next listed times.
- Add disclaimer: "orari programmati, non tempo reale".

## Guardrails
- Never present output as live ETA.
- If line is invalid, report available alternatives from script output.
- Respect script caching behavior (GTFS and query cache).
