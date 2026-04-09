#define USE_MPU6050_I2C //default
//#define USE_MPU9250_SPI

//#define GYRO_250DPS //default
//#define GYRO_500DPS
#define GYRO_1000DPS
//#define GYRO_2000DPS

//#define ACCEL_2G //default
//#define ACCEL_4G
#define ACCEL_8G
//#define ACCEL_16G

#include <Wire.h>
#include "I2Cdev.h"
#include "MPU6050.h"
#include <math.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define ESPNOW_CHANNEL 1

#define I2C_SDA 8
#define I2C_SCL 9

#define NODE_ID 4   // change if needed

MPU6050 mpu;
int16_t ax, ay, az, gx, gy, gz;

// ---- Your scale factors (same as before) ----
#define ACCEL_SCALE_FACTOR 4096.0f   // for ACCEL_8G
const float ACCEL_FS_G = 8.0f;

// ---- Receiver MAC (NEW C3 RX MAC) ----
uint8_t receiverMac[] = {0x64, 0xE8, 0x33, 0x81, 0x89, 0x00};

// ---- Packet ----
typedef struct __attribute__((packed)) {
  uint8_t  nodeId;
  uint32_t seq;
  float    vibeX_ms2;
  float    vibeY_ms2;
  float    vibeZ_ms2;
  uint32_t clip0;
} VibePacket;

VibePacket pkt;
volatile bool sendReady = true;

// ---- ArduPilot-like vibe math (SAME IMU PART LOGIC) ----
const float DT = 0.01f;                 // 100 Hz schedule
const float TWO_PI_F = 6.28318530718f;
const float G_TO_MS2 = 9.80665f;

const float ALPHA_FLOOR = 1.0f - expf(-TWO_PI_F * 5.0f * DT);
const float ALPHA_VIBE  = 1.0f - expf(-TWO_PI_F * 2.0f * DT);

float floorX = 0.0f, floorY = 0.0f, floorZ = 0.0f;
float vibeSqX = 0.0f, vibeSqY = 0.0f, vibeSqZ = 0.0f;

uint32_t clip0 = 0;
const float CLIP_THRESH_G = 0.98f * ACCEL_FS_G;

uint32_t seqCounter = 0;

// ---- Send timing ----
const unsigned long SAMPLE_PERIOD_US = 10000UL; // 100 Hz
unsigned long nextSendUs = 0;

void onDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  sendReady = true;
}

void setup() {
  Serial.begin(115200);
  delay(1200);

  // IMU init
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);

  mpu.initialize();
  mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_8);
  mpu.setFullScaleGyroRange(MPU6050_GYRO_FS_1000);
  mpu.setDLPFMode(MPU6050_DLPF_BW_42);

  if (!mpu.testConnection()) {
    Serial.println("[TX] MPU6050 failed");
    while (1) delay(1000);
  }

  // WiFi/ESP-NOW init (same pattern that worked for your ping)
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.disconnect();                 // NOT disconnect(true)
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

  Serial.print("[TX] MAC: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("[TX] esp_now_init FAILED");
    while (1) delay(1000);
  }

  esp_now_register_send_cb(onDataSent);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, receiverMac, 6);
  peerInfo.channel = ESPNOW_CHANNEL;
  peerInfo.encrypt = false;
  peerInfo.ifidx = WIFI_IF_STA;

  esp_err_t ap = esp_now_add_peer(&peerInfo);
  Serial.print("[TX] add_peer=");
  Serial.println((int)ap);
  if (ap != ESP_OK) {
    while (1) delay(1000);
  }

  nextSendUs = micros();
  Serial.println("[TX] ready");
}

void loop() {
  unsigned long nowUs = micros();

  if ((long)(nowUs - nextSendUs) >= 0 && sendReady) {
    nextSendUs += SAMPLE_PERIOD_US;
    sendReady = false;

    // Read IMU
    mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

    // Convert accel to g
    float ax_g = (float)ax / ACCEL_SCALE_FACTOR;
    float ay_g = (float)ay / ACCEL_SCALE_FACTOR;
    float az_g = (float)az / ACCEL_SCALE_FACTOR;

    // clip counter
    if (fabsf(ax_g) >= CLIP_THRESH_G || fabsf(ay_g) >= CLIP_THRESH_G || fabsf(az_g) >= CLIP_THRESH_G) {
      clip0++;
    }

    // Convert to m/s^2
    float ax_ms2 = ax_g * G_TO_MS2;
    float ay_ms2 = ay_g * G_TO_MS2;
    float az_ms2 = az_g * G_TO_MS2;

    // floor LPF (~5Hz)
    floorX += ALPHA_FLOOR * (ax_ms2 - floorX);
    floorY += ALPHA_FLOOR * (ay_ms2 - floorY);
    floorZ += ALPHA_FLOOR * (az_ms2 - floorZ);

    // residual
    float dx = ax_ms2 - floorX;
    float dy = ay_ms2 - floorY;
    float dz = az_ms2 - floorZ;

    // energy smoothing (~2Hz), sqrt later
    vibeSqX += ALPHA_VIBE * ((dx * dx) - vibeSqX);
    vibeSqY += ALPHA_VIBE * ((dy * dy) - vibeSqY);
    vibeSqZ += ALPHA_VIBE * ((dz * dz) - vibeSqZ);

    float vibeX = sqrtf(vibeSqX);
    float vibeY = sqrtf(vibeSqY);
    float vibeZ = sqrtf(vibeSqZ);

    pkt.nodeId = NODE_ID;
    pkt.seq = seqCounter++;
    pkt.vibeX_ms2 = vibeX;
    pkt.vibeY_ms2 = vibeY;
    pkt.vibeZ_ms2 = vibeZ;
    pkt.clip0 = clip0;

    esp_err_t r = esp_now_send(receiverMac, (uint8_t*)&pkt, sizeof(pkt));
    if (r != ESP_OK) {
      // if queue failed, release
      sendReady = true;
    }

    // debug 1Hz
    static unsigned long lastDbg = 0;
    if (millis() - lastDbg >= 1000) {
      lastDbg = millis();
      Serial.print("[TX] seq=");
      Serial.print(pkt.seq);
      Serial.print(" send_err=");
      Serial.print((int)r);
      Serial.print(" V(");
      Serial.print(vibeX, 2); Serial.print(",");
      Serial.print(vibeY, 2); Serial.print(",");
      Serial.print(vibeZ, 2); Serial.print(")");
      Serial.print(" clip0=");
      Serial.println(clip0);
    }
  }
}