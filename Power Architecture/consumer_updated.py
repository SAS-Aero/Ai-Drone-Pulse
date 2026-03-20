"""
consumer.py — updated to use PowerHealthEngine
Drop-in replacement for the power scoring section of your existing consumer.

Key change: PowerHealthEngine replaces the single-packet pwr score.
It accumulates state across messages and scores the full subsystem.
"""

import json
import time
import redis
from power_health import PowerHealthEngine

# Map from MAVLink message type strings to what PowerHealthEngine understands
POWER_MSG_TYPES = {
    "BATTERY_STATUS",   # #147 — per-cell voltages, current, energy
    "SYS_STATUS",       # #1   — pack voltage, current, battery %
    "POWER_STATUS",     # #125 — Vcc, VServo, flags
}


class ConsumerWorker:
    def __init__(self, drone_id: str, redis_client: redis.Redis):
        self.drone_id = drone_id
        self.redis = redis_client
        self.stream_key = f"telemetry:{drone_id}"

        # One PowerHealthEngine per drone — holds state across packets
        self.power_engine = PowerHealthEngine(drone_id, redis_client)

        # Configure battery once — ideally loaded from a drone profile
        # 6S 5000mAh example: 22.2V nominal, 111Wh
        self.power_engine.configure_battery(capacity_ah=5.0, rated_wh=111.0)

    def run(self):
        last_id = "0"
        while True:
            entries = self.redis.xread(
                {self.stream_key: last_id}, count=50, block=1000
            )
            if not entries:
                continue

            for _, messages in entries:
                for msg_id, fields in messages:
                    last_id = msg_id
                    self._process(fields)

    def _process(self, fields: dict):
        try:
            packet = json.loads(fields.get(b"data", b"{}"))
        except Exception:
            return

        msg_type = packet.get("type")
        data = packet.get("data", {})
        data["ts"] = packet.get("ts", time.time())

        # Feed all power-related messages into the engine
        if msg_type in POWER_MSG_TYPES:
            self.power_engine.update(msg_type, data)

            # Score and publish on every power message
            # (engine internally decides if it has enough data)
            result = self.power_engine.score()
            self._publish_power_score(result)

    def _publish_power_score(self, result):
        payload = result.to_dict()

        # Publish on the scores channel so gateway forwards to dashboard
        self.redis.publish(
            f"scores:{self.drone_id}",
            json.dumps(payload)
        )

        # Also store latest score for the /api/telemetry endpoint
        self.redis.setex(
            f"power_score:{self.drone_id}",
            300,  # 5-min TTL
            json.dumps(payload)
        )
