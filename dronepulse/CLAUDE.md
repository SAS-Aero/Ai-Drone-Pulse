# DronePulse

## Project Structure

```
dronepulse/
├── src/main.cpp              # Main ESP32 firmware (PlatformIO)
├── Rx/Rx.ino                 # ESP32-C3 receiver (Arduino IDE)
├── platformio.ini            # PlatformIO build config
├── lib/mavlink/              # MAVLink C headers (clone manually)
├── server/
│   ├── gateway/
│   │   ├── main.go           # Go WebSocket gateway
│   │   ├── dashboard.html    # Web dashboard (served at /)
│   │   ├── go.mod
│   │   └── go.sum
│   ├── workers/
│   │   ├── consumer.py       # Redis stream consumer
│   │   ├── scoring_engine.py # Rule-based health scoring
│   │   ├── alert_engine.py   # Alert generation
│   │   └── requirements.txt
│   └── .env.example
└── Project_data.md           # Full system documentation
```

## Firmware Setup

### 1. Install MAVLink headers

```bash
git clone https://github.com/mavlink/c_library_v2.git lib/mavlink
```

### 2. Build main ESP32

```bash
pio run                  # compile
pio run -t upload        # flash
pio device monitor       # serial monitor (115200)
```

### 3. Build C3 receiver

Open `Rx/Rx.ino` in Arduino IDE. Board: "ESP32C3 Dev Module". Upload.

### Firmware config

Edit `src/main.cpp` top section:
- `WIFI_SSID` / `WIFI_PASS` — WiFi credentials
- `WS_HOST` / `WS_PORT` — server address (default: `192.168.1.100:8080`)
- `DRONE_ID` / `API_KEY` — must match server `DRONE_API_KEY`

## Server Setup

### Prerequisites

- Go 1.22+ (for gateway)
- Python 3.10+ (for workers)
- Redis (optional — gateway works standalone without it)

### Run gateway (standalone, no Redis needed)

```bash
cd server/gateway
go mod tidy
go run main.go
```

Gateway starts on `http://localhost:8080`. Dashboard is at root `/`.

### Run with workers (requires Redis)

Terminal 1 — Redis:
```bash
redis-server
```

Terminal 2 — Gateway:
```bash
cd server/gateway
REDIS_URL=redis://localhost:6379 go run main.go
```

Terminal 3 — Worker:
```bash
cd server/workers
pip install -r requirements.txt
python consumer.py
```

### Server endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard |
| `WS /drone/ws?drone_id=X&api_key=Y` | Drone connection |
| `WS /dashboard/ws` | Dashboard WebSocket |
| `GET /health` | Health check JSON |
| `GET /api/drones` | Connected drone list |
| `GET /api/telemetry?drone_id=X` | Last 100 packets for drone |

### Server env vars

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `DRONE_API_KEY` | `dev-secret` | Auth key for drones |
| `REDIS_URL` | *(empty)* | Redis connection (empty = standalone mode) |

## Wiring

| Connection | From | To |
|---|---|---|
| MAVLink | FC TX → GPIO 16 (ESP32 RX2) | FC RX ← GPIO 17 (ESP32 TX2) |
| Vibe UART | C3 GPIO 21 (TX) → GPIO 4 (ESP32 RX1) | C3 GPIO 20 (RX) ← GPIO 5 (ESP32 TX1) |

## Notes

- MAVLink uses the **ardupilot** dialect (includes EKF_STATUS_REPORT)
- Vibration data is throttled to 100 Hz max on the WebSocket
- ESP-NOW channel 1 — all TX nodes must match
- Gateway works without Redis for quick PoC testing (no ML scores in that mode)
- Scoring engine uses rule-based heuristics — designed to swap in ML models later
