"""
DronePulse — Redis Stream Consumer

Reads telemetry from Redis streams (pushed by the Go gateway),
passes data to the scoring engine, and publishes health scores
back via Redis PubSub for the gateway to broadcast to dashboards.
"""

import os
import json
import time
import redis
from scoring_engine import ScoringEngine
from alert_engine import AlertEngine

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
STREAM_PREFIX = "telemetry:"
CONSUMER_GROUP = "workers"
CONSUMER_NAME = f"worker-{os.getpid()}"
SCORE_PUBLISH_INTERVAL = 1.0  # seconds


def main():
    print("[Consumer] Connecting to Redis...")
    rdb = redis.from_url(REDIS_URL, decode_responses=True)
    rdb.ping()
    print("[Consumer] Connected")

    scorer = ScoringEngine()
    alerter = AlertEngine()

    # Discover drone streams and create consumer groups
    known_streams = set()

    def ensure_group(stream):
        if stream not in known_streams:
            try:
                rdb.xgroup_create(stream, CONSUMER_GROUP, id="0", mkstream=True)
            except redis.exceptions.ResponseError as e:
                if "BUSYGROUP" not in str(e):
                    raise
            known_streams.add(stream)

    last_score_publish = 0

    print("[Consumer] Listening for telemetry...")

    while True:
        # Scan for telemetry streams
        streams = {}
        for key in rdb.scan_iter(match=f"{STREAM_PREFIX}*"):
            ensure_group(key)
            streams[key] = ">"

        if not streams:
            time.sleep(0.5)
            continue

        # Read from all streams
        try:
            results = rdb.xreadgroup(
                CONSUMER_GROUP, CONSUMER_NAME,
                streams=streams,
                count=50,
                block=500,
            )
        except redis.exceptions.ResponseError:
            time.sleep(1)
            continue

        for stream_name, messages in results:
            drone_id = stream_name.replace(STREAM_PREFIX, "")

            for msg_id, fields in messages:
                msg_type = fields.get("type", "")
                raw_data = fields.get("data", "{}")

                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError:
                    continue

                # Feed to scoring engine
                scorer.ingest(drone_id, msg_type, data)

                # ACK the message
                rdb.xack(stream_name, CONSUMER_GROUP, msg_id)

        # Periodically publish scores
        now = time.time()
        if now - last_score_publish >= SCORE_PUBLISH_INTERVAL:
            last_score_publish = now

            for drone_id in scorer.get_drone_ids():
                # Publish health scores
                scores = scorer.compute_scores(drone_id)
                score_packet = json.dumps({
                    "type": "HEALTH_SCORES",
                    "drone_id": drone_id,
                    "data": scores,
                    "server_ts": int(now * 1000),
                })
                rdb.publish(f"scores:{drone_id}", score_packet)

                # Check for alerts
                alerts = alerter.check(drone_id, scores)
                for alert in alerts:
                    alert_packet = json.dumps({
                        "type": "ALERT",
                        "drone_id": drone_id,
                        "data": alert,
                        "server_ts": int(now * 1000),
                    })
                    rdb.publish(f"scores:{drone_id}", alert_packet)


if __name__ == "__main__":
    main()
