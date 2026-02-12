---
name: atm-tram-schedule
description: Check ATM Milano tram schedules using GTFS data. Use when asked about tram schedules, departure times, or "quando passa il tram". Provides scheduled times for weekdays, Saturdays, and Sundays.
---

# ATM Tram Schedule

Use this skill when Signor Daniele asks about ATM Milano tram departure times, schedules, or "quando passa il tram".

**Note:** This skill provides scheduled times from GTFS data, not real-time arrivals. The GiroMilano API is blocked by access restrictions.

## When to Use

Trigger this skill when the user asks:

- "Quando passa il tram 9 a Duomo?"
- "Orari del tram 12 a Cadorna"
- "Che orari ha il tram nei giorni feriali?"
- "A che ora passa il tram 16?"
- Any request involving ATM tram schedules, departure times, or line information

## Workflow

1. Extract the tram line number from the user's request (required)
2. Extract stop name if mentioned (optional - shows all stops if omitted)
3. Determine schedule type based on context (weekday/saturday/sunday)
4. Run the script:

```bash
bash /data/.codex/skills/atm-tram-schedule/scripts/check-tram-schedule.sh "<line>" "<stop>" "<type>"
```

Arguments:
- `<line>`: Tram line number (e.g., "9", "12", "16") - **required**
- `<stop>`: Stop name (e.g., "Duomo", "Cadorna") - **optional**
- `<type>`: Schedule type - `weekday` (default), `saturday`, `sunday`

4. Script automatically:
   - Downloads GTFS data if not cached (60MB, cached for 24 hours)
   - Extracts schedule information from GTFS files
   - Filters by line, stop (if provided), and schedule type

5. Script output provides:
   - TEXT: Path to formatted schedule data under `/data/generated/atm-tram-schedule/YYYY/MM/DD/`
   - LINE, STOP, TYPE: Query parameters
   - SOURCE: GTFS (indicates static schedule data)
   - CACHE: hit/miss indicator

6. Read the TEXT file and provide the schedule information to the user in Italian
7. Clarify that these are scheduled times, not real-time arrivals

## Caching

The skill uses two-level caching via `ambrogioctl state`:

### GTFS Data Cache
- **TTL**: 24 hours (86400 seconds)
- **Size**: ~60MB download
- **Key**: `atm-tram-schedule:gtfs:timestamp`
- **Location**: `/data/generated/atm-tram-schedule/gtfs/`

### Query Cache
- **TTL**: 1 hour (3600 seconds)
- **Key**: `atm-tram-schedule:cache:<sha256_of_line:stop:type>`
- **Value**: JSON with timestamp, line, stop, schedule_type, text_path

Cache hits return immediately without re-querying GTFS files.

## Examples

### Weekday schedule with stop
User: "Quando passa il tram 9 a Duomo?"

```bash
bash /data/.codex/skills/atm-tram-schedule/scripts/check-tram-schedule.sh "9" "Duomo" "weekday"
```

### All stops on a line
User: "Che orari ha il tram 12?"

```bash
bash /data/.codex/skills/atm-tram-schedule/scripts/check-tram-schedule.sh "12"
```

### Saturday schedule
User: "Orari del tram 16 il sabato a Missori"

```bash
bash /data/.codex/skills/atm-tram-schedule/scripts/check-tram-schedule.sh "16" "Missori" "saturday"
```

### Sunday/Holiday schedule
User: "A che ora passa il tram 19 la domenica?"

```bash
bash /data/.codex/skills/atm-tram-schedule/scripts/check-tram-schedule.sh "19" "" "sunday"
```

## Guardrails

- **Data source**: Uses official GTFS feed from Comune di Milano (https://dati.comune.milano.it/gtfs.zip)
- **Scheduled times only**: Provides planned schedules, not real-time arrivals
- **Respect cache**: GTFS data cached for 24h, queries cached for 1h to minimize processing
- **Fail gracefully**: If line not found in GTFS, show available tram lines
- **Bandwidth awareness**: GTFS download is 60MB - only downloaded once per day
- **Error handling**: If stop not found, show all stops for the line
- **Transparency**: Always clarify these are scheduled times, not live data

## Limitations

1. **No real-time data**: The GiroMilano real-time API is blocked by Akamai access restrictions
2. **Stop name matching**: Fuzzy matching on stop names - may return multiple matches
3. **GTFS dependency**: Requires GTFS feed to be accessible (usually updated weekly by ATM)
4. **Schedule type mapping**: GTFS service IDs (1=Feriale, 6=Sabato, 7=Festivo) may change

## Future Enhancements

- Add support for bus lines (GTFS includes all ATM transit)
- Implement better stop name matching with edit distance
- Add route visualization (show all stops in sequence)
- Calculate next departure from current time
- Support for real-time data when API access becomes available
