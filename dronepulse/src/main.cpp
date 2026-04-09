/*
 * DronePulse — Main ESP32 Firmware
 *
 * Reads MAVLink telemetry from flight controller (Serial2)
 * Receives vibration CSV from ESP32-C3 receiver (Serial1)
 * Streams everything to DronePulse server over WebSocket
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ardupilotmega/mavlink.h>

// ======================= Configuration =======================

// WiFi
const char* WIFI_SSID     = "Goatifi";
const char* WIFI_PASS     = "nigga123";  // TODO: set your WiFi password

// Drone identity
const char* DRONE_ID      = "DR-001";
const char* API_KEY        = "dev-secret";

// Server — local PoC (change IP to your server machine)
const char* WS_HOST       = "192.168.137.1";
const uint16_t WS_PORT    = 8080;
const bool USE_SSL        = false;

// Server — Railway production (uncomment to use)
// const char* WS_HOST    = "dronepulse-production.up.railway.app";
// const uint16_t WS_PORT = 443;
// const bool USE_SSL     = true;

// ======================= Pin Definitions =======================

// MAVLink UART (Flight Controller)
#define MAV_RX_PIN    16
#define MAV_TX_PIN    17
#define MAV_BAUD      57600

// Vibration UART (ESP32-C3 Receiver)
#define VIBE_RX_PIN   4
#define VIBE_TX_PIN   5
#define VIBE_BAUD     115200
#define VIBE_RX_BUF   4096

// ======================= Globals =======================

WebSocketsClient ws;
mavlink_message_t mavMsg;
mavlink_status_t  mavStatus;
bool wsConnected = false;

// Vibration line buffer
static char vibeBuf[256];
static int  vibeIdx = 0;

// Timing — throttle vibe sends to avoid flooding
static unsigned long lastVibeSend = 0;
const unsigned long VIBE_SEND_INTERVAL_MS = 10;  // 100 Hz max

// ======================= Forward Declarations =======================

void onWsEvent(WStype_t type, uint8_t* payload, size_t length);
void handleMavMessage(mavlink_message_t* msg);
void processVibeLine(const char* line);
void sendJson(const char* type, JsonDocument& doc);

// ======================= Setup =======================

void setup() {
    Serial.begin(115200);
    Serial.println("\n[DronePulse] Main ESP32 starting...");

    // Vibration UART — set buffer size before begin()
    Serial1.setRxBufferSize(VIBE_RX_BUF);
    Serial1.begin(VIBE_BAUD, SERIAL_8N1, VIBE_RX_PIN, VIBE_TX_PIN);

    // MAVLink UART
    Serial2.begin(MAV_BAUD, SERIAL_8N1, MAV_RX_PIN, MAV_TX_PIN);

    // WiFi
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[WiFi] Connecting");
    unsigned long wifiStart = millis();
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
        if (millis() - wifiStart > 15000) {
            Serial.println("\n[WiFi] Connection timeout — restarting");
            ESP.restart();
        }
    }
    Serial.printf("\n[WiFi] Connected — IP: %s\n", WiFi.localIP().toString().c_str());

    // WebSocket
    String path = String("/drone/ws?drone_id=") + DRONE_ID + "&api_key=" + API_KEY;
    if (USE_SSL) {
        ws.beginSSL(WS_HOST, WS_PORT, path);
    } else {
        ws.begin(WS_HOST, WS_PORT, path);
    }
    ws.onEvent(onWsEvent);
    ws.setReconnectInterval(3000);

    Serial.println("[DronePulse] Ready — waiting for data...");
}

// ======================= Main Loop =======================

void loop() {
    ws.loop();

    // --- MAVLink ---
    while (Serial2.available()) {
        uint8_t c = Serial2.read();
        if (mavlink_parse_char(MAVLINK_COMM_0, c, &mavMsg, &mavStatus)) {
            handleMavMessage(&mavMsg);
        }
    }

    // --- Vibration UART ---
    while (Serial1.available()) {
        char c = Serial1.read();
        if (c == '\n') {
            vibeBuf[vibeIdx] = '\0';
            if (vibeIdx > 0) {
                unsigned long now = millis();
                if (now - lastVibeSend >= VIBE_SEND_INTERVAL_MS) {
                    processVibeLine(vibeBuf);
                    lastVibeSend = now;
                }
            }
            vibeIdx = 0;
        } else if (vibeIdx < (int)sizeof(vibeBuf) - 1) {
            vibeBuf[vibeIdx++] = c;
        }
    }
}

// ======================= WebSocket =======================

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_CONNECTED:
            wsConnected = true;
            Serial.printf("[WS] Connected to %s:%d\n", WS_HOST, WS_PORT);
            break;
        case WStype_DISCONNECTED:
            wsConnected = false;
            Serial.println("[WS] Disconnected");
            break;
        case WStype_TEXT:
            Serial.printf("[WS] Server: %.*s\n", (int)length, payload);
            break;
        default:
            break;
    }
}

void sendJson(const char* type, JsonDocument& data) {
    if (!wsConnected) return;

    JsonDocument envelope;
    envelope["timestamp"] = String(millis());
    envelope["type"]      = type;
    envelope["data"]      = data;

    String out;
    serializeJson(envelope, out);
    ws.sendTXT(out);
}

// ======================= MAVLink Handlers =======================

void handleMavMessage(mavlink_message_t* msg) {
    JsonDocument doc;

    switch (msg->msgid) {

        case MAVLINK_MSG_ID_HEARTBEAT: {
            mavlink_heartbeat_t hb;
            mavlink_msg_heartbeat_decode(msg, &hb);
            doc["type"]          = hb.type;
            doc["autopilot"]     = hb.autopilot;
            doc["base_mode"]     = hb.base_mode;
            doc["custom_mode"]   = hb.custom_mode;
            doc["system_status"] = hb.system_status;
            sendJson("HEARTBEAT", doc);
            break;
        }

        case MAVLINK_MSG_ID_SYS_STATUS: {
            mavlink_sys_status_t ss;
            mavlink_msg_sys_status_decode(msg, &ss);
            doc["voltage_battery"]  = ss.voltage_battery;
            doc["current_battery"]  = ss.current_battery;
            doc["battery_remaining"]= ss.battery_remaining;
            doc["drop_rate_comm"]   = ss.drop_rate_comm;
            sendJson("SYS_STATUS", doc);
            break;
        }

        case MAVLINK_MSG_ID_GPS_RAW_INT: {
            mavlink_gps_raw_int_t gps;
            mavlink_msg_gps_raw_int_decode(msg, &gps);
            doc["lat"]                = gps.lat / 1e7;
            doc["lon"]                = gps.lon / 1e7;
            doc["alt"]                = gps.alt / 1000.0;
            doc["fix_type"]           = gps.fix_type;
            doc["satellites_visible"] = gps.satellites_visible;
            doc["eph"]                = gps.eph;
            sendJson("GPS_RAW_INT", doc);
            break;
        }

        case MAVLINK_MSG_ID_ATTITUDE: {
            mavlink_attitude_t att;
            mavlink_msg_attitude_decode(msg, &att);
            doc["roll"]       = att.roll;
            doc["pitch"]      = att.pitch;
            doc["yaw"]        = att.yaw;
            doc["rollspeed"]  = att.rollspeed;
            doc["pitchspeed"] = att.pitchspeed;
            doc["yawspeed"]   = att.yawspeed;
            sendJson("ATTITUDE", doc);
            break;
        }

        case MAVLINK_MSG_ID_GLOBAL_POSITION_INT: {
            mavlink_global_position_int_t gp;
            mavlink_msg_global_position_int_decode(msg, &gp);
            doc["lat"]          = gp.lat / 1e7;
            doc["lon"]          = gp.lon / 1e7;
            doc["alt"]          = gp.alt / 1000.0;
            doc["relative_alt"] = gp.relative_alt / 1000.0;
            doc["vx"]           = gp.vx / 100.0;
            doc["vy"]           = gp.vy / 100.0;
            doc["vz"]           = gp.vz / 100.0;
            doc["hdg"]          = gp.hdg / 100.0;
            sendJson("GLOBAL_POSITION_INT", doc);
            break;
        }

        case MAVLINK_MSG_ID_VFR_HUD: {
            mavlink_vfr_hud_t hud;
            mavlink_msg_vfr_hud_decode(msg, &hud);
            doc["airspeed"]    = hud.airspeed;
            doc["groundspeed"] = hud.groundspeed;
            doc["alt"]         = hud.alt;
            doc["climb"]       = hud.climb;
            doc["heading"]     = hud.heading;
            doc["throttle"]    = hud.throttle;
            sendJson("VFR_HUD", doc);
            break;
        }

        case MAVLINK_MSG_ID_SCALED_IMU: {
            mavlink_scaled_imu_t imu;
            mavlink_msg_scaled_imu_decode(msg, &imu);
            doc["xacc"]  = imu.xacc / 1000.0;
            doc["yacc"]  = imu.yacc / 1000.0;
            doc["zacc"]  = imu.zacc / 1000.0;
            doc["xgyro"] = imu.xgyro / 1000.0;
            doc["ygyro"] = imu.ygyro / 1000.0;
            doc["zgyro"] = imu.zgyro / 1000.0;
            sendJson("SCALED_IMU", doc);
            break;
        }

        case MAVLINK_MSG_ID_RC_CHANNELS_RAW: {
            mavlink_rc_channels_raw_t rc;
            mavlink_msg_rc_channels_raw_decode(msg, &rc);
            doc["chan1_raw"] = rc.chan1_raw;
            doc["chan2_raw"] = rc.chan2_raw;
            doc["chan3_raw"] = rc.chan3_raw;
            doc["chan4_raw"] = rc.chan4_raw;
            doc["rssi"]      = rc.rssi;
            sendJson("RC_CHANNELS_RAW", doc);
            break;
        }

        case MAVLINK_MSG_ID_POWER_STATUS: {
            mavlink_power_status_t ps;
            mavlink_msg_power_status_decode(msg, &ps);
            doc["Vcc"]    = ps.Vcc;
            doc["Vservo"] = ps.Vservo;
            doc["flags"]  = ps.flags;
            sendJson("POWER_STATUS", doc);
            break;
        }

        case MAVLINK_MSG_ID_EKF_STATUS_REPORT: {
            mavlink_ekf_status_report_t ekf;
            mavlink_msg_ekf_status_report_decode(msg, &ekf);
            doc["flags"]                = ekf.flags;
            doc["velocity_variance"]    = ekf.velocity_variance;
            doc["pos_horiz_variance"]   = ekf.pos_horiz_variance;
            doc["pos_vert_variance"]    = ekf.pos_vert_variance;
            doc["compass_variance"]     = ekf.compass_variance;
            doc["terrain_alt_variance"] = ekf.terrain_alt_variance;
            sendJson("EKF_STATUS_REPORT", doc);
            break;
        }
    }
}

// ======================= Vibration Processing =======================

void processVibeLine(const char* line) {
    // Expected CSV: n1x,n1y,n1z,n2x,n2y,n2z,n3x,n3y,n3z,n4x,n4y,n4z
    float vals[12];
    int count = 0;

    char buf[256];
    strncpy(buf, line, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char* token = strtok(buf, ",");
    while (token && count < 12) {
        vals[count++] = atof(token);
        token = strtok(NULL, ",");
    }

    if (count != 12) return;  // malformed line, skip

    JsonDocument doc;

    JsonObject n1 = doc["n1"].to<JsonObject>();
    n1["x"] = vals[0];  n1["y"] = vals[1];  n1["z"] = vals[2];

    JsonObject n2 = doc["n2"].to<JsonObject>();
    n2["x"] = vals[3];  n2["y"] = vals[4];  n2["z"] = vals[5];

    JsonObject n3 = doc["n3"].to<JsonObject>();
    n3["x"] = vals[6];  n3["y"] = vals[7];  n3["z"] = vals[8];

    JsonObject n4 = doc["n4"].to<JsonObject>();
    n4["x"] = vals[9];  n4["y"] = vals[10]; n4["z"] = vals[11];

    sendJson("VIBE_NODES", doc);
}
