"""
DronePulse — Health Scoring Engine

Analyzes incoming telemetry to produce per-subsystem health scores (0-100).
Currently uses rule-based heuristics. Designed to be replaced with ML models
once training data is collected.

Subsystems scored:
  - motor:     vibration magnitude & asymmetry across arms
  - battery:   voltage, remaining %, current draw
  - imu:       EKF variance, accelerometer values
  - gps:       fix type, satellite count, HDOP
  - structure: vibration resonance patterns (placeholder)
  - comms:     MAVLink drop rate, message freshness
"""

import time
import math
from collections import defaultdict


class ScoringEngine:
    def __init__(self):
        # Per-drone state: latest values for each telemetry type
        self._state = defaultdict(lambda: defaultdict(dict))
        self._last_update = defaultdict(float)

    def ingest(self, drone_id: str, msg_type: str, data: dict):
        """Store latest telemetry data for scoring."""
        self._state[drone_id][msg_type] = data
        self._last_update[drone_id] = time.time()

    def get_drone_ids(self):
        """Return drone IDs that have been seen recently (last 30s)."""
        cutoff = time.time() - 30
        return [d for d, t in self._last_update.items() if t > cutoff]

    def compute_scores(self, drone_id: str) -> dict:
        """Compute health scores for all subsystems."""
        state = self._state[drone_id]
        return {
            "motor": self._score_motor(state),
            "battery": self._score_battery(state),
            "imu": self._score_imu(state),
            "gps": self._score_gps(state),
            "structure": self._score_structure(state),
            "comms": self._score_comms(state, drone_id),
        }

    # ---- Motor / Propeller Health ----

    def _score_motor(self, state: dict) -> float:
        vibe = state.get("VIBE_NODES")
        if not vibe:
            return 100.0  # no data = assume OK

        magnitudes = []
        for key in ["n1", "n2", "n3", "n4"]:
            node = vibe.get(key, {})
            x = node.get("x", 0)
            y = node.get("y", 0)
            z = node.get("z", 0)
            mag = math.sqrt(x*x + y*y + z*z)
            magnitudes.append(mag)

        if not magnitudes:
            return 100.0

        avg_mag = sum(magnitudes) / len(magnitudes)
        max_mag = max(magnitudes)

        # Asymmetry: how different are the arms from each other
        if avg_mag > 0.1:
            asymmetry = (max_mag - min(magnitudes)) / avg_mag
        else:
            asymmetry = 0

        score = 100.0

        # Penalize high vibration magnitude
        # Normal: ~9.8 (gravity). Concerning: >15 m/s². Bad: >25 m/s²
        excess = max(avg_mag - 12, 0)
        score -= min(excess * 3, 40)

        # Penalize asymmetry between arms
        # >0.3 asymmetry is concerning, >0.6 is bad
        if asymmetry > 0.2:
            score -= min((asymmetry - 0.2) * 50, 30)

        # Penalize any single arm spiking
        if max_mag > 25:
            score -= min((max_mag - 25) * 2, 30)

        return max(0, min(100, score))

    # ---- Battery Health ----

    def _score_battery(self, state: dict) -> float:
        sys = state.get("SYS_STATUS")
        if not sys:
            return 100.0

        score = 100.0

        # Battery remaining percentage
        remaining = sys.get("battery_remaining", -1)
        if 0 <= remaining <= 100:
            if remaining < 20:
                score -= (20 - remaining) * 3  # harsh below 20%
            elif remaining < 40:
                score -= (40 - remaining) * 0.5

        # Voltage (in millivolts for a typical 4S LiPo: 16800 full, 14000 low)
        voltage_mv = sys.get("voltage_battery", 0)
        if voltage_mv > 0:
            voltage = voltage_mv / 1000.0
            if voltage < 14.0:
                score -= min((14.0 - voltage) * 20, 40)
            elif voltage < 14.8:
                score -= (14.8 - voltage) * 10

        return max(0, min(100, score))

    # ---- IMU / EKF Health ----

    def _score_imu(self, state: dict) -> float:
        ekf = state.get("EKF_STATUS_REPORT")
        score = 100.0

        if ekf:
            # EKF variances — lower is better
            vel_var = ekf.get("velocity_variance", 0)
            pos_h_var = ekf.get("pos_horiz_variance", 0)
            pos_v_var = ekf.get("pos_vert_variance", 0)
            comp_var = ekf.get("compass_variance", 0)

            # Penalize high variance
            for var_val, weight in [(vel_var, 30), (pos_h_var, 20), (pos_v_var, 15), (comp_var, 15)]:
                if var_val > 0.5:
                    score -= min((var_val - 0.5) * weight, weight)

        imu = state.get("SCALED_IMU")
        if imu:
            # Check for accelerometer bias (should be near 0,0,-1g when level)
            zacc = imu.get("zacc", -1.0)
            if abs(zacc + 1.0) > 0.3:  # z should be ~-1g
                score -= min(abs(zacc + 1.0) * 10, 20)

        return max(0, min(100, score))

    # ---- GPS / Navigation Health ----

    def _score_gps(self, state: dict) -> float:
        gps = state.get("GPS_RAW_INT")
        if not gps:
            return 100.0

        score = 100.0

        fix_type = gps.get("fix_type", 0)
        sats = gps.get("satellites_visible", 0)
        eph = gps.get("eph", 9999)

        # Fix type scoring
        fix_penalties = {0: 60, 1: 50, 2: 30, 3: 0, 4: 0, 5: 0, 6: 0}
        score -= fix_penalties.get(fix_type, 40)

        # Satellite count
        if sats < 6:
            score -= (6 - sats) * 8
        elif sats < 10:
            score -= (10 - sats) * 2

        # HDOP (eph in centimeters)
        hdop = eph / 100.0
        if hdop > 3.0:
            score -= min((hdop - 3.0) * 5, 20)

        return max(0, min(100, score))

    # ---- Structural Health ----

    def _score_structure(self, state: dict) -> float:
        # Placeholder — will use frequency-domain vibration analysis
        # For now, mirrors motor score with different thresholds
        vibe = state.get("VIBE_NODES")
        if not vibe:
            return 100.0

        score = 100.0
        for key in ["n1", "n2", "n3", "n4"]:
            node = vibe.get(key, {})
            mag = math.sqrt(
                node.get("x", 0)**2 +
                node.get("y", 0)**2 +
                node.get("z", 0)**2
            )
            # Structural concern at higher thresholds than motor
            if mag > 30:
                score -= min((mag - 30) * 3, 25)

        return max(0, min(100, score))

    # ---- Communication Health ----

    def _score_comms(self, state: dict, drone_id: str) -> float:
        score = 100.0

        sys = state.get("SYS_STATUS")
        if sys:
            drop_rate = sys.get("drop_rate_comm", 0)
            # drop_rate is in percent * 100 (so 100 = 1%)
            pct = drop_rate / 100.0
            if pct > 1:
                score -= min(pct * 5, 40)

        rc = state.get("RC_CHANNELS_RAW")
        if rc:
            rssi = rc.get("rssi", 255)
            if rssi < 255:  # 255 = unknown
                if rssi < 50:
                    score -= min((50 - rssi) * 1.5, 30)
                elif rssi < 100:
                    score -= (100 - rssi) * 0.3

        # Staleness penalty
        last = self._last_update.get(drone_id, 0)
        age = time.time() - last
        if age > 5:
            score -= min((age - 5) * 5, 30)

        return max(0, min(100, score))
