import asyncio
import logging
import os

import redis
from dotenv import load_dotenv

from consumer import ConsumerWorker

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)


async def discovery_loop(redis_url: str, active: dict):
    r = redis.from_url(redis_url, decode_responses=True)
    loop = asyncio.get_event_loop()

    while True:
        try:
            keys = await loop.run_in_executor(None, lambda: r.keys("telemetry:*"))
            for key in keys:
                drone_id = key.removeprefix("telemetry:")
                if drone_id not in active:
                    logger.info("[main] discovered new drone: %s", drone_id)
                    worker = ConsumerWorker(redis_url, drone_id)
                    task = asyncio.create_task(worker.run(), name=f"worker-{drone_id}")
                    active[drone_id] = task
        except Exception as exc:
            logger.error("[main] discovery error: %s", exc)

        await asyncio.sleep(10)


async def main():
    redis_url = os.environ.get("REDIS_URL")
    if not redis_url:
        raise RuntimeError("REDIS_URL environment variable is required")

    logger.info("[main] DronePulse workers starting, REDIS_URL set")

    active: dict = {}
    await discovery_loop(redis_url, active)


if __name__ == "__main__":
    asyncio.run(main())
