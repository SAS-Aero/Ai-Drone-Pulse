# DronePulse

A real-time drone telemetry monitoring system that bridges MAVLink-based drones to a live web dashboard via a centralized WebSocket gateway.

## Overview

DronePulse consists of three components:

1. **RPi Forwarder** — Python service running on a Raspberry Pi, reads MAVLink telemetry over serial and forwards it to the gateway via WebSocket.
2. **Gateway Server** — Go-based central hub that aggregates connections from multiple drones and streams data to dashboard clients.
3. **Web Dashboard** — Single-page HTML/JS app for real-time monitoring of drone fleet status and telemetry.

```
Drone (MAVLink) → Raspberry Pi (forwarder.py) → Gateway (main.go) → Web Dashboard
```

## Project Structure

```
Ai-Drone-Pulse/
└── DronePulse/
    ├── gateway/
    │   ├── main.go          # Go gateway server
    │   ├── dashboard.html   # Web dashboard UI
    │   ├── go.mod
    │   ├── go.sum
    │   └── railway.toml     # Railway.app deployment config
    └── rpi-forwarder/
        ├── forwarder.py     # MAVLink → WebSocket forwarder
        └── requirements.txt
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Gateway server | Go 1.21, Gorilla WebSocket |
| RPi forwarder | Python 3, pymavlink, websockets (asyncio) |
| Dashboard | Vanilla HTML/CSS/JS, JetBrains Mono, dark theme |
| Deployment | Railway.app (Nixpacks) |

## Getting Started

### Gateway Server

**Prerequisites:** Go 1.21+

```bash
cd DronePulse/gateway
go build -o gateway .
./gateway
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `DRONE_API_KEY` | `dev-secret` | Shared secret for drone authentication |

Once running, open `http://localhost:8080` to view the dashboard.

### RPi Forwarder

**Prerequisites:** Python 3, a Raspberry Pi connected to a drone via serial

```bash
cd DronePulse/rpi-forwarder
pip install -r requirements.txt
python forwarder.py
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SERIAL_PORT` | `/dev/serial0` | Serial port connected to the drone |
| `BAUD_RATE` | `57600` | Serial baud rate |
| `DRONE_ID` | `DR-001` | Unique identifier for this drone |
| `GATEWAY_WS` | `wss://your-app.up.railway.app` | Gateway WebSocket URL |
| `DRONE_API_KEY` | `dev-secret` | Must match the gateway's API key |

## Gateway API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /api/drones` | Connected drone stats |
| `GET /api/telemetry?drone_id=<id>` | Buffered telemetry packets (last 100) for a drone |
| `WS /drone/ws` | WebSocket endpoint for drone forwarders |
| `WS /dashboard/ws` | WebSocket endpoint for dashboard clients |

## Dashboard Features

- Live drone fleet overview with per-drone online status, message count, and last-seen time
- Scrolling packet log showing timestamp, drone ID, message type, and data snippet
- Message type breakdown sorted by frequency
- Auto-reconnect with 3-second retry on disconnect

## MAVLink Data Streams

The forwarder requests the following MAVLink streams from the drone:

| Stream | Rate |
|--------|------|
| RAW_SENSORS | 10 Hz |
| EXTENDED_STATUS | 5 Hz |
| POSITION | 5 Hz |
| EXTRA1 | 10 Hz |
| EXTRA2 | 5 Hz |
| EXTRA3 | 2 Hz |
| RC_CHANNELS | 5 Hz |

## Deployment

The gateway is configured for one-click deployment to [Railway.app](https://railway.app) via `railway.toml`. The Nixpacks builder compiles and runs the Go binary automatically. A health check is performed at `/health` after startup.

```toml
# DronePulse/gateway/railway.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "./gateway"
healthcheckPath = "/health"
restartPolicyType = "on_failure"
```
