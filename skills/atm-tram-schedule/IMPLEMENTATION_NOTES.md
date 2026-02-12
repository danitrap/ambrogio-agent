# ATM Tram Schedule - Implementation Notes

## Problem Analysis

### Original Requirement
Create a skill to check ATM Milano tram departure times, supporting both real-time and scheduled data.

### Challenges Encountered

1. **GiroMilano Website Blocking**
   - URL: https://giromilano.atm.it/
   - Error: HTTP 403 Access Denied
   - Protection: Akamai WAF/CDN
   - Blocks: Browser automation, curl, API calls

2. **API Endpoint Blocking**
   - Discovered official API: `POST https://giromilano.atm.it/proxy.ashx`
   - Endpoint structure: `url=tpPortal/geodata/pois/stops/{stop_code}`
   - Source: Reverse engineering from https://github.com/kristian-keller/Pensilina-ATM
   - Result: Also blocked (403 Access Denied)

3. **Bot Detection Methods**
   - IP-based filtering (likely requires Italian IP)
   - User-Agent validation
   - Session/cookie requirements
   - Possibly CAPTCHA challenges

### Solution: GTFS Static Feed

**Data Source:** https://dati.comune.milano.it/gtfs.zip

**Advantages:**
- Official data from Comune di Milano
- Licensed under CC-BY-4.0
- No authentication required
- Comprehensive schedule data
- Reliable and stable

**Disadvantages:**
- No real-time arrival information
- 60MB download size
- Requires local parsing
- Stop name matching complexity

## Technical Implementation

### GTFS Data Structure

The feed contains standard GTFS files:

```
gtfs/
├── routes.txt          # Line definitions (line number, name, type)
├── trips.txt           # Trip definitions (route_id, service_id, trip_id)
├── stops.txt           # Stop definitions (stop_id, name, coordinates)
├── stop_times.txt      # Departure times (trip_id, stop_id, arrival_time)
├── calendar.txt        # Service definitions (weekday/saturday/sunday)
└── [other GTFS files]
```

### Service ID Mapping

ATM uses these service_id values:
- `1` = Feriale (Weekday)
- `6` = Sabato (Saturday)
- `7` = Festivo (Sunday/Holidays)

### Query Flow

1. **Check Cache**
   - Query cache: 1 hour TTL
   - GTFS cache: 24 hour TTL

2. **Download GTFS** (if expired)
   - Download gtfs.zip (60MB)
   - Extract to `/data/generated/atm-tram-schedule/gtfs/`
   - Update timestamp in ambrogioctl state

3. **Query GTFS Files**
   - Find route_id from routes.txt using line number
   - Get trip_ids from trips.txt for route + service
   - Filter stops.txt by stop name (if provided)
   - Extract times from stop_times.txt

4. **Format Output**
   - Human-readable text format
   - Show stop information
   - List departure times
   - Include data source disclaimer

5. **Cache Result**
   - Store formatted output path
   - Cache for 1 hour

### Caching Strategy

**Two-Level Cache:**

1. **GTFS Data Cache**
   ```
   Key: atm-tram-schedule:gtfs:timestamp
   Value: ISO 8601 timestamp
   TTL: 24 hours
   Location: /data/generated/atm-tram-schedule/gtfs/
   ```

2. **Query Result Cache**
   ```
   Key: atm-tram-schedule:cache:<sha256(line:stop:type)>
   Value: {"timestamp": "...", "text_path": "...", ...}
   TTL: 1 hour
   ```

## Alternatives Considered

### 1. Use Third-Party APIs
**Services:** Moovit, Transit, Google Maps Transit

**Pros:**
- Real-time data available
- No scraping needed
- Professional APIs

**Cons:**
- Require API keys
- Rate limits
- Cost
- External dependencies

**Decision:** Not pursued (GTFS is free and official)

### 2. VPN/Proxy Through Italy
**Approach:** Route requests through Italian IP

**Pros:**
- Might bypass geo-blocking
- Access to real-time API

**Cons:**
- Adds complexity
- Requires VPN/proxy service
- May violate ToS
- Not guaranteed to work

**Decision:** Not pursued (GTFS is more reliable)

### 3. Reverse Engineer Mobile App
**Approach:** Deeper analysis of ATM Official App

**Pros:**
- Could find unblocked endpoints
- Real-time data access

**Cons:**
- Time-intensive
- May violate ToS
- Endpoints may change
- Authentication complexity

**Decision:** Not pursued (GTFS sufficient for MVP)

### 4. Web Scraping with Residential Proxies
**Approach:** Rotate IPs using proxy services

**Pros:**
- Can bypass IP blocking
- Real-time data

**Cons:**
- Expensive
- Against ToS
- Fragile
- Ethical concerns

**Decision:** Not pursued (not worth it)

## Future Enhancements

### Near-Term (Can Implement Now)

1. **Better Stop Matching**
   - Implement Levenshtein distance
   - Fuzzy matching for typos
   - Show "did you mean?" suggestions

2. **Next Departure Calculation**
   - Filter times after current time
   - Show "next 3 departures"
   - Handle day transitions

3. **Route Visualization**
   - List all stops in sequence
   - Show stop order/sequence numbers

4. **Bus Support**
   - GTFS includes all ATM lines
   - Same code works for buses
   - Just update documentation

5. **Multi-Line Queries**
   - Query multiple lines at once
   - Compare schedules

### Long-Term (Requires External Changes)

1. **Real-Time Data Integration**
   - Wait for ATM to provide public API
   - Or E015 API access becomes available
   - Integrate when possible

2. **GTFS-Realtime Support**
   - ATM doesn't provide GTFS-RT yet
   - Monitor for future availability

3. **Push Notifications**
   - Alert when line has delays
   - Requires real-time data source

## Testing

### Unit Tests Needed

```bash
# Test basic query
bash check-tram-schedule.sh "19"

# Test with stop
bash check-tram-schedule.sh "19" "Duomo"

# Test schedule types
bash check-tram-schedule.sh "19" "Duomo" "weekday"
bash check-tram-schedule.sh "19" "Duomo" "saturday"
bash check-tram-schedule.sh "19" "Duomo" "sunday"

# Test invalid inputs
bash check-tram-schedule.sh "999"           # Non-existent line
bash check-tram-schedule.sh "19" "XYZ"      # Non-existent stop
bash check-tram-schedule.sh "19" "" "foo"   # Invalid schedule type

# Test caching
bash check-tram-schedule.sh "19" "Duomo"    # First run (CACHE: miss)
bash check-tram-schedule.sh "19" "Duomo"    # Second run (CACHE: hit)
```

### Integration Tests

Ask Ambrogio:
- "Quando passa il tram 19?" (Italian)
- "Orari del tram 12 a Cadorna"
- "Che orari ha il tram 9 il sabato?"

## Lessons Learned

1. **Don't Assume Website Access**
   - Modern websites have aggressive bot protection
   - Always check for official APIs/data feeds first

2. **GTFS is Underrated**
   - Most transit agencies provide GTFS
   - It's comprehensive and reliable
   - Static schedules are better than no data

3. **Cache Aggressively**
   - GTFS parsing is CPU-intensive
   - Cache both data and query results
   - Balance freshness vs performance

4. **Graceful Degradation**
   - Real-time data is nice but not essential
   - Scheduled times are still very useful
   - Users understand limitations if explained

## References

- [GTFS Specification](https://gtfs.org/schedule/)
- [ATM GTFS Feed on Transitland](https://www.transit.land/feeds/f-u0nd-comunedimilano)
- [Comune di Milano Open Data](https://dati.comune.milano.it/)
- [Pensilina-ATM GitHub](https://github.com/kristian-keller/Pensilina-ATM)
- [E015 API (Regione Lombardia)](https://www.e015.regione.lombardia.it/)
