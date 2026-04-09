"""
DronePulse — Alert Engine

Generates warnings and critical alerts when health scores cross thresholds.
Includes cooldown to avoid alert spam.
"""

import time


# Thresholds: (warning_threshold, critical_threshold)
THRESHOLDS = {
    "motor":     (60, 30),
    "battery":   (50, 25),
    "imu":       (55, 30),
    "gps":       (50, 25),
    "structure": (55, 30),
    "comms":     (60, 35),
}

SUBSYSTEM_LABELS = {
    "motor":     "Motor/Propeller",
    "battery":   "Battery",
    "imu":       "IMU/EKF",
    "gps":       "GPS/Navigation",
    "structure": "Structure",
    "comms":     "Communications",
}

# Minimum seconds between repeated alerts of the same type
COOLDOWN = 30


class AlertEngine:
    def __init__(self):
        # {drone_id: {subsystem: {severity: last_alert_time}}}
        self._last_alert = {}

    def check(self, drone_id: str, scores: dict) -> list[dict]:
        """Check scores against thresholds. Returns list of alert dicts."""
        alerts = []
        now = time.time()

        if drone_id not in self._last_alert:
            self._last_alert[drone_id] = {}

        for subsystem, score in scores.items():
            if subsystem not in THRESHOLDS:
                continue

            warn_thresh, crit_thresh = THRESHOLDS[subsystem]
            label = SUBSYSTEM_LABELS.get(subsystem, subsystem)

            severity = None
            if score <= crit_thresh:
                severity = "critical"
            elif score <= warn_thresh:
                severity = "warning"

            if severity is None:
                continue

            # Check cooldown
            drone_alerts = self._last_alert[drone_id]
            if subsystem not in drone_alerts:
                drone_alerts[subsystem] = {}

            last_time = drone_alerts[subsystem].get(severity, 0)
            if now - last_time < COOLDOWN:
                continue

            drone_alerts[subsystem][severity] = now

            alerts.append({
                "subsystem": subsystem,
                "severity": severity,
                "score": round(score, 1),
                "message": f"{label} health {severity}: score {round(score)}/100",
            })

        return alerts
