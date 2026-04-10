"""
storage_engine.py — SQLite flight-log persistence for DronePulse.

Each ConsumerWorker owns one StorageEngine instance.  The engine manages
flight sessions automatically: a session opens on the first incoming packet
and closes after SESSION_TIMEOUT_S seconds of silence (default 30 s).
"""

import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

import auto_logger

logger = logging.getLogger(__name__)

SESSION_TIMEOUT_S: int = int(os.environ.get("SESSION_TIMEOUT_S", 30))

_SCHEMA = """
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
    tags         TEXT,
    notes        TEXT
);

CREATE TABLE IF NOT EXISTS telemetry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id    INTEGER NOT NULL REFERENCES flights(id),
    drone_id     TEXT NOT NULL,
    ts           REAL NOT NULL,
    packet_type  TEXT NOT NULL,
    data         TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_telemetry_flight_ts ON telemetry(flight_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_drone_ts  ON telemetry(drone_id, ts);
CREATE INDEX IF NOT EXISTS idx_scores_flight_ts    ON scores(flight_id, ts);
CREATE INDEX IF NOT EXISTS idx_flights_drone_start ON flights(drone_id, start_ts DESC);
"""


class StorageEngine:
    def __init__(self, drone_id: str, db_path: "Path | str | None" = None):
        self.drone_id = drone_id
        self.db_path = Path(
            db_path or os.environ.get("STORAGE_DB_PATH", "data/dronepulse.db")
        )
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

        self._upsert_drone()

        # Current flight session state
        self._flight_id: "int | None" = None
        self._session_start: "float | None" = None
        self._last_packet_ts: "float | None" = None
        self._max_alt_m: "float | None" = None
        self._max_speed: "float | None" = None
        self._min_battery: "float | None" = None

        logger.info("[storage] opened DB for %s at %s", drone_id, self.db_path)

    # ── Drone registry ───────────────────────────────────────────────────

    def _upsert_drone(self):
        now = time.time()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO drones(drone_id, first_seen, last_seen, total_flights)
                VALUES (?, ?, ?, 0)
                ON CONFLICT(drone_id) DO UPDATE SET last_seen = excluded.last_seen
                """,
                (self.drone_id, now, now),
            )
            self._conn.commit()

    # ── Session lifecycle ────────────────────────────────────────────────

    def _open_session(self):
        now = time.time()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO flights(drone_id, start_ts) VALUES (?, ?)",
                (self.drone_id, now),
            )
            self._flight_id = cur.lastrowid
            self._conn.execute(
                "UPDATE drones SET total_flights = total_flights + 1, last_seen = ? WHERE drone_id = ?",
                (now, self.drone_id),
            )
            self._conn.commit()

        self._session_start = now
        self._last_packet_ts = now
        self._max_alt_m = None
        self._max_speed = None
        self._min_battery = None
        logger.info(
            "[storage] opened flight %s for drone %s", self._flight_id, self.drone_id
        )

    def _close_session(self):
        if self._flight_id is None:
            return
        now = time.time()
        duration = (now - self._session_start) if self._session_start else None
        tags = json.dumps(self._compute_tags())
        flight_id = self._flight_id

        with self._lock:
            self._conn.execute(
                """
                UPDATE flights
                SET end_ts=?, duration_s=?, max_alt_m=?, max_speed=?, min_battery=?, tags=?
                WHERE id=?
                """,
                (
                    now,
                    duration,
                    self._max_alt_m,
                    self._max_speed,
                    self._min_battery,
                    tags,
                    flight_id,
                ),
            )
            self._conn.commit()

        logger.info(
            "[storage] closed flight %s for drone %s (duration=%.1fs, tags=%s)",
            flight_id,
            self.drone_id,
            duration or 0,
            tags,
        )
        self._flight_id = None
        self._session_start = None
        self._last_packet_ts = None

        auto_logger.save_flight(flight_id, self.drone_id, self.db_path)

    def check_session_timeout(self):
        """Call periodically from a background thread to close stale sessions."""
        if self._flight_id is not None and self._last_packet_ts is not None:
            if time.time() - self._last_packet_ts > SESSION_TIMEOUT_S:
                logger.info(
                    "[storage] session timeout for drone %s (no packets for %ds)",
                    self.drone_id,
                    SESSION_TIMEOUT_S,
                )
                self._close_session()

    # ── Public store methods ─────────────────────────────────────────────

    def store_packet(self, packet: dict):
        """Persist one telemetry packet and update in-flight session stats."""
        if self._flight_id is None:
            self._open_session()

        self._last_packet_ts = time.time()
        msg_type = packet.get("type", "UNKNOWN")
        data = packet.get("data", {})
        ts_ms = packet.get("ts", time.time()) * 1000  # store as ms since epoch

        # Update live session stats used when the session is eventually closed
        if msg_type == "GPS_RAW_INT":
            alt_mm = data.get("alt")
            if alt_mm is not None:
                alt_m = alt_mm / 1000.0
                if self._max_alt_m is None or alt_m > self._max_alt_m:
                    self._max_alt_m = alt_m

        elif msg_type == "VFR_HUD":
            groundspeed = data.get("groundspeed")
            if groundspeed is not None:
                if self._max_speed is None or groundspeed > self._max_speed:
                    self._max_speed = groundspeed

        elif msg_type == "SYS_STATUS":
            batt_pct = data.get("battery_remaining")
            if batt_pct is not None:
                if self._min_battery is None or batt_pct < self._min_battery:
                    self._min_battery = batt_pct

        with self._lock:
            self._conn.execute(
                "INSERT INTO telemetry(flight_id, drone_id, ts, packet_type, data) VALUES (?,?,?,?,?)",
                (self._flight_id, self.drone_id, ts_ms, msg_type, json.dumps(data)),
            )
            self._conn.commit()

    def store_scores(self, scores: dict):
        """Persist one score snapshot."""
        if self._flight_id is None:
            return
        ts = scores.get("timestamp", time.time())
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO scores(flight_id, drone_id, ts,
                    composite, pwr, imu, ekf, gps, ctl, mot, com)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    self._flight_id,
                    self.drone_id,
                    ts,
                    scores.get("composite"),
                    scores.get("pwr"),
                    scores.get("imu"),
                    scores.get("ekf"),
                    scores.get("gps"),
                    scores.get("ctl"),
                    scores.get("mot"),
                    scores.get("com"),
                ),
            )
            self._conn.commit()

    def store_alert(self, alert: dict):
        """Persist one alert."""
        if self._flight_id is None:
            return
        with self._lock:
            self._conn.execute(
                "INSERT INTO alerts(flight_id, drone_id, ts, code, level, value) VALUES (?,?,?,?,?,?)",
                (
                    self._flight_id,
                    self.drone_id,
                    time.time(),
                    alert.get("code", "UNKNOWN"),
                    alert.get("level", "warn"),
                    alert.get("value"),
                ),
            )
            self._conn.commit()

    # ── Auto-tagging ─────────────────────────────────────────────────────

    def _compute_tags(self) -> list:
        tags = []
        if self._session_start is not None:
            hour = datetime.fromtimestamp(self._session_start).hour
            if hour < 6 or hour >= 20:
                tags.append("night_flight")
            duration = time.time() - self._session_start
            if duration > 1800:
                tags.append("long_flight")
            elif duration > 600:
                tags.append("extended_flight")
        if self._max_speed is not None and self._max_speed > 15:
            tags.append("high_speed")
        if self._min_battery is not None and self._min_battery < 30:
            tags.append("low_battery")
        if self._min_battery is not None and 30 <= self._min_battery < 20:
            tags.append("battery_warning")
        if self._max_alt_m is not None and self._max_alt_m > 100:
            tags.append("high_altitude")
        return tags

    # ── Cleanup ──────────────────────────────────────────────────────────

    def close(self):
        self._close_session()
        try:
            self._conn.close()
        except Exception:
            pass
        logger.info("[storage] closed DB for drone %s", self.drone_id)
