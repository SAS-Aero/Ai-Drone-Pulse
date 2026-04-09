"""
api.py — Flight log query API for DronePulse.
Serves historical flight data stored by StorageEngine.

Run:  uvicorn api:app --host 0.0.0.0 --port 8081
Env:  STORAGE_DB_PATH  (default: data/dronepulse.db)
"""

import json
import math
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

DB_PATH: str = os.environ.get("STORAGE_DB_PATH", "data/dronepulse.db")

app = FastAPI(title="DronePulse Flight Log API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to dashboard origin in production
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ── /flights ─────────────────────────────────────────────────────────────────

@app.get("/flights")
def list_flights(
    drone_id: str = None,
    limit: int = Query(default=50, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """Completed flights ordered newest-first. Filter by drone_id optionally."""
    conn = _db()
    try:
        if drone_id:
            rows = conn.execute(
                """
                SELECT * FROM flights
                WHERE drone_id = ? AND end_ts IS NOT NULL
                ORDER BY start_ts DESC
                LIMIT ? OFFSET ?
                """,
                (drone_id, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM flights
                WHERE end_ts IS NOT NULL
                ORDER BY start_ts DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── /flights/{flight_id}/scores ───────────────────────────────────────────────

@app.get("/flights/{flight_id}/scores")
def flight_scores(flight_id: int):
    """All score snapshots for a flight, ordered by timestamp."""
    conn = _db()
    try:
        if not conn.execute("SELECT id FROM flights WHERE id=?", (flight_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Flight not found")
        rows = conn.execute(
            "SELECT * FROM scores WHERE flight_id=? ORDER BY ts",
            (flight_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── /flights/{flight_id}/telemetry ────────────────────────────────────────────

@app.get("/flights/{flight_id}/telemetry")
def flight_telemetry(
    flight_id: int,
    packet_type: str = None,
    downsample: int = Query(default=1, ge=1, le=100),
):
    """
    Telemetry packets for a flight.
    - packet_type: optional filter (e.g. BATTERY_STATUS)
    - downsample: keep every Nth row (rowid % downsample = 0); 1 = all rows
    """
    conn = _db()
    try:
        if not conn.execute("SELECT id FROM flights WHERE id=?", (flight_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Flight not found")

        if packet_type:
            rows = conn.execute(
                """
                SELECT ts, packet_type AS type, data FROM telemetry
                WHERE flight_id=? AND packet_type=? AND rowid % ?=0
                ORDER BY ts
                """,
                (flight_id, packet_type, downsample),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT ts, packet_type AS type, data FROM telemetry
                WHERE flight_id=? AND rowid % ?=0
                ORDER BY ts
                """,
                (flight_id, downsample),
            ).fetchall()

        return [
            {"ts": r["ts"], "type": r["type"], "data": json.loads(r["data"])}
            for r in rows
        ]
    finally:
        conn.close()


# ── /flights/{flight_id}/path ─────────────────────────────────────────────────

@app.get("/flights/{flight_id}/path")
def flight_path(flight_id: int):
    """
    GPS_RAW_INT packets for a flight as a flat list of {ts, ...data fields}.
    Use this to replay the flight path on a map.
    """
    conn = _db()
    try:
        if not conn.execute("SELECT id FROM flights WHERE id=?", (flight_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Flight not found")
        rows = conn.execute(
            """
            SELECT ts, data FROM telemetry
            WHERE flight_id=? AND packet_type='GPS_RAW_INT'
            ORDER BY ts
            """,
            (flight_id,),
        ).fetchall()
        return [{"ts": r["ts"], **json.loads(r["data"])} for r in rows]
    finally:
        conn.close()


# ── /drones/{drone_id}/battery-health ────────────────────────────────────────

@app.get("/drones/{drone_id}/battery-health")
def drone_battery_health(drone_id: str):
    """
    Per-flight battery stats for a drone, ordered oldest-first.
    Returns start_ts, min_battery, tags — useful for degradation trending.
    """
    conn = _db()
    try:
        rows = conn.execute(
            """
            SELECT start_ts, min_battery, tags FROM flights
            WHERE drone_id=? AND end_ts IS NOT NULL
            ORDER BY start_ts ASC
            """,
            (drone_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── /drones ───────────────────────────────────────────────────────────────────

@app.get("/drones")
def list_drones():
    """All known drones with summary stats ordered by last_seen descending."""
    conn = _db()
    try:
        rows = conn.execute(
            "SELECT * FROM drones ORDER BY last_seen DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── /drones/{drone_id}/battery-cycles ────────────────────────────────────────

@app.get("/drones/{drone_id}/battery-cycles")
def battery_cycles(drone_id: str):
    """
    Per-flight battery discharge data for cycle count and degradation analysis.
    Each completed flight counts as one discharge cycle.
    """
    conn = _db()
    try:
        drone = conn.execute(
            "SELECT * FROM drones WHERE drone_id=?", (drone_id,)
        ).fetchone()
        if not drone:
            raise HTTPException(status_code=404, detail="Drone not found")

        flights = conn.execute(
            """
            SELECT id, start_ts, end_ts, duration_s, min_battery, tags
            FROM flights
            WHERE drone_id=? AND end_ts IS NOT NULL
            ORDER BY start_ts ASC
            """,
            (drone_id,),
        ).fetchall()

        cycles = []
        for i, f in enumerate(flights):
            first_score = conn.execute(
                "SELECT pwr FROM scores WHERE flight_id=? ORDER BY ts ASC LIMIT 1",
                (f["id"],),
            ).fetchone()
            last_score = conn.execute(
                "SELECT pwr FROM scores WHERE flight_id=? ORDER BY ts DESC LIMIT 1",
                (f["id"],),
            ).fetchone()
            cycles.append({
                "cycle": i + 1,
                "flight_id": f["id"],
                "start_ts": f["start_ts"],
                "duration_s": f["duration_s"],
                "min_battery_pct": f["min_battery"],
                "start_pwr_score": first_score["pwr"] if first_score else None,
                "end_pwr_score": last_score["pwr"] if last_score else None,
                "tags": f["tags"],
            })

        return {
            "drone_id": drone_id,
            "total_cycles": len(cycles),
            "total_flights": dict(drone)["total_flights"],
            "cycles": cycles,
        }
    finally:
        conn.close()


# ── /flights/{flight_id}/export/gpx ──────────────────────────────────────────

@app.get("/flights/{flight_id}/export/gpx")
def export_gpx(flight_id: int):
    """Export a flight path as a GPX track file (GPS Exchange Format)."""
    conn = _db()
    try:
        flight = conn.execute(
            "SELECT * FROM flights WHERE id=?", (flight_id,)
        ).fetchone()
        if not flight:
            raise HTTPException(status_code=404, detail="Flight not found")

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
            # ts is stored as ms since epoch
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

        return Response(
            content=gpx,
            media_type="application/gpx+xml",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="flight_{flight_id}_{flight["drone_id"]}.gpx"'
                )
            },
        )
    finally:
        conn.close()


# ── /flights/{flight_id}/export/kml ──────────────────────────────────────────

@app.get("/flights/{flight_id}/export/kml")
def export_kml(flight_id: int):
    """Export a flight path as a KML file (Google Earth / Maps compatible)."""
    conn = _db()
    try:
        flight = conn.execute(
            "SELECT * FROM flights WHERE id=?", (flight_id,)
        ).fetchone()
        if not flight:
            raise HTTPException(status_code=404, detail="Flight not found")

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

        return Response(
            content=kml,
            media_type="application/vnd.google-earth.kml+xml",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="flight_{flight_id}_{flight["drone_id"]}.kml"'
                )
            },
        )
    finally:
        conn.close()


# ── /heatmap ──────────────────────────────────────────────────────────────────

@app.get("/heatmap")
def heatmap_data(
    drone_id: str = None,
    max_points: int = Query(default=5000, ge=100, le=50000),
):
    """
    GPS positions across all completed flights for heatmap rendering.
    Auto-downsamples to max_points if needed.
    """
    conn = _db()
    try:
        if drone_id:
            rows = conn.execute(
                """
                SELECT t.data FROM telemetry t
                JOIN flights f ON t.flight_id = f.id
                WHERE t.packet_type = 'GPS_RAW_INT'
                AND f.drone_id = ? AND f.end_ts IS NOT NULL
                ORDER BY t.id
                """,
                (drone_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT t.data FROM telemetry t
                JOIN flights f ON t.flight_id = f.id
                WHERE t.packet_type = 'GPS_RAW_INT'
                AND f.end_ts IS NOT NULL
                ORDER BY t.id
                """
            ).fetchall()

        step = max(1, len(rows) // max_points)
        points = []
        for i, r in enumerate(rows):
            if i % step != 0:
                continue
            d = json.loads(r["data"])
            lat = d.get("lat")
            lon = d.get("lon")
            if lat is None or lon is None:
                continue
            points.append({"lat": lat / 1e7, "lng": lon / 1e7})

        return {"points": points, "total": len(rows), "returned": len(points)}
    finally:
        conn.close()


# ── /flights/{flight_id}/report ───────────────────────────────────────────────

@app.get("/flights/{flight_id}/report")
def flight_report(flight_id: int):
    """Comprehensive data package for generating a printable flight report."""
    conn = _db()
    try:
        flight = conn.execute(
            "SELECT * FROM flights WHERE id=?", (flight_id,)
        ).fetchone()
        if not flight:
            raise HTTPException(status_code=404, detail="Flight not found")

        scores = conn.execute(
            "SELECT * FROM scores WHERE flight_id=? ORDER BY ts",
            (flight_id,),
        ).fetchall()

        alerts = conn.execute(
            "SELECT * FROM alerts WHERE flight_id=? ORDER BY ts",
            (flight_id,),
        ).fetchall()

        path_rows = conn.execute(
            """
            SELECT ts, data FROM telemetry
            WHERE flight_id=? AND packet_type='GPS_RAW_INT'
            ORDER BY ts
            """,
            (flight_id,),
        ).fetchall()

        # Compute total distance via haversine
        dist_m = 0.0
        prev = None
        for r in path_rows:
            d = json.loads(r["data"])
            lat = d.get("lat")
            lon = d.get("lon")
            if lat is None or lon is None:
                continue
            lat_deg = lat / 1e7
            lon_deg = lon / 1e7
            if prev:
                dist_m += _haversine(prev[0], prev[1], lat_deg, lon_deg)
            prev = (lat_deg, lon_deg)

        final_scores = dict(scores[-1]) if scores else {}

        return {
            "flight": dict(flight),
            "final_scores": final_scores,
            "score_count": len(scores),
            "alert_count": len(alerts),
            "alerts": [dict(a) for a in alerts],
            "distance_m": round(dist_m, 1),
            "gps_point_count": len(path_rows),
            "score_timeline": [
                {"ts": s["ts"], "composite": s["composite"], "pwr": s["pwr"]}
                for s in scores
            ],
        }
    finally:
        conn.close()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine great-circle distance in metres between two lat/lon points."""
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
