"""
Tests for PowerHealthEngine — covers all 5 architecture layers.
Run with: python -m pytest test_power_health.py -v
"""

import time
import json
import pytest
from unittest.mock import MagicMock, patch
from power_health import (
    PowerHealthEngine, PowerState, PowerBaseline, SignalHistory,
    PowerFeatures, extract_features,
    score_cell_health, score_pack_health, score_thermal, score_sys_power,
    check_hard_overrides, composite_score,
)


# ─── Fixtures ─────────────────────────────────

def make_redis_mock():
    mock = MagicMock()
    mock.get.return_value = None  # No baseline stored yet
    mock.set.return_value = True
    mock.publish.return_value = 1
    return mock


def make_engine(drone_id="DR-001"):
    r = make_redis_mock()
    engine = PowerHealthEngine(drone_id, r)
    engine.configure_battery(capacity_ah=5.0, rated_wh=111.0)
    return engine


def battery_status_msg(cells_mv: list[int], current_ma: int = 10000,
                       energy_consumed: int = 0, temp_cdeg: int = 2500):
    """Build a BATTERY_STATUS-style dict."""
    padded = cells_mv + [65535] * (10 - len(cells_mv))
    return {
        "type": "BATTERY_STATUS",
        "ts": time.time(),
        "data": {
            "voltages": padded,
            "current_battery": current_ma,    # cA
            "energy_consumed": energy_consumed,
            "temperature": temp_cdeg,          # cdegC (2500 = 25°C)
            "fault_bitmask": 0,
        }
    }


def sys_status_msg(voltage_mv: int = 24000, current_ca: int = 1000,
                   battery_pct: int = 80):
    return {
        "type": "SYS_STATUS",
        "ts": time.time(),
        "data": {
            "voltage_battery": voltage_mv,
            "current_battery": current_ca,
            "battery_remaining": battery_pct,
        }
    }


def power_status_msg(vcc_mv: int = 5000, vservo_mv: int = 5000, flags: int = 0):
    return {
        "type": "POWER_STATUS",
        "ts": time.time(),
        "data": {"Vcc": vcc_mv, "VServo": vservo_mv, "flags": flags}
    }


# ─── Layer 1: State ingestion ──────────────────

class TestStateIngestion:
    def test_battery_status_cells_parsed(self):
        engine = make_engine()
        # 6S pack at ~4.1V each
        cells = [4100, 4100, 4100, 4100, 4050, 4080]
        engine.update("BATTERY_STATUS", battery_status_msg(cells)["data"])
        cells_out = PowerState._extract_cells(engine.state.battery_status)
        assert len(cells_out) == 6
        assert all(3.9 < c < 4.2 for c in cells_out)

    def test_uint16_max_cells_excluded(self):
        """65535 means unpopulated slot — must be filtered out."""
        engine = make_engine()
        data = {"voltages": [4100, 4100, 65535, 65535, 65535, 65535,
                              65535, 65535, 65535, 65535],
                "current_battery": 0, "energy_consumed": 0,
                "temperature": 2500, "fault_bitmask": 0, "ts": time.time()}
        engine.update("BATTERY_STATUS", data)
        cells = PowerState._extract_cells(engine.state.battery_status)
        assert len(cells) == 2

    def test_sys_status_voltage_pushed_to_history(self):
        engine = make_engine()
        engine.update("SYS_STATUS", sys_status_msg(24000)["data"])
        assert len(engine.state.voltage_history.values) == 1
        _, v = engine.state.voltage_history.values[0]
        assert abs(v - 24.0) < 0.01

    def test_brownout_flag_detection(self):
        engine = make_engine()
        engine.update("POWER_STATUS", power_status_msg(flags=0)["data"])
        assert engine.state.last_brownout_ts is None
        engine.update("POWER_STATUS", power_status_msg(flags=0x10)["data"])
        assert engine.state.last_brownout_ts is not None


# ─── Layer 2: Feature extraction ──────────────

class TestFeatureExtraction:
    def test_imbalance_computed(self):
        engine = make_engine()
        # 4.1V on 5 cells, 3.8V on one — imbalance = 0.3V
        cells = [4100, 4100, 4100, 4100, 4100, 3800]
        engine.update("BATTERY_STATUS", battery_status_msg(cells)["data"])
        f = extract_features(engine.state, engine.baseline)
        assert f.imbalance_v is not None
        assert abs(f.imbalance_v - 0.3) < 0.005

    def test_weakest_cell_identified(self):
        engine = make_engine()
        cells = [4100, 4100, 3600, 4100, 4100, 4100]
        engine.update("BATTERY_STATUS", battery_status_msg(cells)["data"])
        f = extract_features(engine.state, engine.baseline)
        assert f.weakest_cell is not None
        assert abs(f.weakest_cell - 3.6) < 0.005

    def test_c_rate_computation(self):
        engine = make_engine()
        # 50A draw on 5Ah battery = 10C
        engine.update("SYS_STATUS", sys_status_msg(current_ca=5000)["data"])
        f = extract_features(engine.state, engine.baseline)
        assert f.c_rate is not None
        assert abs(f.c_rate - 10.0) < 0.1

    def test_battery_temp_parsed(self):
        engine = make_engine()
        engine.update("BATTERY_STATUS", battery_status_msg(
            [4100]*6, temp_cdeg=4200  # 42°C
        )["data"])
        f = extract_features(engine.state, engine.baseline)
        assert f.battery_temp_c is not None
        assert abs(f.battery_temp_c - 42.0) < 0.1

    def test_vcc_jitter_computed(self):
        engine = make_engine()
        # Push varying Vcc readings
        for mv in [5000, 5100, 4900, 5050, 4950]:
            d = {"Vcc": mv, "VServo": 5000, "flags": 0, "ts": time.time()}
            engine.update("POWER_STATUS", d)
        f = extract_features(engine.state, engine.baseline)
        assert f.vcc_jitter is not None
        assert f.vcc_jitter > 0.1  # 200mV spread


# ─── Layer 3: Threshold scoring ───────────────

class TestCellHealthScoring:
    def _features_with_cells(self, cells_v: list[float],
                              imbalance: float = None,
                              bms_flags: int = 0) -> PowerFeatures:
        f = PowerFeatures()
        f.cells = cells_v
        f.cell_count = len(cells_v)
        f.weakest_cell = min(cells_v)
        f.strongest_cell = max(cells_v)
        f.imbalance_v = imbalance if imbalance is not None else (max(cells_v) - min(cells_v))
        f.bms_fault_flags = bms_flags
        f.battery_status = {"voltages": [int(v*1000) for v in cells_v] + [65535]*4}
        return f

    def test_healthy_cells_scores_high(self):
        f = self._features_with_cells([4.1, 4.1, 4.1, 4.1, 4.1, 4.1])
        s = score_cell_health(f)
        assert s.score >= 90
        assert s.status == "ok"

    def test_critical_cell_voltage(self):
        f = self._features_with_cells([4.1, 4.1, 4.1, 4.1, 4.1, 3.4])
        s = score_cell_health(f)
        assert s.score < 50
        assert s.status == "critical"
        assert "3.4" in s.reason or "critical" in s.reason.lower()

    def test_warn_cell_imbalance(self):
        f = self._features_with_cells([4.1, 4.1, 4.1, 4.1, 4.1, 3.95])
        s = score_cell_health(f)
        assert s.score < 90  # penalised
        assert "imbalance" in s.reason.lower() or "warn" in s.status

    def test_critical_imbalance(self):
        f = self._features_with_cells([4.2]*5 + [4.0])
        f.imbalance_v = 0.22  # >0.2V
        s = score_cell_health(f)
        assert s.score < 60
        assert s.status in ("warn", "critical")

    def test_bms_fault_flag_forces_critical(self):
        f = self._features_with_cells([4.1]*6, bms_flags=0x0001)
        s = score_cell_health(f)
        assert s.score < 10
        assert s.status == "critical"
        assert "fault" in s.reason.lower()

    def test_no_cells_returns_warn(self):
        f = PowerFeatures()
        s = score_cell_health(f)
        assert s.status == "warn"
        assert "no bms" in s.reason.lower()


class TestPackHealthScoring:
    def _pack_features(self, voltage=24.0, current=10.0,
                       res_ratio=1.0, c_rate=0.5,
                       energy_pct=80.0) -> PowerFeatures:
        f = PowerFeatures()
        f.pack_voltage = voltage
        f.current_a = current
        f.resistance_vs_baseline = res_ratio
        f.c_rate = c_rate
        f.energy_remaining_pct = energy_pct
        return f

    def test_healthy_pack_scores_high(self):
        f = self._pack_features()
        s = score_pack_health(f)
        assert s.score >= 90
        assert s.status == "ok"

    def test_critical_energy_low(self):
        f = self._pack_features(energy_pct=8.0)
        s = score_pack_health(f)
        assert s.score < 50
        assert "8%" in s.reason or "land" in s.reason.lower()

    def test_warn_energy_low(self):
        f = self._pack_features(energy_pct=20.0)
        s = score_pack_health(f)
        assert s.score < 80

    def test_internal_resistance_degraded(self):
        f = self._pack_features(res_ratio=1.5)
        s = score_pack_health(f)
        assert s.score < 85
        assert "resistance" in s.reason.lower()

    def test_internal_resistance_critical(self):
        f = self._pack_features(res_ratio=2.2)
        s = score_pack_health(f)
        assert s.score < 50
        assert s.status in ("warn", "critical")

    def test_c_rate_over_rated(self):
        f = self._pack_features(c_rate=1.2)
        s = score_pack_health(f)
        assert s.score < 70
        assert "c-rate" in s.reason.lower() or "C" in s.reason


class TestThermalScoring:
    def _thermal_features(self, temp=25.0, rate=None, fc_temp=None):
        f = PowerFeatures()
        f.battery_temp_c = temp
        f.temp_rate = rate
        f.fc_temp_c = fc_temp
        return f

    def test_normal_temp_scores_high(self):
        f = self._thermal_features(temp=28.0)
        s = score_thermal(f)
        assert s.score >= 90

    def test_hot_battery_critical(self):
        f = self._thermal_features(temp=62.0)
        s = score_thermal(f)
        assert s.score < 40

    def test_cold_battery_warn(self):
        f = self._thermal_features(temp=3.0)
        s = score_thermal(f)
        assert s.score < 85
        assert "cold" in s.reason.lower() or "°C" in s.reason

    def test_thermal_runaway_rate(self):
        f = self._thermal_features(temp=38.0, rate=0.3)  # 18°C/min
        s = score_thermal(f)
        assert s.score < 70
        assert "runaway" in s.reason.lower() or "rising" in s.reason.lower()

    def test_no_temp_sensor_returns_ok(self):
        f = PowerFeatures()
        s = score_thermal(f)
        assert s.status == "ok"  # Unknown is not critical


# ─── Layer 4: Hard overrides ──────────────────

class TestHardOverrides:
    def test_no_override_when_healthy(self):
        f = PowerFeatures()
        f.imbalance_v = 0.05
        f.battery_temp_c = 30.0
        f.resistance_vs_baseline = 1.1
        f.current_spike_rate = 10.0
        override, reason = check_hard_overrides(f)
        assert override is False

    def test_imbalance_over_0_3_triggers_override(self):
        f = PowerFeatures()
        f.imbalance_v = 0.35
        override, reason = check_hard_overrides(f)
        assert override is True
        assert "imbalance" in reason.lower()

    def test_temp_over_65_triggers_override(self):
        f = PowerFeatures()
        f.battery_temp_c = 67.0
        override, reason = check_hard_overrides(f)
        assert override is True
        assert "65" in reason or "temp" in reason.lower()

    def test_resistance_3x_triggers_override(self):
        f = PowerFeatures()
        f.resistance_vs_baseline = 3.2
        override, reason = check_hard_overrides(f)
        assert override is True
        assert "resistance" in reason.lower()

    def test_current_spike_triggers_override(self):
        f = PowerFeatures()
        f.current_spike_rate = 160.0
        override, reason = check_hard_overrides(f)
        assert override is True

    def test_brownout_triggers_override(self):
        f = PowerFeatures()
        f.brownout_detected = True
        override, reason = check_hard_overrides(f)
        assert override is True

    def test_dead_cell_triggers_override(self):
        f = PowerFeatures()
        f.cell_count = 6
        f.battery_status = {
            "voltages": [4100, 4100, 4100, 0, 4100, 4100, 65535, 65535, 65535, 65535],
        }
        override, reason = check_hard_overrides(f)
        assert override is True
        assert "dead cell" in reason.lower()


# ─── Layer 4: Composite scoring ───────────────

class TestCompositeScoring:
    def test_override_forces_zero(self):
        engine = make_engine()
        # Send imbalance > 0.3V to trigger override
        cells = [4200]*5 + [3800]  # 0.4V imbalance
        engine.update("BATTERY_STATUS", battery_status_msg(cells)["data"])
        result = engine.score()
        assert result.override is True
        assert result.composite == 0.0
        assert result.status == "critical"

    def test_healthy_flight_scores_above_80(self):
        engine = make_engine()
        cells = [4100]*6  # balanced, healthy
        engine.update("BATTERY_STATUS", battery_status_msg(
            cells, current_ma=1000, temp_cdeg=2500
        )["data"])
        engine.update("SYS_STATUS", sys_status_msg(
            voltage_mv=24600, current_ca=100, battery_pct=85
        )["data"])
        engine.update("POWER_STATUS", power_status_msg(
            vcc_mv=5050, vservo_mv=5020, flags=0
        )["data"])
        result = engine.score()
        assert result.composite >= 80
        assert result.status == "healthy"

    def test_score_bands_correct(self):
        from power_health import score_band
        assert score_band(90) == "healthy"
        assert score_band(65) == "degraded"
        assert score_band(40) == "critical"

    def test_result_serializes_to_dict(self):
        engine = make_engine()
        engine.update("SYS_STATUS", sys_status_msg()["data"])
        result = engine.score()
        d = result.to_dict()
        assert "composite" in d
        assert "sub_scores" in d
        assert "drone_id" in d
        assert d["drone_id"] == "DR-001"
        # All scores should be rounded
        assert isinstance(d["composite"], float)

    def test_sub_score_reasons_present(self):
        engine = make_engine()
        engine.update("BATTERY_STATUS", battery_status_msg([4100]*6)["data"])
        engine.update("SYS_STATUS", sys_status_msg()["data"])
        result = engine.score()
        for key, ss in result.sub_scores.items():
            assert len(ss.reason) > 10, f"Sub-score '{key}' has empty reason"
            assert ss.status in ("ok", "warn", "critical")


# ─── SignalHistory edge cases ──────────────────

class TestSignalHistory:
    def test_rate_returns_none_with_one_sample(self):
        h = SignalHistory()
        h.push(10.0)
        assert h.rate() is None

    def test_rate_computed_correctly(self):
        h = SignalHistory()
        h.push(10.0, ts=0.0)
        h.push(20.0, ts=10.0)
        assert abs(h.rate() - 1.0) < 0.001

    def test_jitter_computed(self):
        h = SignalHistory()
        for v in [5.0, 5.1, 4.9, 5.05]:
            h.push(v)
        assert abs(h.jitter() - 0.2) < 0.01

    def test_maxlen_respected(self):
        h = SignalHistory(maxlen=5)
        for i in range(20):
            h.push(float(i))
        assert len(h.values) == 5


# ─── Integration test ─────────────────────────

class TestIntegration:
    def test_full_pipeline_healthy_drone(self):
        """Simulate a full telemetry burst from a healthy drone."""
        engine = make_engine()

        packets = [
            battery_status_msg([4080, 4090, 4085, 4080, 4075, 4070],
                                current_ma=800, temp_cdeg=2800),
            sys_status_msg(voltage_mv=24480, current_ca=80, battery_pct=78),
            power_status_msg(vcc_mv=5020, vservo_mv=4990, flags=0),
        ]
        for p in packets:
            engine.update(p["type"], p["data"])

        result = engine.score()

        assert result.composite >= 75
        assert result.override is False
        assert "cell_health" in result.sub_scores
        assert "pack_health" in result.sub_scores
        assert result.diagnostics["preflight"]["go_nogo"] in (True, False)

    def test_full_pipeline_failing_battery(self):
        """Simulate a flight with a bad battery (low cells, high resistance)."""
        engine = make_engine()

        # Simulate baseline already set to 0.015 ohm
        engine.baseline._baseline = {
            "internal_resistance_ohm": 0.015,
            "rated_capacity_ah": 5.0,
            "rated_capacity_wh": 111.0,
        }

        packets = [
            battery_status_msg([3600, 3590, 3550, 3600, 3580, 3570],
                                current_ma=3000, temp_cdeg=4800),  # 48°C
        ]
        # Build sys_status data with battery_resistance field manually
        d = sys_status_msg(voltage_mv=21400, current_ca=300, battery_pct=15)["data"]
        d["battery_resistance"] = 45  # 45mΩ → 0.045 Ω → 3× baseline
        engine.update("BATTERY_STATUS", packets[0]["data"])
        engine.update("SYS_STATUS", d)

        result = engine.score()

        # Either override or very low score
        assert result.composite < 60 or result.override

    def test_power_engine_output_contains_required_fields(self):
        """
        Verify the PowerHealthEngine produces a dict with all fields
        that ConsumerWorker will embed in the scores payload.
        """
        engine = make_engine()
        engine.update("BATTERY_STATUS", battery_status_msg([4100]*6)["data"])
        engine.update("SYS_STATUS", sys_status_msg()["data"])
        engine.update("POWER_STATUS", power_status_msg()["data"])
        result = engine.score()
        d = result.to_dict()

        # Fields that consumer.py reads from power_result
        assert "composite" in d
        assert "sub_scores" in d
        assert "status" in d
        assert "override" in d
        assert "diagnostics" in d
        assert d["drone_id"] == "DR-001"

        # Sub-score keys the dashboard pwr_detail panel expects
        for key in ("cell_health", "pack_health", "thermal", "sys_power"):
            assert key in result.sub_scores
            ss = result.sub_scores[key]
            assert ss.status in ("ok", "warn", "critical")
            assert len(ss.reason) > 0
