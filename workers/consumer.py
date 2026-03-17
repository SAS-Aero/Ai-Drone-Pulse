import asyncio
import json
import logging
import time

import redis

from scoring_engine import ScoringEngine
from alert_engine import AlertEngine

logger = logging.getLogger(__name__)


class ConsumerWorker:
    def __init__(self, redis_url: str, drone_id: str):
        self.drone_id = drone_id
        self.stream_key = f"telemetry:{drone_id}"
        self.scores_channel = f"scores:{drone_id}"
        self.redis = redis.from_url(redis_url, decode_responses=True)
        self.scoring = ScoringEngine()
        self.alert = AlertEngine()
        self.last_id = "0"

    async def run(self):
        logger.info("[consumer] starting worker for %s", self.drone_id)
        loop = asyncio.get_event_loop()

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

                        scores = self.scoring.score(packet)
                        scores["drone_id"] = self.drone_id
                        scores["timestamp"] = time.time()
                        alerts = self.alert.check(scores, self.scoring.state)
                        scores["alerts"] = alerts

                        payload = json.dumps(scores)
                        await loop.run_in_executor(
                            None,
                            lambda p=payload: self.redis.publish(self.scores_channel, p),
                        )

            except Exception as exc:
                logger.error("[consumer] error for %s: %s", self.drone_id, exc)
                await asyncio.sleep(2)
