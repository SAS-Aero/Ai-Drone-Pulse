-- DronePulse flight log schema
-- SQLite with WAL mode and foreign keys ON

CREATE TABLE IF NOT EXISTS drones (
    drone_id     TEXT PRIMARY KEY,
    first_seen   REAL NOT NULL,
    last_seen    REAL NOT NULL,
    total_flights INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flights (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    drone_id     TEXT NOT NULL REFERENCES drones(drone_id),
    start_ts     REAL NOT NULL,
    end_ts       REAL,
    duration_s   REAL,
    max_alt_m    REAL,
    max_speed    REAL,
    min_battery  REAL,
    tags         TEXT,   -- JSON array e.g. ["night_flight","high_speed"]
    notes        TEXT
);

CREATE TABLE IF NOT EXISTS telemetry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id    INTEGER NOT NULL REFERENCES flights(id),
    drone_id     TEXT NOT NULL,
    ts           REAL NOT NULL,   -- ms since epoch
    packet_type  TEXT NOT NULL,
    data         TEXT NOT NULL    -- JSON object
);

CREATE TABLE IF NOT EXISTS scores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id    INTEGER NOT NULL REFERENCES flights(id),
    drone_id     TEXT NOT NULL,
    ts           REAL NOT NULL,
    composite    REAL,
    pwr          REAL,
    imu          REAL,
    ekf          REAL,
    gps          REAL,
    ctl          REAL,
    mot          REAL,
    com          REAL
);

CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id    INTEGER NOT NULL REFERENCES flights(id),
    drone_id     TEXT NOT NULL,
    ts           REAL NOT NULL,
    code         TEXT NOT NULL,
    level        TEXT NOT NULL,
    value        REAL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_telemetry_flight_ts  ON telemetry(flight_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_drone_ts   ON telemetry(drone_id, ts);
CREATE INDEX IF NOT EXISTS idx_scores_flight_ts     ON scores(flight_id, ts);
CREATE INDEX IF NOT EXISTS idx_flights_drone_start  ON flights(drone_id, start_ts DESC);
