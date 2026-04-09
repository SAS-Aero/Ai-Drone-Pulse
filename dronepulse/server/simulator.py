"""
DronePulse — Drone Telemetry Simulator

Sends realistic fake telemetry to the gateway over WebSocket.
Simulates a quadcopter flight with physically accurate degradation scenarios
where subsystem failures cascade into other systems.

Usage:
    python simulator.py                    # normal flight
    python simulator.py --scenario motor   # motor 3 bearing failure
    python simulator.py --scenario battery # battery cell failure + brownout
    python simulator.py --scenario gps     # GPS jamming / signal loss
    python simulator.py --scenario chaos   # cascading multi-system failure
"""

import asyncio
import json
import math
import random
import argparse
import time

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets


# ======================= Config =======================

WS_URL = "ws://localhost:8080/drone/ws?drone_id=DR-001&api_key=dev-secret"

# ======================= Flight State =======================

class DroneState:
    def __init__(self):
        self.t = 0.0
        self.lat = 18.5204
        self.lon = 73.8567
        self.alt = 0.0
        self.heading = 0.0
        self.groundspeed = 0.0
        self.airspeed = 0.0
        self.climb_rate = 0.0
        self.throttle = 0
        self.roll = 0.0
        self.pitch = 0.0
        self.yaw = 0.0
        self.battery_v = 16.8  # 4S fully charged (4 x 4.2V)
        self.battery_pct = 100
        self.battery_current = 0  # in centi-amps
        self.satellites = 12
        self.fix_type = 3
        self.eph = 120
        self.flight_mode = 0  # stabilize
        self.system_status = 3  # standby
        self.drop_rate = 0
        self.rssi = 200
        self.vibe = [[0, 0, 9.81] for _ in range(4)]
        self.ekf_vel_var = 0.1
        self.ekf_pos_h_var = 0.1
        self.ekf_pos_v_var = 0.1
        self.ekf_compass_var = 0.05
        self.vcc = 5000  # 5V rail in mV

        # Internal physics
        self.vertical_vel = 0.0           # m/s
        self.motor_thrust = [1.0] * 4     # 0..1 per motor (1 = full health)
        self.target_alt = 0.0
        self.phase = "idle"
        self.phase_start = 0.0
        self.crashed = False
        self.emergency_landing = False

    def advance(self, dt, scenario=None):
        if self.crashed:
            return

        self.t += dt

        # ---- Phase transitions (normal flight plan) ----
        if self.phase == "idle" and self.t > 3 and not self.emergency_landing:
            self.phase = "takeoff"
            self.phase_start = self.t
            self.system_status = 4
            self.flight_mode = 4  # guided
            self.target_alt = 30.0

        elif self.phase == "takeoff" and self.alt >= self.target_alt - 1:
            self.phase = "cruise"
            self.phase_start = self.t

        elif self.phase == "cruise" and self.t - self.phase_start > 30:
            self.phase = "orbit"
            self.phase_start = self.t

        elif self.phase == "orbit" and self.t - self.phase_start > 40:
            self.phase = "land"
            self.phase_start = self.t

        elif self.phase == "land" and self.alt <= 0.2:
            self._touch_down()

        # ---- Compute effective thrust ----
        avg_thrust = sum(self.motor_thrust) / 4.0

        # ---- Apply scenario effects FIRST (modifies motor_thrust, battery, etc) ----
        if scenario:
            self._apply_scenario(scenario, dt)

        # Recompute after scenario changes
        avg_thrust = sum(self.motor_thrust) / 4.0

        # ---- Battery physics ----
        # Current draw depends on throttle and motor health
        if self.throttle > 0:
            base_current = self.throttle * 4  # base draw in centi-amps
            # Damaged motors draw more current (working harder)
            inefficiency = sum(max(0, 1.0 - t) for t in self.motor_thrust)
            self.battery_current = int(base_current * (1.0 + inefficiency * 0.3))
        else:
            self.battery_current = 50  # idle draw

        # Normal drain based on current
        drain = (self.battery_current / 10000.0) * dt  # rough pct drain
        self.battery_pct = max(0, self.battery_pct - drain)

        # Voltage from SoC + voltage sag under load
        base_voltage = 14.0 + (self.battery_pct / 100.0) * 2.8
        load_sag = (self.battery_current / 40000.0) * (1.0 + max(0, 1.0 - self.battery_pct / 20.0))
        self.battery_v = max(10.0, base_voltage - load_sag)

        # ---- Low battery effects ----
        if self.battery_pct <= 0:
            # Dead battery — total power loss
            self.motor_thrust = [0.0] * 4
            self.throttle = 0
            self.system_status = 6  # emergency
            self.vcc = max(3000, self.vcc - 200 * dt)
        elif self.battery_v < 12.8:
            # Critical voltage — brownout, motors losing power
            brownout = max(0.0, (12.8 - self.battery_v) / 2.8)
            for i in range(4):
                self.motor_thrust[i] *= (1.0 - brownout * 0.8)
            self.system_status = 5  # critical
            self.vcc = max(4200, 5000 - int(brownout * 800))
            if not self.emergency_landing and self.alt > 0:
                self.emergency_landing = True
                self.flight_mode = 9  # LAND
                self.phase = "emergency_descent"
        elif self.battery_pct < 20:
            # Low battery warning — auto RTL
            if self.flight_mode != 9 and self.flight_mode != 6:
                self.flight_mode = 6  # RTL
                self.system_status = 4
        else:
            self.vcc = 5000 + random.randint(-30, 30)

        # ---- Flight physics ----
        if self.phase == "takeoff":
            desired_climb = 3.0
            self.throttle = int(min(80, 50 + (self.target_alt - self.alt) * 2))
            self.vertical_vel = desired_climb * avg_thrust
            self.groundspeed = 0.5
            self.pitch = -0.05
            self.roll = 0.0

        elif self.phase == "cruise":
            self.throttle = int(55 / max(0.3, avg_thrust))  # compensate for thrust loss
            self.throttle = min(95, self.throttle)
            self.groundspeed = 5.0 * avg_thrust + random.gauss(0, 0.2)
            self.heading = (self.heading + 0.5 * dt) % 360
            self.roll = 0.05 * math.sin(self.t * 0.5)
            self.pitch = -0.03 + 0.02 * math.sin(self.t * 0.7)
            # Altitude hold — harder with damaged motors
            alt_error = 25.0 - self.alt
            self.vertical_vel = alt_error * 0.5 * avg_thrust

        elif self.phase == "orbit":
            self.throttle = int(50 / max(0.3, avg_thrust))
            self.throttle = min(95, self.throttle)
            self.groundspeed = 3.0 * avg_thrust
            self.heading = (self.heading + 3.0 * dt) % 360
            self.roll = 0.15
            self.pitch = -0.02
            alt_error = 25.0 - self.alt
            self.vertical_vel = alt_error * 0.5 * avg_thrust

        elif self.phase == "land":
            self.vertical_vel = -2.0
            self.throttle = max(25, int(25 + self.alt * avg_thrust))
            self.groundspeed = max(0, self.groundspeed - 0.5 * dt)

        elif self.phase == "emergency_descent":
            # Controlled descent — faster if motors are failing
            descent_rate = 1.5 + (1.0 - avg_thrust) * 4.0
            self.vertical_vel = -descent_rate
            self.throttle = max(0, int(40 * avg_thrust))
            self.groundspeed = max(0, self.groundspeed - 0.3 * dt)
            if self.alt <= 0.2:
                self._touch_down()

        elif self.phase == "idle":
            self.vertical_vel = 0
            self.groundspeed = 0

        # Free-fall if no thrust at altitude
        if avg_thrust < 0.05 and self.alt > 0:
            self.vertical_vel -= 9.81 * dt  # gravity
            self.system_status = 6  # emergency
            self.throttle = 0
            # Tumbling — erratic attitude
            self.roll += random.gauss(0, 0.5) * dt * 10
            self.pitch += random.gauss(0, 0.5) * dt * 10

        # Update altitude
        self.alt += self.vertical_vel * dt
        self.climb_rate = self.vertical_vel

        # Ground collision
        if self.alt <= 0 and self.vertical_vel < -3.0:
            self._crash()
            return
        self.alt = max(0, self.alt)

        # Position update
        if self.groundspeed > 0.1:
            rad = math.radians(self.heading)
            self.lat += math.cos(rad) * self.groundspeed * dt / 111000
            self.lon += math.sin(rad) * self.groundspeed * dt / (111000 * math.cos(math.radians(self.lat)))

        self.yaw = math.radians(self.heading)
        self.airspeed = self.groundspeed + random.gauss(0, 0.2)

        # ---- Thrust asymmetry → attitude effects ----
        t = self.motor_thrust
        # Roll: right (1,4) vs left (2,3) thrust imbalance
        roll_imbalance = ((t[0] + t[3]) - (t[1] + t[2])) / 4.0
        self.roll += roll_imbalance * 0.3

        # Pitch: front (1,2) vs rear (3,4) thrust imbalance
        pitch_imbalance = ((t[0] + t[1]) - (t[2] + t[3])) / 4.0
        self.pitch += pitch_imbalance * 0.3

        # Yaw: CW (1,3) vs CCW (2,4) torque imbalance
        yaw_imbalance = ((t[0] + t[2]) - (t[1] + t[3])) / 4.0
        self.heading += yaw_imbalance * 2.0 * dt

        # ---- Normal vibration ----
        for i in range(4):
            thrust_vibe = (1.0 - self.motor_thrust[i]) * 3.0  # damaged motor vibrates more
            base_vibe = 0.3 + thrust_vibe
            self.vibe[i] = [
                random.gauss(0, base_vibe),
                random.gauss(0, base_vibe),
                9.81 + random.gauss(0, 0.2 + thrust_vibe * 0.5),
            ]
            # Throttle increases base vibration
            if self.throttle > 0:
                throttle_factor = self.throttle / 100.0
                self.vibe[i][0] += random.gauss(0, throttle_factor * 0.5)
                self.vibe[i][1] += random.gauss(0, throttle_factor * 0.5)
                self.vibe[i][2] += random.gauss(0, throttle_factor * 0.3)

        # ---- GPS normal jitter ----
        self.eph = 120 + random.randint(-20, 20)
        self.satellites = 12 + random.randint(-2, 2)
        self.fix_type = 3

        # ---- EKF variances (baseline) ----
        self.ekf_vel_var = 0.1 + random.gauss(0, 0.02)
        self.ekf_pos_h_var = 0.1 + random.gauss(0, 0.02)
        self.ekf_pos_v_var = 0.05 + random.gauss(0, 0.01)
        self.ekf_compass_var = 0.05 + random.gauss(0, 0.01)

        # EKF degrades with attitude instability
        att_error = abs(self.roll) + abs(self.pitch)
        if att_error > 0.3:
            self.ekf_vel_var += att_error * 0.5
            self.ekf_pos_h_var += att_error * 0.3

        # ---- Comms baseline ----
        self.drop_rate = random.randint(0, 10)
        self.rssi = 200 + random.randint(-10, 10)

        # Apply scenario-specific effects after physics
        if scenario:
            self._apply_scenario_post(scenario)

    def _touch_down(self):
        self.alt = 0
        self.vertical_vel = 0
        self.groundspeed = 0
        self.throttle = 0
        self.system_status = 3  # standby
        self.phase = "idle"
        self.phase_start = self.t
        if self.emergency_landing:
            self.system_status = 5  # remains critical after emergency landing

    def _crash(self):
        self.crashed = True
        self.alt = 0
        self.vertical_vel = 0
        self.groundspeed = 0
        self.throttle = 0
        self.system_status = 6  # emergency
        self.motor_thrust = [0] * 4
        # Impact vibration spike
        for i in range(4):
            self.vibe[i] = [random.gauss(0, 30), random.gauss(0, 30), random.gauss(0, 30)]
        print("\n  [!] CRASH — impact detected")

    def _apply_scenario(self, scenario, dt):
        """Pre-physics scenario effects (modify motor thrust, battery, etc)."""
        progress = min(self.t / 90, 1.0)  # ramp over 90 seconds

        if scenario == "motor":
            self._scenario_motor(progress, dt)
        elif scenario == "battery":
            self._scenario_battery(progress, dt)
        elif scenario == "gps":
            self._scenario_gps(progress, dt)
        elif scenario == "chaos":
            self._scenario_chaos(progress, dt)

    def _apply_scenario_post(self, scenario):
        """Post-physics effects (vibration overlays, etc)."""
        progress = min(self.t / 90, 1.0)

        if scenario == "motor":
            self._scenario_motor_vibe(progress)
        elif scenario == "chaos":
            self._scenario_motor_vibe(progress * 0.7)

    # ---- MOTOR FAILURE ----
    # Bearing wear on motor 3 → vibration increases → thrust degrades
    # → quad tilts → FC compensates with more throttle → other motors work harder
    # → altitude oscillations → eventually can't hold altitude → emergency land
    def _scenario_motor(self, progress, dt):
        # Motor 3 thrust degrades over time
        # Phase 1 (0-30%): slight bearing noise, thrust still OK
        # Phase 2 (30-60%): noticeable vibration, thrust dropping
        # Phase 3 (60-80%): severe vibration, major thrust loss, compensating
        # Phase 4 (80-100%): motor seizure, near-zero thrust, emergency
        if progress < 0.3:
            self.motor_thrust[2] = 1.0 - progress * 0.3  # slight degradation
        elif progress < 0.6:
            self.motor_thrust[2] = 0.91 - (progress - 0.3) * 1.5  # dropping faster
        elif progress < 0.8:
            self.motor_thrust[2] = 0.46 - (progress - 0.6) * 1.5  # severe
        else:
            self.motor_thrust[2] = max(0.05, 0.16 - (progress - 0.8) * 0.8)  # seizure

        # Adjacent motors compensate (FC tries to level)
        compensation = (1.0 - self.motor_thrust[2]) * 0.15
        self.motor_thrust[1] = min(1.0, 1.0 + compensation)  # motor 2 works harder
        self.motor_thrust[3] = min(1.0, 1.0 + compensation)  # motor 4 works harder

    def _scenario_motor_vibe(self, progress):
        # Motor 3 specific vibration signature
        if progress < 0.1:
            return
        severity = progress * 22
        # Bearing wear creates characteristic high-vibration pattern
        self.vibe[2][0] += severity * 0.4 + random.gauss(0, severity * 0.1)
        self.vibe[2][1] += severity * 0.3 + random.gauss(0, severity * 0.1)
        self.vibe[2][2] += severity * 0.6 + random.gauss(0, severity * 0.15)

        # Vibration bleeds into adjacent arms through frame
        frame_coupling = severity * 0.08
        self.vibe[1][0] += random.gauss(0, frame_coupling)
        self.vibe[1][2] += random.gauss(0, frame_coupling * 0.5)
        self.vibe[3][0] += random.gauss(0, frame_coupling)
        self.vibe[3][2] += random.gauss(0, frame_coupling * 0.5)

    # ---- BATTERY FAILURE ----
    # Cell imbalance → accelerated drain → voltage sag → brownout
    # → motors lose power → altitude drops → FC tries to compensate
    # → draws even more current → thermal runaway → emergency landing
    def _scenario_battery(self, progress, dt):
        # Accelerated drain simulating a weak cell
        extra_drain = progress * 2.5 * dt
        self.battery_pct = max(0, self.battery_pct - extra_drain)

        # Cell imbalance causes voltage to drop faster than SoC suggests
        if progress > 0.3:
            cell_imbalance = (progress - 0.3) * 2.0
            self.battery_v -= cell_imbalance

        # High current draw makes it worse (positive feedback loop)
        if self.throttle > 50 and progress > 0.4:
            extra_sag = (progress - 0.4) * 1.5 * (self.throttle / 100.0)
            self.battery_v -= extra_sag

        # Puffing battery increases internal resistance → all motors get less power
        if progress > 0.6:
            power_loss = (progress - 0.6) * 0.5
            for i in range(4):
                self.motor_thrust[i] = max(0.0, self.motor_thrust[i] - power_loss)

        # Vcc rail sags too → avionics brownout
        if self.battery_v < 13.5:
            self.vcc = max(3500, int(5000 - (13.5 - self.battery_v) * 600))
            # Brownout causes comm drops
            self.drop_rate = int((13.5 - self.battery_v) * 100)

    # ---- GPS FAILURE ----
    # Interference/jamming → satellites drop → HDOP spikes → position drifts
    # → EKF struggles → FC switches to non-GPS mode → position hold fails
    # → drone drifts → altitude becomes unreliable → dangerous situation
    def _scenario_gps(self, progress, dt):
        # Satellites drop progressively
        self.satellites = max(0, int(12 - progress * 13))

        # HDOP degrades
        self.eph = int(120 + progress * 1500)

        # Fix type degrades
        if progress > 0.3:
            self.fix_type = 2  # 2D only
        if progress > 0.5:
            self.fix_type = 1  # no fix
        if progress > 0.7:
            self.fix_type = 0  # no GPS at all

        # Position starts drifting (GPS noise increases)
        if progress > 0.2:
            drift = (progress - 0.2) * 0.0003
            self.lat += random.gauss(0, drift)
            self.lon += random.gauss(0, drift)

        # EKF goes haywire without GPS
        if progress > 0.3:
            gps_loss = (progress - 0.3) * 2.0
            self.ekf_vel_var += gps_loss * 0.8
            self.ekf_pos_h_var += gps_loss * 1.5
            self.ekf_pos_v_var += gps_loss * 0.5

        # FC switches to ALT_HOLD when GPS is unreliable
        if progress > 0.4 and self.flight_mode == 4:
            self.flight_mode = 2  # ALT_HOLD

        # Altitude becomes unreliable without GPS vertical
        if progress > 0.5:
            alt_drift = (progress - 0.5) * 3.0
            self.alt += random.gauss(0, alt_drift * dt)

        # Without position hold, drone drifts with wind
        if progress > 0.4:
            wind_drift = (progress - 0.4) * 2.0
            self.lat += random.gauss(0, wind_drift * dt / 111000)
            self.lon += random.gauss(0, wind_drift * dt / 111000)
            self.heading += random.gauss(0, wind_drift * 0.5) * dt

        # RSSI degrades (interference affects radio too)
        if progress > 0.5:
            self.rssi = max(30, int(200 - (progress - 0.5) * 300))
            self.drop_rate = int((progress - 0.5) * 200)

    # ---- CHAOS (cascading multi-system failure) ----
    # Motor 3 starts failing → increased current draw → battery drains faster
    # → voltage drops → GPS module browns out → EKF fails → FC panics
    # → all systems degrade in a realistic cascade
    def _scenario_chaos(self, progress, dt):
        # Stage 1 (0-25%): Motor 3 bearing wear begins
        if progress > 0.0:
            motor_p = min(progress / 0.6, 1.0)
            self._scenario_motor(motor_p, dt)

        # Stage 2 (20-50%): Increased power draw drains battery faster
        if progress > 0.2:
            bat_p = min((progress - 0.2) / 0.6, 1.0)
            extra_drain = bat_p * 1.5 * dt
            self.battery_pct = max(0, self.battery_pct - extra_drain)
            if bat_p > 0.3:
                self.battery_v -= bat_p * 0.8

        # Stage 3 (35-65%): Vibration shakes GPS antenna → signal degrades
        if progress > 0.35:
            gps_p = min((progress - 0.35) / 0.4, 1.0)
            self.satellites = max(3, int(12 - gps_p * 8))
            self.eph = int(120 + gps_p * 600)
            if gps_p > 0.5:
                self.fix_type = 2
            if gps_p > 0.8:
                self.fix_type = 1

        # Stage 4 (50-80%): EKF struggling with bad sensors
        if progress > 0.5:
            ekf_p = (progress - 0.5) / 0.3
            self.ekf_vel_var += ekf_p * 2.0
            self.ekf_pos_h_var += ekf_p * 1.5
            self.ekf_compass_var += ekf_p * 0.8

        # Stage 5 (60%+): Comms degrade under electrical noise
        if progress > 0.6:
            comms_p = (progress - 0.6) / 0.4
            self.rssi = max(15, int(200 - comms_p * 200))
            self.drop_rate = int(comms_p * 800)

        # Stage 6 (75%+): Power rail unstable
        if progress > 0.75:
            rail_p = (progress - 0.75) / 0.25
            self.vcc = max(3200, int(5000 - rail_p * 1500))
            # Random motor glitches from bad power
            if random.random() < rail_p * 0.3:
                victim = random.randint(0, 3)
                self.motor_thrust[victim] *= 0.7


# ======================= Packet Generators =======================

def make_packet(msg_type, data):
    return json.dumps({
        "timestamp": str(int(time.time() * 1000)),
        "type": msg_type,
        "data": data,
    })

def heartbeat(s):
    return make_packet("HEARTBEAT", {
        "type": 2,
        "autopilot": 3,
        "base_mode": 217 if s.system_status == 4 else 81,
        "custom_mode": s.flight_mode,
        "system_status": s.system_status,
    })

def sys_status(s):
    return make_packet("SYS_STATUS", {
        "voltage_battery": int(s.battery_v * 1000),
        "current_battery": s.battery_current,
        "battery_remaining": int(max(0, s.battery_pct)),
        "drop_rate_comm": s.drop_rate,
    })

def gps_raw(s):
    return make_packet("GPS_RAW_INT", {
        "lat": s.lat,
        "lon": s.lon,
        "alt": s.alt,
        "fix_type": s.fix_type,
        "satellites_visible": max(0, s.satellites),
        "eph": max(0, s.eph),
    })

def attitude(s):
    # Add noise proportional to vibration
    avg_vibe = sum(abs(s.vibe[i][0]) + abs(s.vibe[i][1]) for i in range(4)) / 8.0
    noise = min(avg_vibe * 0.01, 0.1)
    return make_packet("ATTITUDE", {
        "roll": s.roll + random.gauss(0, 0.005 + noise),
        "pitch": s.pitch + random.gauss(0, 0.005 + noise),
        "yaw": s.yaw,
        "rollspeed": random.gauss(0, 0.01 + noise * 2),
        "pitchspeed": random.gauss(0, 0.01 + noise * 2),
        "yawspeed": random.gauss(0, 0.005 + noise),
    })

def global_position(s):
    return make_packet("GLOBAL_POSITION_INT", {
        "lat": s.lat,
        "lon": s.lon,
        "alt": s.alt,
        "relative_alt": s.alt,
        "vx": s.groundspeed * math.cos(s.yaw),
        "vy": s.groundspeed * math.sin(s.yaw),
        "vz": s.climb_rate,
        "hdg": s.heading,
    })

def vfr_hud(s):
    return make_packet("VFR_HUD", {
        "airspeed": max(0, s.airspeed),
        "groundspeed": max(0, s.groundspeed),
        "alt": max(0, s.alt),
        "climb": s.climb_rate,
        "heading": int(s.heading) % 360,
        "throttle": max(0, min(100, s.throttle)),
    })

def scaled_imu(s):
    # IMU readings affected by vibration
    vibe_noise = sum(abs(s.vibe[i][0]) for i in range(4)) / 40.0
    return make_packet("SCALED_IMU", {
        "xacc": random.gauss(0, 0.02 + vibe_noise),
        "yacc": random.gauss(0, 0.02 + vibe_noise),
        "zacc": -1.0 + random.gauss(0, 0.01 + vibe_noise * 0.5),
        "xgyro": random.gauss(0, 0.005 + vibe_noise * 0.3),
        "ygyro": random.gauss(0, 0.005 + vibe_noise * 0.3),
        "zgyro": random.gauss(0, 0.003 + vibe_noise * 0.2),
    })

def rc_channels(s):
    return make_packet("RC_CHANNELS_RAW", {
        "chan1_raw": 1500 + int(s.roll * 500) + random.randint(-3, 3),
        "chan2_raw": 1500 + int(s.pitch * 500) + random.randint(-3, 3),
        "chan3_raw": 1000 + s.throttle * 10,
        "chan4_raw": 1500 + random.randint(-5, 5),
        "rssi": max(0, min(255, s.rssi)),
    })

def power_status(s):
    return make_packet("POWER_STATUS", {
        "Vcc": max(0, s.vcc),
        "Vservo": 0,
        "flags": 0 if s.vcc > 4500 else 1,  # flag power issue
    })

def ekf_status(s):
    return make_packet("EKF_STATUS_REPORT", {
        "flags": 511 if s.ekf_vel_var < 1.0 else 0,
        "velocity_variance": max(0, s.ekf_vel_var),
        "pos_horiz_variance": max(0, s.ekf_pos_h_var),
        "pos_vert_variance": max(0, s.ekf_pos_v_var),
        "compass_variance": max(0, s.ekf_compass_var),
        "terrain_alt_variance": 0.0,
    })

def vibe_nodes(s):
    return make_packet("VIBE_NODES", {
        "n1": {"x": s.vibe[0][0], "y": s.vibe[0][1], "z": s.vibe[0][2]},
        "n2": {"x": s.vibe[1][0], "y": s.vibe[1][1], "z": s.vibe[1][2]},
        "n3": {"x": s.vibe[2][0], "y": s.vibe[2][1], "z": s.vibe[2][2]},
        "n4": {"x": s.vibe[3][0], "y": s.vibe[3][1], "z": s.vibe[3][2]},
    })


# ======================= Main Loop =======================

SCHEDULE = [
    (heartbeat,        2.0),
    (sys_status,       1.0),
    (gps_raw,          0.5),
    (attitude,         0.2),
    (global_position,  0.5),
    (vfr_hud,          0.5),
    (scaled_imu,       1.0),
    (rc_channels,      1.0),
    (power_status,     2.0),
    (ekf_status,       2.0),
    (vibe_nodes,       0.1),
]


async def simulate(scenario):
    state = DroneState()
    dt = 0.05

    label = f" [{scenario}]" if scenario else ""
    print(f"[Simulator] Connecting to {WS_URL}")
    print(f"[Simulator] Scenario:{label or ' normal flight'}")
    print()

    if scenario == "motor":
        print("  Motor 3 bearing wear simulation:")
        print("    0-25s:  slight roughness, barely noticeable")
        print("    25-55s: vibration increasing, FC compensating")
        print("    55-70s: severe vibration, altitude unstable")
        print("    70-90s: motor seizure, emergency landing")
    elif scenario == "battery":
        print("  Battery cell failure simulation:")
        print("    0-25s:  weak cell draining faster than normal")
        print("    25-50s: voltage sagging under load")
        print("    50-70s: brownout, motors losing power, altitude dropping")
        print("    70-90s: power loss, emergency descent")
    elif scenario == "gps":
        print("  GPS jamming simulation:")
        print("    0-25s:  satellites dropping, HDOP rising")
        print("    25-45s: fix degrades to 2D, position drifting")
        print("    45-65s: no fix, FC switches to ALT_HOLD, drone drifts")
        print("    65-90s: total GPS loss, EKF failing, RSSI dropping")
    elif scenario == "chaos":
        print("  Cascading failure simulation:")
        print("    0-20s:  motor 3 bearing wear begins")
        print("    20-35s: increased power draw, battery draining faster")
        print("    35-55s: vibration shakes GPS antenna loose")
        print("    55-70s: EKF struggling, comms degrading")
        print("    70-90s: power rail unstable, random motor glitches")

    print()

    async with websockets.connect(WS_URL) as ws:
        print("[Simulator] Connected! Streaming telemetry...")
        print("[Simulator] Press Ctrl+C to stop\n")

        last_send = {fn: 0.0 for fn, _ in SCHEDULE}
        msg_count = 0
        last_print = 0

        while True:
            state.advance(dt, scenario)
            now = state.t

            if state.crashed:
                # Send a few more packets showing crash state
                for gen_fn, _ in SCHEDULE:
                    pkt = gen_fn(state)
                    await ws.send(pkt)
                print(f"\n  CRASH at t={now:.0f}s — telemetry stopped")
                await asyncio.sleep(5)
                break

            for gen_fn, interval in SCHEDULE:
                if now - last_send[gen_fn] >= interval:
                    last_send[gen_fn] = now
                    pkt = gen_fn(state)
                    await ws.send(pkt)
                    msg_count += 1

            if now - last_print >= 2.0:
                last_print = now
                avg_thrust = sum(state.motor_thrust) / 4.0
                status_parts = [
                    f"t={now:.0f}s",
                    f"phase={state.phase:<10s}",
                    f"alt={state.alt:5.1f}m",
                    f"bat={state.battery_pct:4.0f}%",
                    f"V={state.battery_v:5.2f}v",
                    f"thr={state.throttle:3d}%",
                    f"thrust={avg_thrust:.2f}",
                    f"sats={max(0,state.satellites):2d}",
                    f"msgs={msg_count}",
                ]
                print("  " + "  ".join(status_parts), end="\r")

            await asyncio.sleep(dt)


def main():
    parser = argparse.ArgumentParser(description="DronePulse Telemetry Simulator")
    parser.add_argument("--scenario", choices=["motor", "battery", "gps", "chaos"],
                        help="Degradation scenario to simulate")
    args = parser.parse_args()

    try:
        asyncio.run(simulate(args.scenario))
    except KeyboardInterrupt:
        print("\n[Simulator] Stopped")
    except Exception as e:
        print(f"[Simulator] Error: {e}")


if __name__ == "__main__":
    main()
