/*
 * ESP32F — DronePulse Forwarder
 * Reads MAVLink (Serial2) + Vibration CSV (Serial1)
 * Batches every 2 s and POSTs to Railway via HTTPS
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ardupilotmega/mavlink.h>

// ── Config ────────────────────────────────────────────────────────────────────
#define WIFI_SSID     "projectX Labs"
#define WIFI_PASSWORD "ProjectXLabs@WD40"
#define DRONE_ID      "DR-002"
#define API_KEY       "dronepulse-secret-001"
#define POST_URL      "https://dronepulse-production.up.railway.app/drone/telemetry"

// MAVLink — flight controller on Serial2
#define MAV_RX   16
#define MAV_TX   17
#define MAV_BAUD 57600

// Vibration unit — ESP32-C3 on Serial1
#define VIB_RX   4
#define VIB_TX   5
#define VIB_BAUD 115200

#define BATCH_MS  2000
#define BATCH_MAX 20

// ── Rate limits per MAVLink message ID (ms between accepted packets) ──────────
static uint32_t rateFor(uint32_t id) {
    switch (id) {
        case 0:   return 2000;  // HEARTBEAT
        case 1:   return 1000;  // SYS_STATUS
        case 24:  return  500;  // GPS_RAW_INT
        case 26:  return 1000;  // SCALED_IMU
        case 30:  return  200;  // ATTITUDE
        case 33:  return  500;  // GLOBAL_POSITION_INT
        case 35:  return 1000;  // RC_CHANNELS_RAW
        case 74:  return  500;  // VFR_HUD
        case 125: return 2000;  // POWER_STATUS
        case 193: return 2000;  // EKF_STATUS_REPORT
        default:  return    0;  // ignore
    }
}

static const char* msgName(uint32_t id) {
    switch (id) {
        case 0:   return "HEARTBEAT";
        case 1:   return "SYS_STATUS";
        case 24:  return "GPS_RAW_INT";
        case 26:  return "SCALED_IMU";
        case 30:  return "ATTITUDE";
        case 33:  return "GLOBAL_POSITION_INT";
        case 35:  return "RC_CHANNELS_RAW";
        case 74:  return "VFR_HUD";
        case 125: return "POWER_STATUS";
        case 193: return "EKF_STATUS_REPORT";
        default:  return nullptr;
    }
}

// ── Globals ───────────────────────────────────────────────────────────────────
static uint32_t lastSent[256] = {};

JsonDocument batch;
JsonArray    packets;
int          pktCount  = 0;
uint32_t     lastFlush = 0;

char     vibLine[256];
int      vibIdx  = 0;
uint32_t lastVibe = 0;

uint32_t mavCount   = 0;
uint32_t postOk     = 0;
uint32_t lastStats  = 0;
uint32_t lastStream = 0;

// ── Request MAVLink data streams from FC ──────────────────────────────────────
static void requestStreams() {
    lastStream = millis();
    const struct { uint8_t id; uint8_t hz; } S[] = {
        {MAV_DATA_STREAM_EXTENDED_STATUS, 2},
        {MAV_DATA_STREAM_POSITION,        2},
        {MAV_DATA_STREAM_EXTRA1,          5},
        {MAV_DATA_STREAM_EXTRA2,          2},
        {MAV_DATA_STREAM_RAW_SENSORS,     2},
        {MAV_DATA_STREAM_RC_CHANNELS,     1},
    };
    mavlink_message_t msg;
    uint8_t buf[MAVLINK_MAX_PACKET_LEN];
    for (auto& s : S) {
        mavlink_msg_request_data_stream_pack(255, 190, &msg, 1, 1, s.id, s.hz, 1);
        Serial2.write(buf, mavlink_msg_to_send_buffer(buf, &msg));
    }
}

// ── Add one MAVLink message to batch ─────────────────────────────────────────
static void collectMAV(mavlink_message_t& msg) {
    uint32_t rate = rateFor(msg.msgid);
    if (rate == 0) return;
    uint32_t now = millis();
    if (now - lastSent[msg.msgid] < rate) return;
    lastSent[msg.msgid] = now;
    if (pktCount >= BATCH_MAX) return;

    JsonObject p = packets.add<JsonObject>();
    p["type"] = msgName(msg.msgid);
    p["ts"]   = now;
    JsonObject d = p["data"].to<JsonObject>();

    switch (msg.msgid) {
        case 0:
            d["custom_mode"]   = mavlink_msg_heartbeat_get_custom_mode(&msg);
            d["base_mode"]     = mavlink_msg_heartbeat_get_base_mode(&msg);
            d["system_status"] = mavlink_msg_heartbeat_get_system_status(&msg);
            break;
        case 1:
            d["voltage_battery"]   = mavlink_msg_sys_status_get_voltage_battery(&msg);
            d["current_battery"]   = mavlink_msg_sys_status_get_current_battery(&msg);
            d["battery_remaining"] = mavlink_msg_sys_status_get_battery_remaining(&msg);
            d["drop_rate_comm"]    = mavlink_msg_sys_status_get_drop_rate_comm(&msg);
            break;
        case 24:
            d["lat"]                = mavlink_msg_gps_raw_int_get_lat(&msg);
            d["lon"]                = mavlink_msg_gps_raw_int_get_lon(&msg);
            d["alt"]                = mavlink_msg_gps_raw_int_get_alt(&msg);
            d["fix_type"]           = mavlink_msg_gps_raw_int_get_fix_type(&msg);
            d["satellites_visible"] = mavlink_msg_gps_raw_int_get_satellites_visible(&msg);
            d["eph"]                = mavlink_msg_gps_raw_int_get_eph(&msg);
            break;
        case 26:
            d["xacc"]  = mavlink_msg_scaled_imu_get_xacc(&msg);
            d["yacc"]  = mavlink_msg_scaled_imu_get_yacc(&msg);
            d["zacc"]  = mavlink_msg_scaled_imu_get_zacc(&msg);
            d["xgyro"] = mavlink_msg_scaled_imu_get_xgyro(&msg);
            d["ygyro"] = mavlink_msg_scaled_imu_get_ygyro(&msg);
            d["zgyro"] = mavlink_msg_scaled_imu_get_zgyro(&msg);
            break;
        case 30:
            d["roll"]       = mavlink_msg_attitude_get_roll(&msg);
            d["pitch"]      = mavlink_msg_attitude_get_pitch(&msg);
            d["yaw"]        = mavlink_msg_attitude_get_yaw(&msg);
            d["rollspeed"]  = mavlink_msg_attitude_get_rollspeed(&msg);
            d["pitchspeed"] = mavlink_msg_attitude_get_pitchspeed(&msg);
            d["yawspeed"]   = mavlink_msg_attitude_get_yawspeed(&msg);
            break;
        case 33:
            d["lat"]          = mavlink_msg_global_position_int_get_lat(&msg);
            d["lon"]          = mavlink_msg_global_position_int_get_lon(&msg);
            d["alt"]          = mavlink_msg_global_position_int_get_alt(&msg);
            d["relative_alt"] = mavlink_msg_global_position_int_get_relative_alt(&msg);
            d["hdg"]          = mavlink_msg_global_position_int_get_hdg(&msg);
            break;
        case 35:
            d["chan1_raw"] = mavlink_msg_rc_channels_raw_get_chan1_raw(&msg);
            d["chan3_raw"] = mavlink_msg_rc_channels_raw_get_chan3_raw(&msg);
            d["rssi"]      = mavlink_msg_rc_channels_raw_get_rssi(&msg);
            break;
        case 74:
            d["airspeed"]    = mavlink_msg_vfr_hud_get_airspeed(&msg);
            d["groundspeed"] = mavlink_msg_vfr_hud_get_groundspeed(&msg);
            d["alt"]         = mavlink_msg_vfr_hud_get_alt(&msg);
            d["climb"]       = mavlink_msg_vfr_hud_get_climb(&msg);
            d["heading"]     = mavlink_msg_vfr_hud_get_heading(&msg);
            d["throttle"]    = mavlink_msg_vfr_hud_get_throttle(&msg);
            break;
        case 125:
            d["Vcc"]    = mavlink_msg_power_status_get_Vcc(&msg);
            d["Vservo"] = mavlink_msg_power_status_get_Vservo(&msg);
            break;
        case 193:
            d["flags"]              = mavlink_msg_ekf_status_report_get_flags(&msg);
            d["velocity_variance"]  = mavlink_msg_ekf_status_report_get_velocity_variance(&msg);
            d["pos_horiz_variance"] = mavlink_msg_ekf_status_report_get_pos_horiz_variance(&msg);
            d["pos_vert_variance"]  = mavlink_msg_ekf_status_report_get_pos_vert_variance(&msg);
            d["compass_variance"]   = mavlink_msg_ekf_status_report_get_compass_variance(&msg);
            break;
    }
    pktCount++;
}

// ── Add one vibration CSV line to batch ───────────────────────────────────────
static void collectVibe(const char* line) {
    uint32_t now = millis();
    if (now - lastVibe < 500) return;
    lastVibe = now;
    if (pktCount >= BATCH_MAX) return;

    float v[12]; int n = 0;
    char tmp[256]; strncpy(tmp, line, 255); tmp[255] = '\0';
    char* tok = strtok(tmp, ",");
    while (tok && n < 12) { v[n++] = atof(tok); tok = strtok(nullptr, ","); }
    if (n != 12) return;

    JsonObject p = packets.add<JsonObject>();
    p["type"] = "VIBE_NODES";
    p["ts"]   = now;
    JsonObject d = p["data"].to<JsonObject>();
    d["n1"]["x"] = v[0];  d["n1"]["y"] = v[1];  d["n1"]["z"] = v[2];
    d["n2"]["x"] = v[3];  d["n2"]["y"] = v[4];  d["n2"]["z"] = v[5];
    d["n3"]["x"] = v[6];  d["n3"]["y"] = v[7];  d["n3"]["z"] = v[8];
    d["n4"]["x"] = v[9];  d["n4"]["y"] = v[10]; d["n4"]["z"] = v[11];
    pktCount++;
}

// ── POST batch to Railway ─────────────────────────────────────────────────────
static void flushBatch() {
    batch["drone_id"] = DRONE_ID;
    batch["api_key"]  = API_KEY;

    String body;
    serializeJson(batch, body);

    WiFiClientSecure tls;
    tls.setInsecure();  // Railway has valid certs; skipping verification avoids bundle issues

    HTTPClient https;
    https.begin(tls, POST_URL);
    https.addHeader("Content-Type", "application/json");
    https.setTimeout(15000);

    int code = https.POST(body);
    if (code == 200 || code == 204) {
        Serial.printf("POST OK %d | %d pkts | %d B\n", code, pktCount, body.length());
        postOk++;
    } else {
        Serial.printf("POST failed: HTTP %d\n", code);
    }
    https.end();

    batch.clear();
    packets  = batch["packets"].to<JsonArray>();
    pktCount = 0;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    Serial2.begin(MAV_BAUD, SERIAL_8N1, MAV_RX, MAV_TX);
    Serial1.setRxBufferSize(4096);
    Serial1.begin(VIB_BAUD, SERIAL_8N1, VIB_RX, VIB_TX);

    Serial.printf("Connecting to %s", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
    Serial.printf("\nConnected — IP: %s\n", WiFi.localIP().toString().c_str());

    packets   = batch["packets"].to<JsonArray>();
    lastFlush = millis();
    requestStreams();
    Serial.println("Ready");
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
    // Drain MAVLink from flight controller
    mavlink_message_t msg; mavlink_status_t st;
    while (Serial2.available()) {
        if (mavlink_parse_char(MAVLINK_COMM_0, Serial2.read(), &msg, &st)) {
            collectMAV(msg);
            mavCount++;
        }
    }

    // Drain vibration lines from ESP32-C3
    while (Serial1.available()) {
        char c = Serial1.read();
        if (c == '\n') {
            vibLine[vibIdx] = '\0';
            if (vibIdx > 0) collectVibe(vibLine);
            vibIdx = 0;
        } else if (vibIdx < 255) {
            vibLine[vibIdx++] = c;
        }
    }

    uint32_t now = millis();

    if (pktCount > 0 && (now - lastFlush >= BATCH_MS || pktCount >= BATCH_MAX)) {
        flushBatch();
        lastFlush = now;
    }

    if (now - lastStats >= 5000) {
        lastStats = now;
        Serial.printf("[%s] MAVLink: %u | POSTs ok: %u | WiFi: %d dBm\n",
                      DRONE_ID, mavCount, postOk, WiFi.RSSI());
    }

    if (now - lastStream >= 30000) requestStreams();

    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi lost — reconnecting");
        WiFi.reconnect();
        uint32_t t = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) delay(500);
    }
}
