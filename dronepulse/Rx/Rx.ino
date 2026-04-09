/*
 * DronePulse — ESP32-C3 Super Mini Receiver
 *
 * Receives vibration data from 4 sensor nodes via ESP-NOW
 * Aggregates latest readings and forwards CSV to Main ESP32 over UART
 *
 * Board: ESP32-C3 Super Mini
 * UART TX: GPIO 21 → Main ESP32 Serial1 RX (GPIO 4)
 * UART RX: GPIO 20 (unused, but wired for future commands)
 *
 * CSV output at ~100 Hz:
 *   n1x,n1y,n1z,n2x,n2y,n2z,n3x,n3y,n3z,n4x,n4y,n4z\n
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ======================= Configuration =======================

#define UART_TX_PIN   21
#define UART_RX_PIN   20
#define UART_BAUD     115200

#define NUM_NODES     4
#define SEND_INTERVAL_US  10000  // 10 ms = 100 Hz

// ESP-NOW channel (must match TX nodes)
#define ESPNOW_CHANNEL  1

// ======================= Data Structures =======================

// Must match the TX node struct exactly
typedef struct __attribute__((packed)) {
    uint8_t  nodeId;      // 1–4
    uint32_t seq;
    float    vibeX_ms2;
    float    vibeY_ms2;
    float    vibeZ_ms2;
    uint32_t clip0;
} VibePacket;

// Per-node tracking
struct NodeState {
    bool seen = false;
    uint32_t lastSeq = 0;
    uint32_t received = 0;
    uint32_t lost = 0;
    float vx = 0, vy = 0, vz = 0;
    uint32_t clip0 = 0;
    uint32_t rxCountWindow = 0;
    float rxHz = 0.0f;
};

NodeState nodes[5]; // index 1..4

// ======================= Ring Buffer =======================

const uint16_t RXQ = 128;
volatile uint16_t qH = 0, qT = 0;
volatile uint32_t qOverflow = 0;
VibePacket q[RXQ];

inline uint16_t qNext(uint16_t i) { return (uint16_t)((i + 1) % RXQ); }

// ======================= ESP-NOW Callback =======================

#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len != sizeof(VibePacket)) return;
    uint16_t nh = qNext(qH);
    if (nh == qT) { qOverflow++; return; }
    memcpy((void*)&q[qH], data, sizeof(VibePacket));
    qH = nh;
}
#else
void onDataRecv(const uint8_t *mac, const uint8_t *data, int len) {
    if (len != sizeof(VibePacket)) return;
    uint16_t nh = qNext(qH);
    if (nh == qT) { qOverflow++; return; }
    memcpy((void*)&q[qH], data, sizeof(VibePacket));
    qH = nh;
}
#endif

void processPacket(const VibePacket &p) {
    if (p.nodeId < 1 || p.nodeId > 4) return;
    NodeState &n = nodes[p.nodeId];

    if (!n.seen) {
        n.seen = true;
        n.lastSeq = p.seq;
    } else {
        if (p.seq > n.lastSeq + 1) n.lost += (p.seq - n.lastSeq - 1);
        else if (p.seq <= n.lastSeq) return; // old/duplicate
        n.lastSeq = p.seq;
    }

    n.received++;
    n.rxCountWindow++;
    n.vx = p.vibeX_ms2;
    n.vy = p.vibeY_ms2;
    n.vz = p.vibeZ_ms2;
    n.clip0 = p.clip0;
}

// ======================= Setup =======================

void setup() {
    Serial.begin(115200);
    delay(1200);

    // UART to main ESP32
    Serial1.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);

    // WiFi in station mode (required for ESP-NOW)
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.disconnect();
    esp_wifi_set_ps(WIFI_PS_NONE);
    esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

    Serial.println("\n[DronePulse-Rx] ESP32-C3 Receiver starting...");
    Serial.print("[DronePulse-Rx] MAC: ");
    Serial.println(WiFi.macAddress());
    Serial.print("[DronePulse-Rx] Channel: ");
    Serial.println(ESPNOW_CHANNEL);

    // Init ESP-NOW
    if (esp_now_init() != ESP_OK) {
        Serial.println("[ESP-NOW] Init FAILED — restarting");
        delay(1000);
        ESP.restart();
    }

    esp_now_register_recv_cb(onDataRecv);
    Serial.println("[DronePulse-Rx] ESP-NOW ready — listening for nodes...");
}

// ======================= Main Loop =======================

void loop() {
    // Drain ring buffer
    while (qT != qH) {
        noInterrupts();
        VibePacket p = q[qT];
        qT = qNext(qT);
        interrupts();
        processPacket(p);
    }

    // Update rxHz once per second
    static unsigned long lastRateMs = 0;
    if (millis() - lastRateMs >= 1000) {
        lastRateMs += 1000;
        for (int id = 1; id <= 4; id++) {
            nodes[id].rxHz = (float)nodes[id].rxCountWindow;
            nodes[id].rxCountWindow = 0;
        }
    }

    // Send CSV + debug at 100 Hz
    static unsigned long lastSend = 0;
    unsigned long now = micros();
    if (now - lastSend < SEND_INTERVAL_US) return;
    lastSend = now;

    // CSV: n1x,n1y,n1z,n2x,n2y,n2z,n3x,n3y,n3z,n4x,n4y,n4z
    char csv[256];
    snprintf(csv, sizeof(csv),
             "%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f\n",
             nodes[1].vx, nodes[1].vy, nodes[1].vz,
             nodes[2].vx, nodes[2].vy, nodes[2].vz,
             nodes[3].vx, nodes[3].vy, nodes[3].vz,
             nodes[4].vx, nodes[4].vy, nodes[4].vz);
    Serial1.print(csv);

    // Debug print at 10 Hz
    static uint8_t dbgDiv = 0;
    if (++dbgDiv >= 10) {
        dbgDiv = 0;
        for (int id = 1; id <= 4; id++) {
            NodeState &n = nodes[id];
            Serial.print("N"); Serial.print(id); Serial.print(" ");
            if (!n.seen) { Serial.print("---   "); continue; }

            uint32_t total = n.received + n.lost;
            float lossPct = (total > 0) ? (100.0f * (float)n.lost / (float)total) : 0.0f;
            float mag = sqrtf(n.vx * n.vx + n.vy * n.vy + n.vz * n.vz);

            Serial.print("V("); Serial.print(n.vx, 2); Serial.print(",");
            Serial.print(n.vy, 2); Serial.print(","); Serial.print(n.vz, 2); Serial.print(")");
            Serial.print(" mag:"); Serial.print(mag, 2);
            Serial.print(" loss%:"); Serial.print(lossPct, 2);
            Serial.print(" rxHz:"); Serial.print(n.rxHz, 1);
            Serial.print("   ");
        }
        Serial.print("| Qovf:"); Serial.println(qOverflow);
    }
}
