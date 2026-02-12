#!/usr/bin/env python3
"""
ATM Milano Tram Schedule Query Tool
Queries GTFS data for tram schedules
"""

import sys
import csv
import json
import hashlib
import subprocess
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Dict, List, Optional, Set

# Configuration
GTFS_URL = "https://dati.comune.milano.it/gtfs.zip"
GTFS_CACHE_TTL = 86400  # 24 hours
SCHEDULE_CACHE_TTL = 3600  # 1 hour
DATA_DIR = Path("/data/generated/atm-tram-schedule")
GTFS_DIR = DATA_DIR / "gtfs"
GTFS_ZIP = GTFS_DIR / "gtfs.zip"

# Service patterns for schedule types
SERVICE_PATTERNS = {
    "weekday": " LV ",
    "saturday": " SAB ",
    "sunday": " FEST "
}


def log(msg: str):
    """Print to stderr"""
    print(msg, file=sys.stderr)


def get_cache_state(key: str) -> Optional[str]:
    """Get value from ambrogioctl state"""
    try:
        result = subprocess.run(
            ["ambrogioctl", "state", "get", key],
            capture_output=True,
            text=True,
            check=False
        )
        if result.returncode == 0:
            # Format: key=value
            return result.stdout.strip().split("=", 1)[1] if "=" in result.stdout else None
    except Exception:
        pass
    return None


def set_cache_state(key: str, value: str):
    """Set value in ambrogioctl state"""
    try:
        subprocess.run(
            ["ambrogioctl", "state", "set", key, value],
            capture_output=True,
            check=False
        )
    except Exception:
        pass


def check_cache(cache_key: str, ttl: int) -> Optional[Dict]:
    """Check if cached result is valid"""
    cache_entry = get_cache_state(cache_key)
    if not cache_entry:
        return None

    try:
        cache_data = json.loads(cache_entry)
        timestamp = datetime.fromisoformat(cache_data["timestamp"].replace("Z", "+00:00"))
        age = (datetime.now(timestamp.tzinfo) - timestamp).total_seconds()

        if age < ttl:
            text_path = cache_data.get("text_path")
            if text_path and Path(text_path).exists():
                return cache_data
    except Exception:
        pass

    return None


def download_gtfs() -> bool:
    """Download and extract GTFS data"""
    # Check if GTFS files already exist
    routes_file = GTFS_DIR / "routes.txt"
    stops_file = GTFS_DIR / "stops.txt"
    trips_file = GTFS_DIR / "trips.txt"
    stop_times_file = GTFS_DIR / "stop_times.txt"

    all_files_exist = all([
        routes_file.exists(),
        stops_file.exists(),
        trips_file.exists(),
        stop_times_file.exists()
    ])

    # Check if GTFS needs update
    gtfs_cache_key = "atm-tram-schedule:gtfs:timestamp"
    gtfs_timestamp = get_cache_state(gtfs_cache_key)

    if all_files_exist and gtfs_timestamp:
        try:
            ts = datetime.fromisoformat(gtfs_timestamp.replace("Z", "+00:00"))
            age = (datetime.now(ts.tzinfo) - ts).total_seconds()
            if age < GTFS_CACHE_TTL:
                # Cache valid, files exist - no download needed
                return True
        except Exception:
            pass

    # Need to download/extract
    log("Downloading GTFS data from ATM Milano...")
    GTFS_DIR.mkdir(parents=True, exist_ok=True)

    # Download only if zip doesn't exist or is old
    if not GTFS_ZIP.exists():
        result = subprocess.run(
            ["curl", "-sL", GTFS_URL, "-o", str(GTFS_ZIP), "--max-time", "120"],
            check=False
        )
        if result.returncode != 0:
            log("Error: Failed to download GTFS data")
            return False

    log("Extracting GTFS data...")
    # Extract using Python's zipfile
    import zipfile
    try:
        with zipfile.ZipFile(GTFS_ZIP, 'r') as zip_ref:
            zip_ref.extractall(GTFS_DIR)
    except Exception as e:
        log(f"Error extracting GTFS: {e}")
        return False

    # Update cache timestamp
    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    set_cache_state(gtfs_cache_key, now_iso)

    return True


def load_routes() -> Dict[str, Dict]:
    """Load routes.txt into memory"""
    routes = {}
    routes_file = GTFS_DIR / "routes.txt"

    with open(routes_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            route_id = row['route_id']
            routes[route_id] = {
                'short_name': row['route_short_name'],
                'long_name': row['route_long_name'],
                'type': row['route_type']
            }

    return routes


def load_stops() -> Dict[str, Dict]:
    """Load stops.txt into memory"""
    stops = {}
    stops_file = GTFS_DIR / "stops.txt"

    with open(stops_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            stop_id = row['stop_id']
            stops[stop_id] = {
                'name': row['stop_name'],
                'lat': row.get('stop_lat', ''),
                'lon': row.get('stop_lon', '')
            }

    return stops


def find_route_id(line: str, routes: Dict) -> Optional[str]:
    """Find route_id for a tram line"""
    # Try with T prefix (trams)
    tram_id = f"T{line}"
    if tram_id in routes:
        return tram_id

    # Try direct match
    for route_id, route_data in routes.items():
        if route_data['short_name'] == line and route_data['type'] == '0':
            return route_id

    return None


def find_trips(route_id: str, service_pattern: str, limit: int = 50) -> Dict[str, str]:
    """
    Find trip IDs for a route and service type.
    Returns: {trip_id: headsign}
    """
    trips = {}
    trips_file = GTFS_DIR / "trips.txt"

    with open(trips_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['route_id'] == route_id and service_pattern in row['service_id']:
                trip_id = row['trip_id']
                headsign = row.get('trip_headsign', 'Unknown')
                trips[trip_id] = headsign
                if len(trips) >= limit:  # Limit trips for faster queries
                    break

    return trips


def find_stops_by_name(name: str, stops: Dict) -> List[str]:
    """Find stop IDs matching a name (case-insensitive)"""
    name_lower = name.lower()
    matching = []

    for stop_id, stop_data in stops.items():
        if name_lower in stop_data['name'].lower():
            matching.append(stop_id)

    return matching


def get_stop_times(trip_info: Dict[str, str], stop_ids: Optional[List[str]] = None) -> Dict[str, List[tuple]]:
    """
    Get departure times for trips and optionally filter by stops.
    Args:
        trip_info: {trip_id: headsign}
        stop_ids: optional list of stop IDs to filter
    Returns: {stop_id: [(time, headsign), ...]}
    """
    stop_times_file = GTFS_DIR / "stop_times.txt"
    times_by_stop = defaultdict(list)

    if len(trip_info) > 10:
        log(f"Scanning stop_times.txt for {len(trip_info)} trips...")

    with open(stop_times_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            trip_id = row['trip_id']
            if trip_id in trip_info:
                stop_id = row['stop_id']

                # If filtering by stops, check if this stop matches
                if stop_ids is None or stop_id in stop_ids:
                    departure_time = row['departure_time']
                    headsign = trip_info[trip_id]
                    times_by_stop[stop_id].append((departure_time, headsign))

    # Sort by time and remove duplicates
    result = {}
    for stop_id, times_list in times_by_stop.items():
        # Sort by time, keep unique (time, headsign) pairs
        sorted_times = sorted(set(times_list), key=lambda x: x[0])
        result[stop_id] = sorted_times

    return result


def format_output(line: str, stop_name: str, schedule_type: str, route_id: str,
                  trips: Dict[str, str], stop_times: Dict[str, List[tuple]],
                  stops: Dict[str, Dict], matching_stops: List[str]) -> str:
    """Format query results as human-readable text"""

    lines = [
        "=== ATM Tram Schedule (GTFS) ===",
        f"Line: {line}",
        f"Stop: {stop_name if stop_name else 'all stops'}",
        f"Schedule Type: {schedule_type}",
        f"Queried At: {datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}",
        f"Data Source: GTFS Static Feed",
        "",
        f"Route ID: {route_id}",
        "",
        f"=== Trips for {schedule_type} ===",
        f"Found {len(trips)} trips",
        ""
    ]

    # Show matching stops if stop name was provided
    if stop_name and matching_stops:
        lines.append("=== Stops matching '{}' ===".format(stop_name))
        lines.append(f"Found {len(matching_stops)} matching stops:")
        for stop_id in matching_stops:
            stop_info = stops.get(stop_id, {})
            lines.append(f"  {stop_id}: {stop_info.get('name', 'Unknown')}")
        lines.append("")

    # Show departure times
    lines.append("=== Departure Times ===")
    lines.append("")

    if not stop_times:
        lines.append("No departure times found.")
    else:
        # Group times by stop and direction
        for stop_id in sorted(stop_times.keys()):
            times_with_direction = stop_times[stop_id]
            stop_info = stops.get(stop_id, {})
            stop_display = stop_info.get('name', stop_id)

            lines.append(f"Stop: {stop_display} ({stop_id})")
            lines.append(f"Departures: {len(times_with_direction)} scheduled")
            lines.append("")

            # Group by direction
            by_direction = defaultdict(list)
            for time, headsign in times_with_direction:
                by_direction[headsign].append(time)

            # Show each direction separately
            for direction in sorted(by_direction.keys()):
                times = by_direction[direction]
                lines.append(f"  Direction: {direction}")
                lines.append(f"  ({len(times)} departures)")
                lines.append("")

                # Show times in rows
                for i in range(0, len(times), 6):
                    time_group = times[i:i+6]
                    lines.append("    " + "  ".join(time_group))

                lines.append("")

    lines.extend([
        "=== Note ===",
        "This data is from GTFS static feed (scheduled times, not real-time).",
        "Times shown are in HH:MM:SS format.",
        "For real-time data, the ATM API is currently unavailable due to access restrictions."
    ])

    return "\n".join(lines)


def main():
    """Main entry point"""
    # Parse arguments
    if len(sys.argv) < 2 or len(sys.argv) > 4:
        print("Usage: check-tram-schedule.py <line-number> [stop-name] [schedule-type]", file=sys.stderr)
        print("  line-number:    Tram line number (e.g., 9, 12, 16)", file=sys.stderr)
        print("  stop-name:      Stop name (optional, shows all stops if omitted)", file=sys.stderr)
        print("  schedule-type:  weekday (default), saturday, sunday", file=sys.stderr)
        sys.exit(1)

    line = sys.argv[1]
    stop_name = sys.argv[2] if len(sys.argv) > 2 else ""
    schedule_type = sys.argv[3] if len(sys.argv) > 3 else "weekday"

    # Validate schedule type
    if schedule_type not in SERVICE_PATTERNS:
        log(f"Error: schedule-type must be one of: {', '.join(SERVICE_PATTERNS.keys())}")
        sys.exit(1)

    # Generate cache key
    cache_input = f"{line}:{stop_name}:{schedule_type}"
    cache_hash = hashlib.sha256(cache_input.encode()).hexdigest()
    cache_key = f"atm-tram-schedule:cache:{cache_hash}"

    # Check query cache
    cached = check_cache(cache_key, SCHEDULE_CACHE_TTL)
    if cached:
        print(f"LINE: {line}")
        print(f"STOP: {stop_name if stop_name else 'all'}")
        print(f"TYPE: {schedule_type}")
        print(f"TEXT: {cached['text_path']}")
        print(f"SOURCE: GTFS")
        print("CACHE: hit")
        sys.exit(0)

    # Download/update GTFS if needed
    if not download_gtfs():
        sys.exit(1)

    log(f"Querying GTFS data for line {line}...")

    # Load GTFS data
    routes = load_routes()
    stops = load_stops()

    # Find route
    route_id = find_route_id(line, routes)
    if not route_id:
        log(f"Error: Line {line} not found in GTFS data")
        log("\nAvailable tram lines (route_type=0):")
        for rid, rdata in sorted(routes.items()):
            if rdata['type'] == '0':
                log(f"  {rdata['short_name']}: {rdata['long_name']}")
        sys.exit(1)

    # Find trips for this route and schedule type
    service_pattern = SERVICE_PATTERNS[schedule_type]
    trips = find_trips(route_id, service_pattern, limit=50)  # Limit for faster queries

    if not trips:
        log(f"No trips found for line {line} on {schedule_type}")
        sys.exit(1)

    # Find matching stops if stop name provided
    matching_stops = None
    if stop_name:
        matching_stops = find_stops_by_name(stop_name, stops)
        if not matching_stops:
            log(f"Warning: No stops found matching '{stop_name}'")
            log("Showing all stops for this line instead")

    # Get stop times (with directions)
    stop_times = get_stop_times(trips, matching_stops)

    # Prepare output directory
    date_path = datetime.now().strftime("%Y/%m/%d")
    out_dir = DATA_DIR / date_path
    out_dir.mkdir(parents=True, exist_ok=True)

    # Generate output filename
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    if stop_name:
        slug = f"line{line}-{stop_name.lower()[:30].replace(' ', '')}"
    else:
        slug = f"line{line}-all"

    text_path = out_dir / f"{ts}-{slug}.txt"

    # Format and write output
    output = format_output(line, stop_name, schedule_type, route_id, trips,
                          stop_times, stops, matching_stops or [])

    with open(text_path, 'w', encoding='utf-8') as f:
        f.write(output)

    # Update cache
    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    cache_value = json.dumps({
        "timestamp": now_iso,
        "line": line,
        "stop": stop_name,
        "schedule_type": schedule_type,
        "text_path": str(text_path)
    })
    set_cache_state(cache_key, cache_value)

    # Output results
    print(f"LINE: {line}")
    print(f"STOP: {stop_name if stop_name else 'all'}")
    print(f"TYPE: {schedule_type}")
    print(f"TEXT: {text_path}")
    print(f"SOURCE: GTFS")
    print("CACHE: miss")


if __name__ == "__main__":
    main()
