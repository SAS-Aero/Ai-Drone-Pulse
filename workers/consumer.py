import asyncio
import json
import logging
import threading
import time

import redis

from scoring_engine import ScoringEngine
from alert_engine import AlertEngine
from power_health import PowerHealthEngine
from storage_engine import StorageEngine

logger = logging.getLogger(__name__)

# MAVLink message types consumed by the PowerHealthEngine
POWER_MSG_TYPES = {"BATTERY_STATUS", "SYS_STATUS", "POWER_STATUS"}


class ConsumerWorker:
    def __init__(self, redis_url: str, drone_id: str):
        self.drone_id = drone_id
        self.stream_key = f"telemetry:{drone_id}"
        self.scores_channel = f"scores:{drone_id}"
        self.redis = redis.from_url(redis_url, decode_responses=True)
        self.scoring = ScoringEngine()
        self.alert = AlertEngine()
        # One PowerHealthEngine per drone — accumulates state across messages
        # and persists the internal-resistance baseline in Redis.
        self.power_engine = PowerHealthEngine(drone_id, self.redis)
        # SQLite flight-log persistence
        self.storage = StorageEngine(drone_id)
        self.last_id = "0"
        self._stop = threading.Event()

        # Background thread: closes stale flight sessions after SESSION_TIMEOUT_S
        t = threading.Thread(
            target=self._timeout_loop,
            daemon=True,
            name=f"storage-timeout-{drone_id}",
        )
        t.start()

    def _timeout_loop(self):
        while not self._stop.wait(timeout=10):
            try:
                self.storage.check_session_timeout()
            except Exception as exc:
                logger.error("[consumer] storage timeout error for %s: %s", self.drone_id, exc)

    async def run(self):
        logger.info("[consumer] starting worker for %s", self.drone_id)
        loop = asyncio.get_event_loop()

        try:
            while True:
                try:
                    results = await loop.run_in_executor(
                        None,
                        lambda: self.redis.xread(
                            {self.stream_key: self.last_id},
                            count=10,
                            block=1000,
                        ),
                    )

                    if not results:
                        continue

                    for _stream, messages in results:
                        for msg_id, fields in messages:
                            self.last_id = msg_id
                            raw = fields.get("data", "{}")
                            try:
                                packet = json.loads(raw)
                            except json.JSONDecodeError:
                                logger.warning("[consumer] bad JSON for %s: %s", self.drone_id, raw)
                                continue

                            msg_type = packet.get("type", "")

                            # Persist raw telemetry before any scoring
                            try:
                                self.storage.store_packet(packet)
                            except Exception as exc:
                                logger.error("[consumer] store_packet error for %s: %s", self.drone_id, exc)

                            # Feed power-related messages into PowerHealthEngine so it
                            # can build signal history and compute richer features.
                            if msg_type in POWER_MSG_TYPES:
                                pkt_data = dict(packet.get("data", {}))
                                pkt_data["ts"] = packet.get("ts", time.time())
                                self.power_engine.update(msg_type, pkt_data)

                            # All-subsystem scores from the existing engine (imu, ekf,
                            # gps, ctl, mot, com — and a simple pwr we will override).
                            scores = self.scoring.score(packet)
                            scores["drone_id"] = self.drone_id
                            scores["timestamp"] = time.time()

                            # Replace the simple pwr score with the PowerHealthEngine
                            # composite (cell health, pack health, thermal, sys power).
                            power_result = self.power_engine.score()
                            scores["pwr"] = round(power_result.composite, 2)

                            # Expose per-subsystem breakdown for the dashboard detail view.
                            scores["pwr_detail"] = {
                                k: {
                                    "score": round(v.score, 1),
                                    "status": v.status,
                                    "reason": v.reason,
                                }
                                for k, v in power_result.sub_scores.items()
                            }
                            scores["pwr_status"] = power_result.status
                            scores["pwr_diagnostics"] = power_result.diagnostics

                            if power_result.override:
                                scores["pwr_override"] = power_result.override_reason
                                logger.warning(
                                    "[consumer] power OVERRIDE for %s: %s",
                                    self.drone_id,
                                    power_result.override_reason,
                                )

                            # Recompute the overall composite with the updated pwr score.
                            scores["composite"] = round(
                                scores["pwr"] * 0.20
                                + scores["imu"] * 0.15
                                + scores["ekf"] * 0.20
                                + scores["gps"] * 0.15
                                + scores["ctl"] * 0.10
                                + scores["mot"] * 0.10
                                + scores["com"] * 0.10,
                                2,
                            )

                            alerts = self.alert.check(scores, self.scoring.state)
                            scores["alerts"] = alerts

                            # Persist scores and any alerts
                            try:
                                self.storage.store_scores(scores)
                                for alert in alerts:
                                    self.storage.store_alert(alert)
                            except Exception as exc:
                                logger.error("[consumer] storage write error for %s: %s", self.drone_id, exc)

                            payload = json.dumps(scores)
                            await loop.run_in_executor(
                                None,
                                lambda p=payload: self.redis.publish(self.scores_channel, p),
                            )

                except Exception as exc:
                    logger.error("[consumer] error for %s: %s", self.drone_id, exc)
                    await asyncio.sleep(2)

        finally:
            self._stop.set()
            self.storage.close()
