# DronePulse — Flight Log Storage

Persistent SQLite storage for drone telemetry, scores, and alerts.
Each drone gets its own flight sessions recorded automatically.

---

## Schema overview

| Table | Purpose |
|-------|---------|
| `drones` | Registry of seen drones — first/last seen, total flight count |
| `flights` | One row per flight session — start/end timestamps, peak stats, auto-tags |
| `telemetry` | Every raw MAVLink packet keyed to a flight |
| `scores` | Periodic composite + 7 sub-scores (pwr/imu/ekf/gps/ctl/mot/com) |
| `alerts` | Alert events with code, level, and optional numeric value |

All tables use `INTEGER PRIMARY KEY AUTOINCREMENT` ids.  Foreign keys are enforced (`PRAGMA foreign_keys=ON`).  The database runs in WAL mode for concurrent reads during writes.

---

## Session lifecycle

```
first packet arrives
       │
       ▼
  _open_session()  ──► INSERT INTO flights(drone_id, start_ts)
       │
  packets / scores / alerts stored during flight
       │
       ▼  (30 s silence OR explicit close())
  _close_session() ──► UPDATE flights SET end_ts, duration_s,
                                          max_alt_m, max_speed,
                                          min_battery, tags
```

- **Auto-open**: `store_packet()` opens a session on the first packet if none is active.
- **Auto-close (timeout)**: A daemon thread calls `check_session_timeout()` every 10 s.  If `last_packet_ts` is more than `SESSION_TIMEOUT_S` seconds ago the session is closed.
- **Explicit close**: `ConsumerWorker.run()` calls `storage.close()` in its `finally` block when the worker exits.

---

## Auto-tagging logic

Tags are computed at session-close time from the stats accumulated during the flight:

| Tag | Condition |
|-----|-----------|
| `night_flight` | Session started before 06:00 or from 20:00 onwards (local time) |
| `high_speed` | `max_speed > 15 m/s` (from VFR_HUD groundspeed) |
| `low_battery` | `min_battery < 30 %` (from SYS_STATUS battery_remaining) |
| `high_altitude` | `max_alt_m > 100 m` (from GPS_RAW_INT alt field, mm→m) |

Tags are stored as a JSON array in `flights.tags`, e.g. `["night_flight","low_battery"]`.

---

## API endpoints

Start the API server: `uvicorn api:app --host 0.0.0.0 --port 8081`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/flights` | List completed flights. Query: `drone_id`, `limit` (50), `offset` (0) |
| GET | `/flights/{id}/scores` | All score rows for a flight, ordered by `ts` |
| GET | `/flights/{id}/telemetry` | Raw packets. Query: `packet_type`, `downsample` (1–100) |
| GET | `/flights/{id}/path` | GPS_RAW_INT packets as `[{ts, lat, lon, alt, ...}]` for map replay |
| GET | `/drones/{drone_id}/battery-health` | Per-flight `start_ts + min_battery + tags` for trend charts |

`downsample=N` keeps every Nth row (`rowid % N = 0`); useful to reduce payload size for long flights.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_DB_PATH` | `data/dronepulse.db` | Path to the SQLite database file |
| `SESSION_TIMEOUT_S` | `30` | Seconds of silence before a flight session is auto-closed |

---

## How to run

```bash
# Workers + API together (Railway / local honcho)
cd workers/
honcho start          # reads Procfile

# Or individually
python main.py        # telemetry consumer
uvicorn api:app --reload --port 8081   # history API
```

The `data/` directory is created automatically if it does not exist.
