# AiDronePulse

A real-time drone telemetry monitoring system with AI-powered health scoring and alerting. MAVLink-based drones stream telemetry through a centralized WebSocket/HTTP gateway into a Redis pipeline where a scoring engine computes composite health scores and an alert engine surfaces critical conditions — all displayed in a live React/Electron dashboard.

## Architecture

```
Drone (MAVLink)
    │
    ▼
Raspberry Pi / ESP32
  forwarder.py  ──WebSocket/HTTP──►  Gateway (Go)  ──Redis Streams──►  Workers (Python)
                                          │                                   │
                                          │ WebSocket                         │ Redis PubSub
                                          ▼                                   ▼
                                   React Dashboard  ◄────── scores:* channel ─┘
                                   (Electron App)
```

## Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| **RPi Forwarder** | Python 3, pymavlink, websockets | Reads MAVLink over serial, forwards to gateway |
| **Gateway** | Go 1.21, Gorilla WebSocket, go-redis | Central hub — ingests drone telemetry, fans out to dashboards, pushes to Redis Streams |
| **Workers** | Python 3, redis-py | Consumes Redis Streams, runs scoring & alert engines, publishes results via PubSub |
| **Dashboard** | React 18, Vite, Electron, Zustand, Leaflet, Recharts | Multi-page desktop app for fleet monitoring |

## Project Structure

```
Ai-Drone-Pulse/
├── gateway/
│   ├── main.go              # Go gateway server
│   ├── dashboard.html       # Embedded legacy HTML dashboard
│   ├── go.mod / go.sum
│   └── railway.toml         # Railway.app deployment config
├── rpi-forwarder/
│   ├── forwarder.py         # MAVLink → WebSocket forwarder
│   └── requirements.txt
├── workers/
│   ├── main.py              # Entry point — discovers drones via Redis keys
│   ├── consumer.py          # Per-drone stream consumer
│   ├── scoring_engine.py    # Computes pwr/imu/ekf/gps/ctl/mot/com scores
│   ├── alert_engine.py      # Generates alerts from score thresholds
│   ├── requirements.txt
│   ├── Procfile             # Railway worker process
│   └── railway.toml
└── dashboard/
    ├── src/
    │   ├── App.jsx
    │   ├── pages/           # FleetPage, DetailPage, AlertsPage, MapPage, HUDPage
    │   ├── components/      # Titlebar, Sidebar, ArcGauge, ScoreBar
    │   ├── hooks/
    │   │   └── useWebSocket.js
    │   └── store/
    │       └── useDroneStore.js
    ├── electron/            # Electron shell (main.js, preload.js)
    ├── package.json
    └── vite.config.js
```

## Getting Started

### Gateway Server

**Prerequisites:** Go 1.21+

```bash
cd gateway
go build -o gateway .
./gateway
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `DRONE_API_KEY` | `dev-secret` | Shared secret for drone authentication |
| `REDIS_URL` | _(unset)_ | Redis connection URL — enables scoring pipeline |

The gateway runs without Redis; scoring and alerts require it.

### Workers

**Prerequisites:** Python 3.10+, Redis

```bash
cd workers
pip install -r requirements.txt
REDIS_URL=redis://localhost:6379 python main.py
```

The worker process auto-discovers new drones by scanning `telemetry:*` keys in Redis every 10 seconds and spawns a `ConsumerWorker` per drone.

### RPi Forwarder

**Prerequisites:** Python 3, Raspberry Pi with a drone connected via serial

```bash
cd rpi-forwarder
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
| `DRONE_API_KEY` | `dev-secret` | Must match the gateway's `DRONE_API_KEY` |

### React Dashboard (Dev)

**Prerequisites:** Node.js 18+

```bash
cd dashboard
npm install
npm run dev       # Vite dev server + Electron
```

**Build for production:**

```bash
npm run build     # Outputs to dist/
npm run electron  # Launch Electron against built dist
```

## Gateway API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check — returns `{status, timestamp}` |
| `/api/drones` | GET | Connected drone stats and IDs |
| `/api/telemetry?drone_id=<id>` | GET | Last 100 buffered telemetry packets for a drone |
| `/drone/ws?drone_id=<id>&api_key=<key>` | WS | WebSocket endpoint for drone forwarders |
| `/drone/telemetry` | POST | HTTP batch endpoint for ESP32-style forwarders |
| `/dashboard/ws` | WS | WebSocket endpoint for dashboard clients |

### POST /drone/telemetry body

```json
{
  "drone_id": "DR-001",
  "api_key": "dev-secret",
  "packets": [
    { "type": "HEARTBEAT", "ts": 1710000000, "data": { ... } }
  ]
}
```

## AI Scoring Pipeline

Each telemetry packet is consumed by the `ScoringEngine`, which produces seven sub-scores (0–100) and a weighted composite:

| Score | MAVLink Source | Weight |
|-------|---------------|--------|
| `pwr` | `SYS_STATUS` — voltage + battery % | 20% |
| `imu` | `SCALED_IMU` — accel magnitude + gyro | 15% |
| `ekf` | `EKF_STATUS_REPORT` — flags + variances | 20% |
| `gps` | `GPS_RAW_INT` — fix type + satellites + HDOP | 15% |
| `ctl` | `ATTITUDE` — roll + pitch deviation | 10% |
| `mot` | `RC_CHANNELS_RAW` — channel range + balance | 10% |
| `com` | `SYS_STATUS` drop rate + heartbeat age | 10% |

Scores are published on the `scores:<drone_id>` Redis PubSub channel and forwarded to dashboard clients as `STATE_UPDATE` events.

### Alert Thresholds

| Code | Condition | Level |
|------|-----------|-------|
| `LOW_BATTERY` | pwr < 30 | critical |
| `BATTERY_WARN` | pwr < 50 | warn |
| `GPS_POOR` | gps < 40 | critical |
| `EKF_UNHEALTHY` | ekf < 40 | critical |
| `IMU_FAULT` | imu < 40 | critical |
| `COMMS_LOST` | com < 40 | critical |
| `HEALTH_CRITICAL` | composite < 30 | critical |
| `HEALTH_WARN` | composite < 50 | warn |

## Dashboard Pages

| Page | Route | Description |
|------|-------|-------------|
| Fleet | `/fleet` | Live fleet overview — online status, message count, last-seen |
| Detail | `/detail/:droneId` | Per-drone telemetry, score history, packet log |
| HUD | `/hud/:droneId` | Heads-up display with arc gauges and score bars |
| Map | `/map` | Live drone positions on a Leaflet map |
| Alerts | `/alerts` | Active and historical alert feed |

## MAVLink Data Streams

The forwarder requests the following MAVLink streams from the drone at connection time:

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

Both the gateway and workers are configured for [Railway.app](https://railway.app) via their respective `railway.toml` files.

**Gateway** — compiled by Nixpacks, health-checked at `/health`:

```toml
# gateway/railway.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "./gateway"
healthcheckPath = "/health"
restartPolicyType = "on_failure"
```

**Workers** — started via Procfile:

```
worker: python main.py
```

Set `REDIS_URL` in Railway environment variables for both services to connect them.
