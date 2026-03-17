"""
DronePulse – Raspberry Pi MAVLink Forwarder
Reads MAVLink from serial and forwards JSON packets to the Railway gateway.
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone

import websockets
from pymavlink import mavutil

# ── Config ────────────────────────────────────────────────────────────────────

SERIAL_PORT   = os.getenv("SERIAL_PORT",   "/dev/serial0")
BAUD_RATE     = int(os.getenv("BAUD_RATE", "57600"))
DRONE_ID      = os.getenv("DRONE_ID",      "DR-001")
GATEWAY_WS    = os.getenv("GATEWAY_WS",    "wss://your-app.up.railway.app")
DRONE_API_KEY = os.getenv("DRONE_API_KEY", "dev-secret")

GATEWAY_URL = f"{GATEWAY_WS}/drone/ws?drone_id={DRONE_ID}&api_key={DRONE_API_KEY}"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ── MAVLink stream requests ───────────────────────────────────────────────────

STREAMS = [
    (mavutil.mavlink.MAV_DATA_STREAM_RAW_SENSORS,     10),
    (mavutil.mavlink.MAV_DATA_STREAM_EXTENDED_STATUS,  5),
    (mavutil.mavlink.MAV_DATA_STREAM_POSITION,         5),
    (mavutil.mavlink.MAV_DATA_STREAM_EXTRA1,          10),
    (mavutil.mavlink.MAV_DATA_STREAM_EXTRA2,           5),
    (mavutil.mavlink.MAV_DATA_STREAM_EXTRA3,           2),
    (mavutil.mavlink.MAV_DATA_STREAM_RC_CHANNELS,      5),
]


def request_streams(mav):
    """Send each stream request 3× for reliability."""
    for stream_id, rate in STREAMS:
        for _ in range(3):
            mav.mav.request_data_stream_send(
                mav.target_system,
                mav.target_component,
                stream_id,
                rate,
                1,  # start
            )
    log.info(f"[{DRONE_ID}] Stream requests sent.")


# ── Forwarder ─────────────────────────────────────────────────────────────────

async def forward(ws, mav):
    """Read MAVLink messages and send them as JSON packets over the WebSocket."""
    sent = 0
    last_stat = time.monotonic()

    loop = asyncio.get_running_loop()

    while True:
        # recv_match is blocking – run in executor to keep async loop alive
        msg = await loop.run_in_executor(None, lambda: mav.recv_match(blocking=True, timeout=1))

        if msg is None:
            continue
        if msg.get_type() == "BAD_DATA":
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
            log.info(f"[{DRONE_ID}] sent {sent} packets")
            last_stat = now


async def run():
    log.info(f"[{DRONE_ID}] Connecting to serial {SERIAL_PORT} @ {BAUD_RATE} baud …")
    mav = mavutil.mavlink_connection(SERIAL_PORT, baud=BAUD_RATE)

    log.info(f"[{DRONE_ID}] Waiting for heartbeat …")
    mav.wait_heartbeat()
    log.info(f"[{DRONE_ID}] Heartbeat received. Requesting streams …")
    request_streams(mav)

    while True:
        log.info(f"[{DRONE_ID}] Connecting to gateway: {GATEWAY_URL}")
        try:
            async with websockets.connect(
                GATEWAY_URL,
                ping_interval=20,
                ping_timeout=10,
            ) as ws:
                log.info(f"[{DRONE_ID}] Gateway connected.")
                await forward(ws, mav)
        except Exception as exc:
            log.warning(f"[{DRONE_ID}] Gateway error: {exc}. Retrying in 5 s …")
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(run())
