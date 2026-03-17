import math
import time


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def _linear(value, lo, hi, score_lo=0.0, score_hi=100.0):
    """Map value linearly from [lo,hi] to [score_lo,score_hi], clamped."""
    if hi == lo:
        return score_hi if value >= hi else score_lo
    t = _clamp((value - lo) / (hi - lo), 0.0, 1.0)
    return score_lo + t * (score_hi - score_lo)


class ScoringEngine:
    def __init__(self):
        self.state = {}
        self._last_heartbeat = None

    def score(self, packet: dict) -> dict:
        msg_type = packet.get("type", "")
        data = packet.get("data", {})

        # Update rolling state
        self.state[msg_type] = data
        if msg_type == "HEARTBEAT":
            self._last_heartbeat = time.time()

        pwr = self._score_pwr()
        imu = self._score_imu()
        ekf = self._score_ekf()
        gps = self._score_gps()
        ctl = self._score_ctl()
        mot = self._score_mot()
        com = self._score_com()

        composite = round(
            pwr * 0.20
            + imu * 0.15
            + ekf * 0.20
            + gps * 0.15
            + ctl * 0.10
            + mot * 0.10
            + com * 0.10,
            2,
        )

        return {
            "pwr": round(pwr, 2),
            "imu": round(imu, 2),
            "ekf": round(ekf, 2),
            "gps": round(gps, 2),
            "ctl": round(ctl, 2),
            "mot": round(mot, 2),
            "com": round(com, 2),
            "composite": composite,
        }

    # ── Individual scorers ──────────────────────────────────────────────────

    def _score_pwr(self) -> float:
        d = self.state.get("SYS_STATUS")
        if not d:
            return 50.0
        voltage = d.get("voltage_battery", 0)
        remaining = d.get("battery_remaining", 50)
        voltage_score = _linear(voltage, 10500, 11800)
        pwr = voltage_score * 0.4 + _clamp(remaining, 0, 100) * 0.6
        return _clamp(pwr, 0.0, 100.0)

    def _score_imu(self) -> float:
        d = self.state.get("SCALED_IMU")
        if not d:
            return 50.0
        xacc = d.get("xacc", 0)
        yacc = d.get("yacc", 0)
        zacc = d.get("zacc", 0)
        xgyro = d.get("xgyro", 0)
        ygyro = d.get("ygyro", 0)
        zgyro = d.get("zgyro", 0)

        accel_mag = math.sqrt(xacc**2 + yacc**2 + zacc**2)
        if 900 <= accel_mag <= 1100:
            accel_score = 100.0
        elif accel_mag < 500 or accel_mag > 1500:
            accel_score = 0.0
        elif accel_mag < 900:
            accel_score = _linear(accel_mag, 500, 900)
        else:
            accel_score = _linear(accel_mag, 1100, 1500, 100.0, 0.0)

        gyro_mag = math.sqrt(xgyro**2 + ygyro**2 + zgyro**2)
        gyro_score = _linear(gyro_mag, 50, 500, 100.0, 0.0)

        return _clamp(accel_score * 0.5 + gyro_score * 0.5, 0.0, 100.0)

    def _score_ekf(self) -> float:
        d = self.state.get("EKF_STATUS_REPORT")
        if not d:
            return 50.0
        flags = d.get("flags", 0)
        if flags >= 0x1F:
            flag_score = 100.0
        elif flags > 0:
            flag_score = 50.0
        else:
            flag_score = 0.0

        variances = [
            d.get("velocity_variance", 0),
            d.get("pos_horiz_variance", 0),
            d.get("pos_vert_variance", 0),
            d.get("compass_variance", 0),
        ]
        avg_var = sum(variances) / len(variances)
        variance_score = _linear(avg_var, 0.1, 1.0, 100.0, 0.0)

        return _clamp(flag_score * 0.6 + variance_score * 0.4, 0.0, 100.0)

    def _score_gps(self) -> float:
        d = self.state.get("GPS_RAW_INT")
        if not d:
            return 50.0
        fix_type = d.get("fix_type", 0)
        sats = d.get("satellites_visible", 0)
        eph = d.get("eph", 9999)

        fix_map = {0: 0, 1: 10, 2: 50, 3: 80, 4: 100}
        fix_score = fix_map.get(fix_type, 100) if fix_type <= 4 else 100

        if sats < 4:
            sat_score = 0.0
        elif sats > 12:
            sat_score = 100.0
        else:
            sat_score = _linear(sats, 4, 12)

        hdop_score = _linear(eph, 150, 500, 100.0, 0.0)

        return _clamp(fix_score * 0.4 + sat_score * 0.3 + hdop_score * 0.3, 0.0, 100.0)

    def _score_ctl(self) -> float:
        d = self.state.get("ATTITUDE")
        if not d:
            return 50.0
        roll = abs(d.get("roll", 0))
        pitch = abs(d.get("pitch", 0))

        roll_score = _linear(roll, 0.1, 0.5, 100.0, 0.0)
        pitch_score = _linear(pitch, 0.1, 0.5, 100.0, 0.0)

        return _clamp(roll_score * 0.5 + pitch_score * 0.5, 0.0, 100.0)

    def _score_mot(self) -> float:
        d = self.state.get("RC_CHANNELS_RAW")
        if not d:
            return 50.0
        channels = [d.get(f"chan{i}_raw", 1500) for i in range(1, 5)]

        range_scores = []
        for ch in channels:
            if 1000 <= ch <= 2000:
                range_scores.append(100.0)
            else:
                range_scores.append(0.0)
        range_score = sum(range_scores) / len(range_scores)

        diff = max(channels) - min(channels)
        balance_score = _linear(diff, 200, 600, 100.0, 0.0)

        return _clamp(range_score * 0.5 + balance_score * 0.5, 0.0, 100.0)

    def _score_com(self) -> float:
        d = self.state.get("SYS_STATUS")
        drop_score = 50.0
        if d:
            drop_rate = d.get("drop_rate_comm", 0)
            drop_score = _linear(drop_rate, 0, 5000, 100.0, 0.0)

        if self._last_heartbeat is not None:
            age = time.time() - self._last_heartbeat
            heartbeat_score = _linear(age, 2.0, 5.0, 100.0, 0.0)
        else:
            heartbeat_score = 50.0

        return _clamp(drop_score * 0.5 + heartbeat_score * 0.5, 0.0, 100.0)
