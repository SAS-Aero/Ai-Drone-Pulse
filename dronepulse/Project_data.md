# DronePulse — Predictive Health Monitoring System

## Mission

Real-time drone health monitoring + ML-based predictive failure analysis. The system continuously streams telemetry and vibration data from a drone to a server, where an ML model performs health scoring and alerts the operator **before** a failure occurs (motor degradation, bearing wear, prop imbalance, battery anomalies, etc.).

**Current stage:** Proof of concept prototype. Local server is acceptable.

## System Architecture

```
                        ┌──────────────────────────────────────┐
                        │           DRONE (Quadcopter)          │
                        │                                      │
   ┌─────────┐  UART   │   ┌──────────────────────────────┐   │
   │ Flight  │ MAVLink  │   │     Main ESP32 (esp32dev)    │   │
   │Controller├─────────┤   │                              │   │
   │(ArduPilot)│ Serial2 │   │  • Reads MAVLink telemetry   │   │
   └─────────┘ 57600    │   │  • Receives vibe data (UART) │   │
                        │   │  • Streams all data to server│   │
                        │   │    via WiFi + WebSocket      │   │
                        │   └──────────┬───────────────────┘   │
                        │              │ UART (Serial1)         │
                        │              │ 115200 baud            │
                        │   ┌──────────┴───────────────────┐   │
                        │   │   ESP32-C3 Super Mini (Rx)   │   │
                        │   │                              │   │
                        │   │  • Receives vibration data   │   │
                        │   │    from 4 nodes via ESP-NOW  │   │
                        │   │  • Forwards to main ESP32    │   │
                        │   │    over UART as CSV          │   │
                        │   └──────────────────────────────┘   │
                        │              ▲ ESP-NOW (2.4 GHz)     │
                        │    ┌─────────┼─────────┐             │
                        │    │         │         │             │
                        │  ┌─┴──┐  ┌──┴──┐  ┌──┴──┐  ┌─────┐│
                        │  │Node│  │Node │  │Node │  │Node ││
                        │  │ 1  │  │ 2   │  │ 3   │  │ 4   ││
                        │  └────┘  └─────┘  └─────┘  └─────┘│
                        │  (one per arm, each has accelerometer)│
                        └──────────────────────────────────────┘
                                       │
                                       │ WiFi → WebSocket (WSS)
                                       ▼
                        ┌──────────────────────────────────────┐
                        │         DronePulse Server            │
                        │                                      │
                        │  ┌────────────────────────────────┐  │
                        │  │  Gateway (Go, WebSocket hub)   │  │
                        │  │  • Accepts drone WS connections│  │
                        │  │  • Broadcasts to dashboard     │  │
                        │  │  • Pushes to Redis Streams     │  │
                        │  └────────────┬───────────────────┘  │
                        │               │                      │
                        │  ┌────────────▼───────────────────┐  │
                        │  │  Workers (Python)              │  │
                        │  │  • consumer.py — reads Redis   │  │
                        │  │  • scoring_engine.py — ML      │  │
                        │  │  • alert_engine.py — warnings  │  │
                        │  └────────────┬───────────────────┘  │
                        │               │                      │
                        │  ┌────────────▼───────────────────┐  │
                        │  │  Web Dashboard (HTML/JS)       │  │
                        │  │  • Real-time telemetry display │  │
                        │  │  • Health scores & alerts      │  │
                        │  │  • Vibration visualization     │  │
                        │  └────────────────────────────────┘  │
                        └──────────────────────────────────────┘
```

## Hardware Components

### Main ESP32 (esp32dev)
- **Role:** Central telemetry hub on the drone
- **Connections:**
  - Serial2 (GPIO 16 RX / 17 TX) → Flight Controller (MAVLink v2 @ 57600 baud)
  - Serial1 (GPIO 4 RX / 5 TX) → ESP32-C3 Super Mini (vibe data @ 115200 baud)
  - WiFi → Server (WebSocket over SSL)
- **Firmware:** `src/main.cpp` (PlatformIO, Arduino framework)

### ESP32-C3 Super Mini (Receiver)
- **Role:** Vibration data aggregator
- **Connections:**
  - ESP-NOW (2.4 GHz, channel 1) ← 4 sensor nodes
  - UART (GPIO 21 TX / 20 RX) → Main ESP32
- **Firmware:** `Rx/Rx.ino`
- **Sends:** CSV over UART at 100 Hz: `n1x,n1y,n1z,n2x,n2y,n2z,n3x,n3y,n3z,n4x,n4y,n4z\n`

### Vibration Sensor Nodes (×4)
- **Role:** One per drone arm, measure vibration (3-axis accelerometer)
- **Communication:** ESP-NOW → C3 receiver
- **Data packet:** `{ nodeId, seq, vibeX_ms2, vibeY_ms2, vibeZ_ms2, clip0 }`
- **Firmware:** Separate TX project (not in this repo)

### Flight Controller
- ArduPilot-based (ArduCopter)
- Outputs MAVLink v2 telemetry over UART

## Data Streams

### MAVLink Telemetry (from Flight Controller)

| Message | Rate | Key Parameters |
|---------|------|----------------|
| HEARTBEAT | 0.5 Hz | flight mode, type, autopilot, system_status |
| SYS_STATUS | 1 Hz | battery voltage/current/remaining, comm drop rate |
| GPS_RAW_INT | 2 Hz | lat, lon, alt, fix type, satellites, eph |
| ATTITUDE | 5 Hz | roll, pitch, yaw + angular rates |
| GLOBAL_POSITION_INT | 2 Hz | lat, lon, alt, relative_alt, velocity, heading |
| VFR_HUD | 2 Hz | airspeed, groundspeed, alt, climb, heading, throttle |
| SCALED_IMU | 1 Hz | 3-axis accelerometer + gyroscope |
| RC_CHANNELS_RAW | 1 Hz | channels 1–4, RSSI |
| POWER_STATUS | 0.5 Hz | Vcc, Vservo, power flags |
| EKF_STATUS_REPORT | 0.5 Hz | EKF flags, velocity/position/compass variance |

### Vibration Data (from 4 Sensor Nodes)

| Parameter | Rate | Description |
|-----------|------|-------------|
| Per-node x, y, z | 100 Hz | Raw 3-axis acceleration (m/s²) per arm |
| 4 nodes × 3 axes | = 12 values per sample | Sent as CSV over UART |

**What vibration data reveals:**
- Motor health (bearing wear → increased vibration)
- Propeller imbalance (asymmetric vibration signature)
- Frame structural issues (resonance patterns)
- Loose components (intermittent spikes)
- Per-arm comparison enables isolation of which motor/prop is degrading

## Server Components

### Gateway (`gateway/main.go`)
- **Language:** Go
- **Protocol:** WebSocket
- **Endpoints:**
  - `WS /drone/ws?drone_id=X&api_key=Y` — drone forwarder connects here
  - `WS /dashboard/ws` — dashboard clients connect here
  - `GET /health` — health check
  - `GET /api/drones` — connected drone stats
  - `GET /api/telemetry?drone_id=X` — last 100 buffered packets
  - `GET /` — serves dashboard HTML
- **Data flow:** Drone WS message → broadcast to dashboard clients + push to Redis Stream
- **Deployment:** Railway.app (can run locally)
- **Auth:** `DRONE_API_KEY` env var (default: `dev-secret`)

### Workers (`workers/`)
- `consumer.py` — reads telemetry from Redis Streams
- `scoring_engine.py` — ML-based health scoring (vibration analysis, battery degradation, etc.)
- `alert_engine.py` — generates warnings/alerts based on scores
- Publishes scores to Redis PubSub `scores:*` → gateway broadcasts to dashboard

### Web Dashboard (`gateway/dashboard.html`)
- Single-page app, vanilla HTML/CSS/JS
- Connects via WebSocket to `/dashboard/ws`
- Shows: drone fleet status, scrolling packet log, message type breakdown
- Receives real-time telemetry + health scores from gateway

## Communication Protocol

### ESP32 → Server (WebSocket)
Each message is a single JSON object:
```json
{
  "timestamp": "12345",
  "type": "VIBE_NODES",
  "data": {
    "n1": {"x": 0.12, "y": -0.05, "z": 9.81},
    "n2": {"x": 0.08, "y": 0.03, "z": 9.79},
    "n3": {"x": -0.01, "y": 0.11, "z": 9.83},
    "n4": {"x": 0.05, "y": -0.02, "z": 9.80}
  }
}
```

MAVLink messages follow the same format:
```json
{
  "timestamp": "12345",
  "type": "ATTITUDE",
  "data": {"roll": 0.01, "pitch": -0.02, "yaw": 1.57, "rollspeed": 0.0, "pitchspeed": 0.0, "yawspeed": 0.0}
}
```

### C3 → Main ESP32 (UART)
Newline-delimited CSV at 115200 baud, 100 Hz:
```
0.12,-0.05,9.81,0.08,0.03,9.79,-0.01,0.11,9.83,0.05,-0.02,9.80\n
```

### Sensor Nodes → C3 (ESP-NOW)
Binary packed struct:
```c
struct VibePacket {
  uint8_t  nodeId;      // 1–4
  uint32_t seq;         // sequence number
  float    vibeX_ms2;   // acceleration X (m/s²)
  float    vibeY_ms2;   // acceleration Y (m/s²)
  float    vibeZ_ms2;   // acceleration Z (m/s²)
  uint32_t clip0;       // clipping count
};
```

## Repository Structure

```
esp32-forwarder-main/
├── src/
│   └── main.cpp              # Main ESP32 firmware (MAVLink + vibe → WebSocket)
├── Rx/
│   └── Rx.ino                # ESP32-C3 firmware (ESP-NOW → UART)
├── platformio.ini            # PlatformIO build config
├── CLAUDE.md                 # Codebase instructions
└── Project_data.md           # This file
```

### DronePulse Server (separate repo: SAS-Aero/Ai-Drone-Pulse)
```
Ai-Drone-Pulse/
├── gateway/
│   ├── main.go               # Go WebSocket gateway
│   ├── dashboard.html         # Web dashboard
│   ├── go.mod / go.sum
│   └── railway.toml
├── workers/
│   ├── consumer.py            # Redis stream consumer
│   ├── scoring_engine.py      # ML health scoring
│   ├── alert_engine.py        # Alert generation
│   ├── requirements.txt
│   └── railway.toml
└── rpi-forwarder/
    ├── forwarder.py           # RPi MAVLink forwarder (alternative to ESP32)
    └── requirements.txt
```

## Configuration

### Main ESP32 (`src/main.cpp`)
| Parameter | Value | Notes |
|-----------|-------|-------|
| WiFi SSID | `Goatifi` | Hardcoded |
| Drone ID | `DR-001` | |
| API Key | `dronepulse-secret-001` | Must match server |
| WS Host | `dronepulse-production.up.railway.app` | Or local server |
| WS Port | 443 (SSL) | 8080 for local |
| MAVLink UART | Serial2, 57600, GPIO 16/17 | |
| Vibe UART | Serial1, 115200, GPIO 4/5 | 4096-byte RX buffer |

### Gateway Server
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP/WS listen port |
| `DRONE_API_KEY` | `dev-secret` | Shared secret |
| `REDIS_URL` | (optional) | For workers pipeline |

## ML / Predictive Health Analysis Goals

The scoring engine should analyze incoming telemetry to detect and predict:

1. **Motor/Propeller Health** — vibration magnitude & frequency per arm; asymmetry between arms indicates degradation on a specific motor
2. **Battery Degradation** — voltage sag under load, remaining capacity trends, current draw anomalies
3. **IMU/Sensor Drift** — EKF variance trends, accelerometer bias shifts
4. **Structural Integrity** — resonance frequency changes in vibration data, abnormal frame flex
5. **GPS/Navigation** — satellite count drops, HDOP spikes, position variance growth
6. **Communication Health** — MAVLink drop rate, RSSI trends, ESP-NOW packet loss per node

**Output:** Per-subsystem health scores (0–100) + alerts when scores cross thresholds, pushed in real-time to the dashboard.

## Current Status & Known Issues

- **Working:** ESP32 reads MAVLink + receives vibe from C3 via UART + streams over WebSocket
- **Working:** C3 receives ESP-NOW from 4 nodes, forwards CSV to main ESP32 at 100 Hz
- **Issue:** Railway gateway service is currently down (502 — likely crashed or tier limit)
- **TODO:** Local server setup as alternative for PoC testing
- **TODO:** ML scoring engine needs training data & model development
- **TODO:** Dashboard needs vibration visualization (per-arm charts, frequency analysis)
- **TODO:** OTA update support for field firmware updates
- **TODO:** Credentials should move to a config mechanism (not hardcoded)
