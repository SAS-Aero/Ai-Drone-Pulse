"""
auto_logger.py — Automatic flight log archiver for DronePulse.

Triggered by StorageEngine._close_session() on every flight end.
Writes log files to AUTO_LOG_DIR (default: data/logs/).
Formats configured via AUTO_LOG_FORMATS (default: json,csv).
All I/O runs in a background daemon thread — never blocks session close.
"""

import json
import logging
import math
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_LOG_DIR = Path(os.environ.get("AUTO_LOG_DIR", "data/logs"))
_FORMATS = [
    f.strip().lower()
    for f in os.environ.get("AUTO_LOG_FORMATS", "json,csv").split(",")
    if f.strip()
]


def save_flight(flight_id: int, drone_id: str, db_path: "Path | str") -> None:
    """Spawn a background thread to auto-save flight logs. Non-blocking.

    Non-daemon so the OS doesn't kill the thread mid-write during worker shutdown.
    """
    t = threading.Thread(
        target=_worker,
        args=(flight_id, drone_id, Path(db_path)),
        name=f"auto-logger-flight-{flight_id}",
        daemon=False,
    )
    t.start()


def _worker(flight_id: int, drone_id: str, db_path: Path) -> None:
    conn = None
    try:
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")

        flight = conn.execute(
            "SELECT * FROM flights WHERE id=?", (flight_id,)
        ).fetchone()
        if not flight:
            logger.warning("[auto_logger] flight %d not found, skipping", flight_id)
            return

        _LOG_DIR.mkdir(parents=True, exist_ok=True)

        start_dt = datetime.fromtimestamp(flight["start_ts"], tz=timezone.utc)
        date_str = start_dt.strftime("%Y-%m-%d_%H%M%S")
        stem = f"{drone_id}_flight{flight_id}_{date_str}"

        saved = []

        if "json" in _FORMATS:
            p = _LOG_DIR / f"{stem}.json"
            _save_json(conn, flight, flight_id, p)
            saved.append(str(p))

        if "csv" in _FORMATS:
            p = _LOG_DIR / f"{stem}_telemetry.csv"
            _save_csv(conn, flight_id, p)
            saved.append(str(p))

        if "gpx" in _FORMATS:
            p = _LOG_DIR / f"{stem}.gpx"
            _save_gpx(conn, flight, flight_id, p)
            saved.append(str(p))

        if "kml" in _FORMATS:
            p = _LOG_DIR / f"{stem}.kml"
            _save_kml(conn, flight, flight_id, p)
            saved.append(str(p))

        logger.info("[auto_logger] flight %d saved: %s", flight_id, ", ".join(saved))
    except Exception:
        logger.exception("[auto_logger] failed to save flight %d", flight_id)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


# ── Format writers ────────────────────────────────────────────────────────────

def _save_json(conn, flight, flight_id: int, path: Path) -> None:
    scores = conn.execute(
        "SELECT * FROM scores WHERE flight_id=? ORDER BY ts", (flight_id,)
    ).fetchall()

    gps_rows = conn.execute(
        """
        SELECT ts, data FROM telemetry
        WHERE flight_id=? AND packet_type='GPS_RAW_INT'
        ORDER BY ts
        """,
        (flight_id,),
    ).fetchall()

    alerts = conn.execute(
        "SELECT * FROM alerts WHERE flight_id=? ORDER BY ts", (flight_id,)
    ).fetchall()

    data = {
        "flight": dict(flight),
        "scores": [dict(s) for s in scores],
        "path": [{"ts": r["ts"], **json.loads(r["data"])} for r in gps_rows],
        "alerts": [dict(a) for a in alerts],
        "exportedAt": datetime.now(tz=timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _save_csv(conn, flight_id: int, path: Path) -> None:
    rows = conn.execute(
        "SELECT ts, packet_type, data FROM telemetry WHERE flight_id=? ORDER BY ts",
        (flight_id,),
    ).fetchall()

    FIELDS = [
        "lat", "lon", "alt_m",
        "roll_deg", "pitch_deg", "yaw_deg",
        "battery_pct", "voltage_v", "current_a",
        "groundspeed_ms", "heading_deg",
        "hdop", "satellites",
    ]

    def _extract(ptype, d):
        out = {f: "" for f in FIELDS}
        if ptype == "GLOBAL_POSITION_INT":
            out["lat"] = d.get("lat", "")
            out["lon"] = d.get("lon", "")
            out["alt_m"] = round(d.get("alt", 0) / 1000, 2) if d.get("alt") else ""
        elif ptype == "GPS_RAW_INT":
            out["lat"] = d.get("lat", "")
            out["lon"] = d.get("lon", "")
            out["hdop"] = d.get("eph", "")
            out["satellites"] = d.get("satellites_visible", "")
        elif ptype == "ATTITUDE":
            out["roll_deg"] = round(math.degrees(d.get("roll", 0)), 2)
            out["pitch_deg"] = round(math.degrees(d.get("pitch", 0)), 2)
            out["yaw_deg"] = round(math.degrees(d.get("yaw", 0)), 2)
        elif ptype in ("BATTERY_STATUS", "SYS_STATUS"):
            out["battery_pct"] = d.get("battery_remaining", "")
            vb = d.get("voltage_battery")
            cb = d.get("current_battery")
            out["voltage_v"] = round(vb / 1000, 3) if vb is not None else ""
            out["current_a"] = round(cb / 100, 2) if cb is not None else ""
        elif ptype == "VFR_HUD":
            out["groundspeed_ms"] = d.get("groundspeed", "")
            out["heading_deg"] = d.get("heading", "")
        return out

    lines = ["ts_ms,datetime_utc,packet_type," + ",".join(FIELDS) + ",raw_json"]
    for row in rows:
        ts = row["ts"]
        dt_str = (
            datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
            + "Z"
        )
        d = json.loads(row["data"])
        ext = _extract(row["packet_type"], d)
        vals = ",".join(str(ext[f]) for f in FIELDS)
        raw = '"' + json.dumps(d).replace('"', '""') + '"'
        lines.append(f"{ts},{dt_str},{row['packet_type']},{vals},{raw}")

    path.write_text("\n".join(lines), encoding="utf-8")


def _save_gpx(conn, flight, flight_id: int, path: Path) -> None:
    rows = conn.execute(
        """
        SELECT ts, data FROM telemetry
        WHERE flight_id=? AND packet_type='GPS_RAW_INT'
        ORDER BY ts
        """,
        (flight_id,),
    ).fetchall()

    trkpts = []
    for r in rows:
        d = json.loads(r["data"])
        lat = d.get("lat")
        lon = d.get("lon")
        alt = d.get("alt")
        if lat is None or lon is None:
            continue
        lat_deg = lat / 1e7
        lon_deg = lon / 1e7
        alt_m = (alt / 1000.0) if alt is not None else 0.0
        ts_iso = datetime.fromtimestamp(r["ts"] / 1000.0, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        trkpts.append(
            f'      <trkpt lat="{lat_deg:.7f}" lon="{lon_deg:.7f}">'
            f"<ele>{alt_m:.1f}</ele><time>{ts_iso}</time></trkpt>"
        )

    start_iso = datetime.fromtimestamp(flight["start_ts"], tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    trkpts_str = "\n".join(trkpts)
    gpx = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="DronePulse"'
        ' xmlns="http://www.topografix.com/GPX/1/1">\n'
        "  <metadata>\n"
        f"    <name>Flight {flight_id} \u2014 {flight['drone_id']}</name>\n"
        f"    <time>{start_iso}</time>\n"
        "  </metadata>\n"
        "  <trk>\n"
        f"    <name>Flight {flight_id}</name>\n"
        "    <trkseg>\n"
        f"{trkpts_str}\n"
        "    </trkseg>\n"
        "  </trk>\n"
        "</gpx>"
    )
    path.write_text(gpx, encoding="utf-8")


def _save_kml(conn, flight, flight_id: int, path: Path) -> None:
    rows = conn.execute(
        """
        SELECT ts, data FROM telemetry
        WHERE flight_id=? AND packet_type='GPS_RAW_INT'
        ORDER BY ts
        """,
        (flight_id,),
    ).fetchall()

    coords = []
    for r in rows:
        d = json.loads(r["data"])
        lat = d.get("lat")
        lon = d.get("lon")
        alt = d.get("alt")
        if lat is None or lon is None:
            continue
        lat_deg = lat / 1e7
        lon_deg = lon / 1e7
        alt_m = (alt / 1000.0) if alt is not None else 0.0
        coords.append(f"{lon_deg:.7f},{lat_deg:.7f},{alt_m:.1f}")

    coord_str = "\n                ".join(coords)
    kml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2">\n'
        "  <Document>\n"
        f"    <name>Flight {flight_id} \u2014 {flight['drone_id']}</name>\n"
        '    <Style id="flightPath">\n'
        "      <LineStyle><color>ff0088ff</color><width>3</width></LineStyle>\n"
        "      <PolyStyle><color>440088ff</color></PolyStyle>\n"
        "    </Style>\n"
        "    <Placemark>\n"
        f"      <name>Flight {flight_id}</name>\n"
        "      <styleUrl>#flightPath</styleUrl>\n"
        "      <LineString>\n"
        "        <altitudeMode>absolute</altitudeMode>\n"
        "        <coordinates>\n"
        f"                {coord_str}\n"
        "        </coordinates>\n"
        "      </LineString>\n"
        "    </Placemark>\n"
        "  </Document>\n"
        "</kml>"
    )
    path.write_text(kml, encoding="utf-8")
