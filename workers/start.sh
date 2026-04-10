#!/bin/bash
# Start the storage REST API in background (internal port 8081)
uvicorn api:app --host 0.0.0.0 --port 8081 &

# Start the telemetry worker in foreground.
# Railway restarts the container if this process exits.
exec python main.py
