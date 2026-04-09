"""
DronePulse — UDP MAVLink Bridge
Listens for raw MAVLink bytes on UDP 14550 (sent by ESP32 forwarder),
parses them, and forwards JSON packets to the Railway gateway over WebSocket.

Usage:
    pip install pymavlink websockets
    python udp_bridge.py

Env vars (all optional):
    DRONE_ID        default: DR-002
    GATEWAY_WS      default: wss://dronepulse-production.up.railway.app
    DRONE_API_KEY   default: dronepulse-secret-001
    UDP_PORT        default: 14550
"""

import asyncio
import json
import logging
import os
import socket
import time
from datetime import datetime, timezone

import websockets
from pymavlink import mavutil

# ── Config ────────────────────────────────────────────────────────────────────
DRONE_ID      = os.getenv("DRONE_ID",      "DR-002")
GATEWAY_WS    = os.getenv("GATEWAY_WS",    "wss://dronepulse-production.up.railway.app")
DRONE_API_KEY = os.getenv("DRONE_API_KEY", "dronepulse-secret-001")
UDP_PORT      = int(os.getenv("UDP_PORT",  "14550"))

GATEWAY_URL = f"{GATEWAY_WS}/drone/ws?drone_id={DRONE_ID}&api_key={DRONE_API_KEY}"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ── MAVLink via UDP ───────────────────────────────────────────────────────────

def make_udp_mav():
    """Open a pymavlink connection on UDP port 14550 (input only)."""
    conn_str = f"udpin:0.0.0.0:{UDP_PORT}"
    log.info(f"Listening for MAVLink on UDP port {UDP_PORT} ...")
    mav = mavutil.mavlink_connection(conn_str)
    return mav

# ── Bridge ────────────────────────────────────────────────────────────────────

async def forward(ws, mav):
    sent = 0
    last_stat = time.monotonic()
    loop = asyncio.get_running_loop()

    while True:
        # recv_match is blocking — run in executor
        msg = await loop.run_in_executor(
            None, lambda: mav.recv_match(blocking=True, timeout=1)
        )
        if msg is None:
            continue
        if msg.get_type() in ("BAD_DATA", "UNKNOWN"):
            continue

        packet = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type":      msg.get_type(),
            "data":      msg.to_dict(),
        }
        await ws.send(json.dumps(packet))
        sent += 1

        now = time.monotonic()
        if now - last_stat >= 5:
            log.info(f"[{DRONE_ID}] forwarded {sent} packets")
            last_stat = now


async def run():
    mav = make_udp_mav()

    while True:
        log.info(f"[{DRONE_ID}] Connecting to gateway: {GATEWAY_URL}")
        try:
            async with websockets.connect(
                GATEWAY_URL,
                ping_interval=20,
                ping_timeout=10,
            ) as ws:
                log.info(f"[{DRONE_ID}] Gateway connected — waiting for ESP32 UDP packets ...")
                await forward(ws, mav)
        except Exception as exc:
            log.warning(f"[{DRONE_ID}] Gateway error: {exc}. Retrying in 5s ...")
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(run())
