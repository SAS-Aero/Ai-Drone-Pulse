class AlertEngine:
    def check(self, scores: dict, state: dict) -> list:
        alerts = []
        pwr = scores.get("pwr", 100)
        gps = scores.get("gps", 100)
        ekf = scores.get("ekf", 100)
        imu = scores.get("imu", 100)
        com = scores.get("com", 100)
        composite = scores.get("composite", 100)

        if pwr < 30:
            alerts.append({"level": "critical", "code": "LOW_BATTERY", "message": "Battery critically low"})
        elif pwr < 50:
            alerts.append({"level": "warn", "code": "BATTERY_WARN", "message": "Battery below 50%"})

        if gps < 40:
            alerts.append({"level": "critical", "code": "GPS_POOR", "message": "Poor GPS signal"})

        if ekf < 40:
            alerts.append({"level": "critical", "code": "EKF_UNHEALTHY", "message": "EKF health degraded"})

        if imu < 40:
            alerts.append({"level": "critical", "code": "IMU_FAULT", "message": "IMU readings abnormal"})

        if com < 40:
            alerts.append({"level": "critical", "code": "COMMS_LOST", "message": "Communication link degraded"})

        if composite < 30:
            alerts.append({"level": "critical", "code": "HEALTH_CRITICAL", "message": "Drone health critical"})
        elif composite < 50:
            alerts.append({"level": "warn", "code": "HEALTH_WARN", "message": "Overall drone health low"})

        return alerts
