"""
Power Health Scoring Engine
Implements all 5 layers from the Power Health Detection Architecture.

MAVLink message sources:
  - BATTERY_STATUS     (#147)  → per-cell voltages, current, remaining %
  - SYS_STATUS         (#1)    → pack voltage, current, battery remaining
  - POWER_STATUS       (#125)  → Vcc, VServo, flags
  - SCALED_PRESSURE    (temp)  → used if no dedicated battery temp msg

Usage:
    engine = PowerHealthEngine(drone_id="DR-001", redis_client=r)
    engine.update("BATTERY_STATUS", mavlink_data)
    engine.update("SYS_STATUS", mavlink_data)
    result = engine.score()
"""

from __future__ import annotations

import time
import json
import math
from collections import deque
from dataclasses import dataclass, field, asdict
from typing import Optional
import redis


# ─────────────────────────────────────────────
# Data Structures
# ─────────────────────────────────────────────

@dataclass
class SubScore:
    score: float          # 0–100
    weight: float
    status: str           # "ok" | "warn" | "critical" | "override"
    reason: str           # human-readable explanation
    raw: dict             # raw input values used


@dataclass
class PowerScoreResult:
    composite: float
    status: str           # "healthy" | "degraded" | "critical"
    drone_id: str
    ts: float
    override: bool        # True if hard override forced score to 0
    override_reason: str
    sub_scores: dict[str, SubScore]
    diagnostics: dict     # extra detail for explainability UI

    def to_dict(self) -> dict:
        return {
            "type": "POWER_SCORE",
            "drone_id": self.drone_id,
            "ts": self.ts,
            "composite": round(self.composite, 1),
            "status": self.status,
            "override": self.override,
            "override_reason": self.override_reason,
            "sub_scores": {
                k: {
                    **asdict(v),
                    "score": round(v.score, 1),
                }
                for k, v in self.sub_scores.items()
            },
            "diagnostics": self.diagnostics,
        }


# ─────────────────────────────────────────────
# Baseline Store — persists in Redis + DuckDB
# ─────────────────────────────────────────────

class PowerBaseline:
    """
    Stores per-drone baseline for internal resistance tracking.
    Baseline is captured during the first healthy flight and updated slowly.
    """

    REDIS_KEY = "power_baseline:{drone_id}"
    ALPHA = 0.05  # EMA smoothing — 5% weight on new reading

    def __init__(self, drone_id: str, redis_client: redis.Redis):
        self.drone_id = drone_id
        self.redis = redis_client
        self._baseline: Optional[dict] = None

    def _key(self) -> str:
        return self.REDIS_KEY.format(drone_id=self.drone_id)

    def load(self) -> dict:
        if self._baseline is not None:
            return self._baseline
        raw = self.redis.get(self._key())
        if raw:
            self._baseline = json.loads(raw)
        else:
            self._baseline = {}
        return self._baseline

    def save(self):
        self.redis.set(self._key(), json.dumps(self._baseline), ex=86400 * 90)  # 90 days

    def get_resistance_baseline(self) -> Optional[float]:
        b = self.load()
        return b.get("internal_resistance_ohm")

    def update_resistance(self, measured_ohm: float):
        """
        EMA update — only updates when measurement looks valid (not 0, not huge).
        """
        if not (0.001 < measured_ohm < 1.0):
            return
        b = self.load()
        current = b.get("internal_resistance_ohm")
        if current is None:
            b["internal_resistance_ohm"] = measured_ohm
        else:
            b["internal_resistance_ohm"] = (1 - self.ALPHA) * current + self.ALPHA * measured_ohm
        b["resistance_updated_at"] = time.time()
        b["resistance_sample_count"] = b.get("resistance_sample_count", 0) + 1
        self._baseline = b
        self.save()

    def get_capacity_wh(self) -> Optional[float]:
        return self.load().get("rated_capacity_wh")

    def set_capacity_wh(self, wh: float):
        b = self.load()
        b["rated_capacity_wh"] = wh
        self._baseline = b
        self.save()

    def get_capacity_ah(self) -> Optional[float]:
        return self.load().get("rated_capacity_ah")

    def set_capacity_ah(self, ah: float):
        b = self.load()
        b["rated_capacity_ah"] = ah
        self._baseline = b
        self.save()


# ─────────────────────────────────────────────
# Signal History — for derivative computation
# ─────────────────────────────────────────────

class SignalHistory:
    """Rolling window for computing derivatives: d/dt and d²/dt²."""

    def __init__(self, maxlen: int = 30):
        self.values: deque[tuple[float, float]] = deque(maxlen=maxlen)  # (ts, value)

    def push(self, value: float, ts: Optional[float] = None):
        self.values.append((ts if ts is not None else time.time(), value))

    def rate(self) -> Optional[float]:
        """d/dt using oldest and newest sample."""
        if len(self.values) < 2:
            return None
        t0, v0 = self.values[0]
        t1, v1 = self.values[-1]
        if t0 is None or t1 is None:
            return None
        dt = t1 - t0
        if dt < 0.01:
            return None
        return (v1 - v0) / dt

    def acceleration(self) -> Optional[float]:
        """d²/dt² — discharge acceleration. Detects sudden voltage drops."""
        if len(self.values) < 3:
            return None
        rates = []
        items = list(self.values)
        for i in range(1, len(items)):
            dt = items[i][0] - items[i-1][0]
            if dt > 0.001:
                rates.append((items[i][0], (items[i][1] - items[i-1][1]) / dt))
        if len(rates) < 2:
            return None
        dt = rates[-1][0] - rates[0][0]
        if dt < 0.01:
            return None
        return (rates[-1][1] - rates[0][1]) / dt

    def jitter(self) -> Optional[float]:
        """Peak-to-peak range over window — used for Vcc stability."""
        if len(self.values) < 2:
            return None
        vals = [v for _, v in self.values]
        return max(vals) - min(vals)


# ─────────────────────────────────────────────
# Layer 1 + 2: DroneState accumulator
# ─────────────────────────────────────────────

class PowerState:
    """
    Accumulates all power-related MAVLink messages for a single drone.
    Keeps latest reading per message type + signal histories for derivatives.
    """

    def __init__(self):
        # Latest parsed values per message type
        self.battery_status: Optional[dict] = None   # BATTERY_STATUS (#147)
        self.sys_status: Optional[dict] = None       # SYS_STATUS (#1)
        self.power_status: Optional[dict] = None     # POWER_STATUS (#125)

        # Signal histories for derivative computation
        self.voltage_history = SignalHistory(maxlen=30)
        self.imbalance_history = SignalHistory(maxlen=20)
        self.current_history = SignalHistory(maxlen=20)
        self.vcc_history = SignalHistory(maxlen=15)
        self.temp_history = SignalHistory(maxlen=15)

        self.last_brownout_ts: Optional[float] = None
        self.prev_power_flags: int = 0

    def ingest(self, msg_type: str, data: dict):
        ts = data.get("ts", time.time())

        if msg_type == "BATTERY_STATUS":
            self.battery_status = data
            # Push per-cell voltages for imbalance tracking
            cells = self._extract_cells(data)
            if cells:
                imbalance = max(cells) - min(cells)
                self.imbalance_history.push(imbalance, ts)

        elif msg_type == "SYS_STATUS":
            self.sys_status = data
            volt = data.get("voltage_battery", 0) / 1000.0
            curr = data.get("current_battery", 0) / 100.0
            if volt > 0:
                self.voltage_history.push(volt, ts)
            if curr >= 0:
                self.current_history.push(curr, ts)

        elif msg_type == "POWER_STATUS":
            self.power_status = data
            vcc = data.get("Vcc", 0) / 1000.0  # mV → V
            if vcc > 0:
                self.vcc_history.push(vcc, ts)
            # Detect brownout event
            flags = data.get("flags", 0)
            if (flags & 0x10) and not (self.prev_power_flags & 0x10):
                self.last_brownout_ts = ts
            self.prev_power_flags = flags

    @staticmethod
    def _extract_cells(battery_status: dict) -> list[float]:
        """
        MAVLink BATTERY_STATUS has voltages[] array in mV.
        UINT16_MAX (65535) means cell slot not populated.
        """
        raw = battery_status.get("voltages", [])
        cells = []
        for v in raw:
            if v != 65535 and v > 0:
                cells.append(v / 1000.0)  # mV → V
        # Also check voltages_ext for >4-cell packs
        raw_ext = battery_status.get("voltages_ext", [])
        for v in raw_ext:
            if v != 0 and v != 65535:
                cells.append(v / 1000.0)
        return cells


# ─────────────────────────────────────────────
# Layer 2: Feature Extraction
# ─────────────────────────────────────────────

@dataclass
class PowerFeatures:
    # Cell-level (BMS)
    cells: list[float] = field(default_factory=list)
    cell_count: int = 0
    weakest_cell: Optional[float] = None
    strongest_cell: Optional[float] = None
    imbalance_v: Optional[float] = None        # max - min
    imbalance_rate: Optional[float] = None     # d(imbalance)/dt
    bms_fault_flags: int = 0
    battery_status: Optional[dict] = None      # raw BATTERY_STATUS message

    # Pack-level (BAT)
    pack_voltage: Optional[float] = None       # Volt (under load)
    pack_voltage_rested: Optional[float] = None  # VoltR
    voltage_sag: Optional[float] = None        # Volt - VoltR
    current_a: Optional[float] = None
    internal_resistance_ohm: Optional[float] = None
    resistance_vs_baseline: Optional[float] = None  # ratio: measured / baseline
    c_rate: Optional[float] = None             # Curr / capacity_Ah
    energy_remaining_pct: Optional[float] = None
    discharge_accel: Optional[float] = None    # d²V/dt²
    current_spike_rate: Optional[float] = None # d(current)/dt

    # Thermal
    battery_temp_c: Optional[float] = None
    temp_rate: Optional[float] = None          # d(temp)/dt

    # System power (MCU/POWR)
    vcc_v: Optional[float] = None
    vcc_jitter: Optional[float] = None
    vservo_v: Optional[float] = None
    fc_temp_c: Optional[float] = None
    power_flags: int = 0
    brownout_detected: bool = False


def extract_features(state: PowerState, baseline: PowerBaseline) -> PowerFeatures:
    f = PowerFeatures()

    # ── Cell-level features ──────────────────
    if state.battery_status:
        bs = state.battery_status
        f.battery_status = bs
        cells = PowerState._extract_cells(bs)
        if cells:
            f.cells = cells
            f.cell_count = len(cells)
            f.weakest_cell = min(cells)
            f.strongest_cell = max(cells)
            f.imbalance_v = f.strongest_cell - f.weakest_cell
        f.bms_fault_flags = bs.get("fault_bitmask", 0)

        # Battery temp from BATTERY_STATUS (field: temperature, in cdegC)
        raw_temp = bs.get("temperature", 32767)
        if raw_temp != 32767:
            f.battery_temp_c = raw_temp / 100.0

        # Remaining energy
        energy_consumed = bs.get("energy_consumed", -1)
        rated_wh = baseline.get_capacity_wh()
        if energy_consumed >= 0 and rated_wh:
            # energy_consumed is in hJ (100mJ units in MAVLink)
            consumed_wh = energy_consumed / 360000.0
            f.energy_remaining_pct = max(0, (1 - consumed_wh / rated_wh) * 100)

    # ── Pack-level features ──────────────────
    if state.sys_status:
        ss = state.sys_status
        volt = ss.get("voltage_battery", 0) / 1000.0
        curr = ss.get("current_battery", 0) / 100.0  # cA → A
        batt_pct = ss.get("battery_remaining", -1)

        if volt > 0:
            f.pack_voltage = volt
        if curr >= 0:
            f.current_a = curr

        # Use battery_remaining as fallback for energy %
        if f.energy_remaining_pct is None and batt_pct >= 0:
            f.energy_remaining_pct = float(batt_pct)

        # Internal resistance: V_sag / Current
        # VoltR is rested voltage — not directly in SYS_STATUS.
        # Approximate: use voltage at near-zero current as VoltR baseline,
        # or use BAT.Res if available in extended message.
        res_raw = ss.get("battery_resistance", None)  # custom field
        if res_raw is not None and res_raw > 0:
            f.internal_resistance_ohm = res_raw / 1000.0  # mΩ → Ω

        # C-rate
        capacity_ah = baseline.get_capacity_ah()
        if capacity_ah and curr > 0:
            f.c_rate = curr / capacity_ah

        # Discharge acceleration (d²V/dt²)
        f.discharge_accel = state.voltage_history.acceleration()

        # Current spike rate (d(I)/dt)
        f.current_spike_rate = state.current_history.rate()

    # ── Resistance vs baseline ───────────────
    if f.internal_resistance_ohm is not None:
        baseline_r = baseline.get_resistance_baseline()
        if baseline_r:
            f.resistance_vs_baseline = f.internal_resistance_ohm / baseline_r
            # Update baseline with EMA
            baseline.update_resistance(f.internal_resistance_ohm)
        else:
            # No baseline yet — this reading becomes the baseline
            baseline.update_resistance(f.internal_resistance_ohm)

    # ── Imbalance rate ───────────────────────
    f.imbalance_rate = state.imbalance_history.rate()

    # ── Temperature rate ─────────────────────
    f.temp_rate = state.temp_history.rate()

    # ── System power features ────────────────
    if state.power_status:
        ps = state.power_status
        f.vcc_v = ps.get("Vcc", 0) / 1000.0
        f.vservo_v = ps.get("VServo", 0) / 1000.0
        f.power_flags = ps.get("flags", 0)

    f.vcc_jitter = state.vcc_history.jitter()

    # Brownout: within last 60s counts as active event
    if state.last_brownout_ts:
        if time.time() - state.last_brownout_ts < 60:
            f.brownout_detected = True

    return f


# ─────────────────────────────────────────────
# Layer 3 + 4: Threshold Evaluation & Scoring
# ─────────────────────────────────────────────

WEIGHTS = {
    "cell_health": 0.35,
    "pack_health": 0.40,
    "thermal":     0.15,
    "sys_power":   0.10,
}


def _status(score: float) -> str:
    if score >= 80:
        return "ok"
    elif score >= 50:
        return "warn"
    return "critical"


def score_cell_health(f: PowerFeatures) -> SubScore:
    """Layer 3: BMS / Cell Health — 35% weight."""
    raw = {
        "cell_count": f.cell_count,
        "cells_v": [round(c, 3) for c in f.cells],
        "weakest_v": round(f.weakest_cell, 3) if f.weakest_cell else None,
        "imbalance_v": round(f.imbalance_v, 3) if f.imbalance_v else None,
        "bms_flags": f.bms_fault_flags,
    }

    # No cell data at all
    if not f.cells:
        return SubScore(
            score=50, weight=WEIGHTS["cell_health"], status="warn",
            reason="No BMS cell data — BATTERY_STATUS not received or no per-cell telemetry",
            raw=raw
        )

    penalties: list[tuple[float, str]] = []

    # BMS fault flag — immediate critical
    if f.bms_fault_flags:
        return SubScore(
            score=5, weight=WEIGHTS["cell_health"], status="critical",
            reason=f"BMS fault flag set (0x{f.bms_fault_flags:04X}) — hardware fault reported",
            raw=raw
        )

    # Per-cell voltage
    critical_cells = [c for c in f.cells if c < 3.5]
    warn_cells = [c for c in f.cells if 3.5 <= c < 3.7]

    if critical_cells:
        penalties.append((60, f"{len(critical_cells)} cell(s) critical <3.5V — lowest: {min(critical_cells):.3f}V"))
    elif warn_cells:
        penalties.append((25, f"{len(warn_cells)} cell(s) low <3.7V — lowest: {min(warn_cells):.3f}V"))

    # Weakest cell
    if f.weakest_cell is not None:
        if f.weakest_cell < 3.4:
            penalties.append((55, f"Weakest cell {f.weakest_cell:.3f}V — below 3.4V hard floor"))
        elif f.weakest_cell < 3.6:
            penalties.append((20, f"Weakest cell {f.weakest_cell:.3f}V — below 3.6V warning"))

    # Cell imbalance
    if f.imbalance_v is not None:
        if f.imbalance_v > 0.2:
            penalties.append((45, f"Cell imbalance {f.imbalance_v:.3f}V — critical >0.2V (check balancer)"))
        elif f.imbalance_v > 0.1:
            penalties.append((20, f"Cell imbalance {f.imbalance_v:.3f}V — warning >0.1V"))

    # Imbalance rate (worsening fast)
    if f.imbalance_rate is not None and f.imbalance_rate > 0.005:
        penalties.append((15, f"Imbalance growing at {f.imbalance_rate*1000:.1f}mV/s — cell diverging"))

    if not penalties:
        reason = (
            f"All {f.cell_count} cells healthy — "
            f"weakest {f.weakest_cell:.3f}V, "
            f"imbalance {f.imbalance_v:.3f}V"
        )
        score = 95.0
    else:
        total_penalty = sum(p for p, _ in penalties)
        score = max(5.0, 100.0 - total_penalty)
        reason = " | ".join(msg for _, msg in sorted(penalties, reverse=True))

    return SubScore(
        score=score, weight=WEIGHTS["cell_health"],
        status=_status(score), reason=reason, raw=raw
    )


def score_pack_health(f: PowerFeatures) -> SubScore:
    """Layer 3: Pack Health — 40% weight."""
    raw = {
        "pack_voltage_v": round(f.pack_voltage, 3) if f.pack_voltage else None,
        "current_a": round(f.current_a, 2) if f.current_a else None,
        "internal_resistance_ohm": round(f.internal_resistance_ohm, 4) if f.internal_resistance_ohm else None,
        "resistance_vs_baseline": round(f.resistance_vs_baseline, 2) if f.resistance_vs_baseline else None,
        "c_rate": round(f.c_rate, 2) if f.c_rate else None,
        "voltage_sag_v": round(f.voltage_sag, 3) if f.voltage_sag else None,
        "energy_remaining_pct": round(f.energy_remaining_pct, 1) if f.energy_remaining_pct is not None else None,
        "discharge_accel": round(f.discharge_accel, 5) if f.discharge_accel else None,
    }

    if f.pack_voltage is None:
        return SubScore(
            score=50, weight=WEIGHTS["pack_health"], status="warn",
            reason="No pack voltage data — SYS_STATUS not received",
            raw=raw
        )

    penalties: list[tuple[float, str]] = []

    # Internal resistance vs baseline
    if f.resistance_vs_baseline is not None:
        if f.resistance_vs_baseline >= 2.0:
            penalties.append((55, f"Internal resistance {f.resistance_vs_baseline:.1f}× baseline — battery severely degraded"))
        elif f.resistance_vs_baseline >= 1.3:
            penalties.append((25, f"Internal resistance {f.resistance_vs_baseline:.1f}× baseline — degradation detected"))

    # C-rate stress
    if f.c_rate is not None:
        if f.c_rate >= 1.0:
            penalties.append((40, f"C-rate {f.c_rate:.2f}C — exceeding rated continuous discharge"))
        elif f.c_rate >= 0.8:
            penalties.append((15, f"C-rate {f.c_rate:.2f}C — approaching rated limit (0.8C warning)"))

    # Voltage sag
    if f.voltage_sag is not None:
        if f.voltage_sag > 1.0:
            penalties.append((40, f"Voltage sag {f.voltage_sag:.2f}V under load — high internal resistance"))
        elif f.voltage_sag > 0.5:
            penalties.append((15, f"Voltage sag {f.voltage_sag:.2f}V — moderate load stress"))

    # Energy remaining
    if f.energy_remaining_pct is not None:
        if f.energy_remaining_pct < 10:
            penalties.append((60, f"Energy {f.energy_remaining_pct:.0f}% — critical, land immediately"))
        elif f.energy_remaining_pct < 25:
            penalties.append((30, f"Energy {f.energy_remaining_pct:.0f}% — low, return to home"))

    # Discharge acceleration (d²V/dt²) — sudden drop
    if f.discharge_accel is not None and f.discharge_accel < -0.5:
        penalties.append((20, f"Discharge acceleration {f.discharge_accel:.3f}V/s² — voltage dropping faster than expected"))

    # Current spike
    if f.current_spike_rate is not None:
        if abs(f.current_spike_rate) > 100:
            penalties.append((30, f"Current spike {f.current_spike_rate:.0f}A/s — sudden load event"))
        elif abs(f.current_spike_rate) > 50:
            penalties.append((10, f"Current rising fast {f.current_spike_rate:.0f}A/s"))

    if not penalties:
        parts = [f"Pack {f.pack_voltage:.2f}V"]
        if f.energy_remaining_pct is not None:
            parts.append(f"{f.energy_remaining_pct:.0f}% energy")
        if f.c_rate is not None:
            parts.append(f"{f.c_rate:.2f}C draw")
        if f.resistance_vs_baseline is not None:
            parts.append(f"resistance {f.resistance_vs_baseline:.2f}× baseline")
        reason = " — ".join(parts) + " — nominal"
        score = 95.0
    else:
        total_penalty = sum(p for p, _ in penalties)
        score = max(5.0, 100.0 - total_penalty)
        reason = " | ".join(msg for _, msg in sorted(penalties, reverse=True))

    return SubScore(
        score=score, weight=WEIGHTS["pack_health"],
        status=_status(score), reason=reason, raw=raw
    )


def score_thermal(f: PowerFeatures) -> SubScore:
    """Layer 3: Thermal Health — 15% weight."""
    raw = {
        "battery_temp_c": round(f.battery_temp_c, 1) if f.battery_temp_c is not None else None,
        "temp_rate_c_per_s": round(f.temp_rate, 3) if f.temp_rate else None,
        "fc_temp_c": round(f.fc_temp_c, 1) if f.fc_temp_c is not None else None,
    }

    if f.battery_temp_c is None:
        return SubScore(
            score=75, weight=WEIGHTS["thermal"], status="ok",
            reason="No battery temperature sensor data",
            raw=raw
        )

    penalties: list[tuple[float, str]] = []

    # Hot threshold
    if f.battery_temp_c > 60:
        penalties.append((70, f"Battery {f.battery_temp_c:.1f}°C — critical overtemp, land now"))
    elif f.battery_temp_c > 45:
        penalties.append((30, f"Battery {f.battery_temp_c:.1f}°C — above 45°C warning"))

    # Cold threshold
    elif f.battery_temp_c < 0:
        penalties.append((50, f"Battery {f.battery_temp_c:.1f}°C — below 0°C, capacity severely reduced"))
    elif f.battery_temp_c < 5:
        penalties.append((20, f"Battery {f.battery_temp_c:.1f}°C — cold, expect reduced capacity"))

    # Temp rise rate (more sensitive than absolute)
    if f.temp_rate is not None and f.temp_rate > 0.25:  # >15°C/min
        penalties.append((35, f"Temperature rising {f.temp_rate*60:.1f}°C/min — thermal runaway risk"))
    elif f.temp_rate is not None and f.temp_rate > 0.083:  # >5°C/min
        penalties.append((15, f"Temperature rising {f.temp_rate*60:.1f}°C/min — monitor closely"))

    # FC temperature
    if f.fc_temp_c is not None:
        if f.fc_temp_c > 85:
            penalties.append((40, f"FC temp {f.fc_temp_c:.1f}°C — critical, throttling likely"))
        elif f.fc_temp_c > 70:
            penalties.append((15, f"FC temp {f.fc_temp_c:.1f}°C — elevated"))

    if not penalties:
        reason = f"Battery {f.battery_temp_c:.1f}°C — within safe range (5–45°C)"
        score = 95.0
    else:
        total_penalty = sum(p for p, _ in penalties)
        score = max(5.0, 100.0 - total_penalty)
        reason = " | ".join(msg for _, msg in sorted(penalties, reverse=True))

    return SubScore(
        score=score, weight=WEIGHTS["thermal"],
        status=_status(score), reason=reason, raw=raw
    )


def score_sys_power(f: PowerFeatures) -> SubScore:
    """Layer 3: System Power Stability (FC rails) — 10% weight."""
    raw = {
        "vcc_v": round(f.vcc_v, 3) if f.vcc_v else None,
        "vcc_jitter_v": round(f.vcc_jitter, 3) if f.vcc_jitter else None,
        "vservo_v": round(f.vservo_v, 3) if f.vservo_v else None,
        "power_flags": f.power_flags,
        "brownout": f.brownout_detected,
    }

    if f.vcc_v is None:
        return SubScore(
            score=75, weight=WEIGHTS["sys_power"], status="ok",
            reason="No POWER_STATUS data — FC rail monitoring unavailable",
            raw=raw
        )

    penalties: list[tuple[float, str]] = []

    # Brownout event
    if f.brownout_detected:
        penalties.append((60, "Brownout event detected in last 60s — FC voltage drop event"))

    # Vcc absolute
    if f.vcc_v < 4.75:
        penalties.append((55, f"Vcc {f.vcc_v:.3f}V — below 4.75V brownout risk"))
    elif f.vcc_v < 4.9:
        penalties.append((20, f"Vcc {f.vcc_v:.3f}V — below 4.9V warning"))

    # Vcc jitter (stability)
    if f.vcc_jitter is not None:
        if f.vcc_jitter > 0.2:
            penalties.append((35, f"Vcc jitter {f.vcc_jitter:.3f}V — unstable FC power rail"))
        elif f.vcc_jitter > 0.1:
            penalties.append((15, f"Vcc jitter {f.vcc_jitter:.3f}V — slight rail instability"))

    # Servo rail
    if f.vservo_v is not None:
        if f.vservo_v < 4.5:
            penalties.append((40, f"Servo rail {f.vservo_v:.3f}V — below 4.5V critical"))
        elif f.vservo_v < 4.8:
            penalties.append((15, f"Servo rail {f.vservo_v:.3f}V — below 4.8V warning"))

    if not penalties:
        reason = f"Vcc {f.vcc_v:.3f}V stable"
        if f.vservo_v:
            reason += f", servo rail {f.vservo_v:.3f}V"
        reason += " — nominal"
        score = 95.0
    else:
        total_penalty = sum(p for p, _ in penalties)
        score = max(5.0, 100.0 - total_penalty)
        reason = " | ".join(msg for _, msg in sorted(penalties, reverse=True))

    return SubScore(
        score=score, weight=WEIGHTS["sys_power"],
        status=_status(score), reason=reason, raw=raw
    )


def check_hard_overrides(f: PowerFeatures) -> tuple[bool, str]:
    """
    Layer 4: Hard Override Rules — any of these forces composite to 0.
    From architecture: checked BEFORE weighted scoring.
    """
    # Cell reported dead or missing (voltage = 0 in populated slot)
    if f.battery_status and f.cell_count > 0:
        raw_voltages = f.battery_status.get("voltages", [])
        expected = f.battery_status.get("battery_remaining", -1)  # use as proxy
        # Check for zero voltage in a populated slot (not UINT16_MAX)
        dead = [v for v in raw_voltages if v == 0]
        if dead:
            return True, f"Dead cell detected — {len(dead)} cell(s) reporting 0V"

    # Cell imbalance > 0.3V
    if f.imbalance_v is not None and f.imbalance_v > 0.3:
        return True, f"Cell imbalance {f.imbalance_v:.3f}V exceeds 0.3V hard limit"

    # Battery temp > 65°C
    if f.battery_temp_c is not None and f.battery_temp_c > 65:
        return True, f"Battery temp {f.battery_temp_c:.1f}°C exceeds 65°C hard limit — land immediately"

    # Brownout
    if f.brownout_detected:
        return True, "MCU brownout event — FC power instability detected"

    # POWR critical flag (bit 4 in MAVLink POWER_STATUS flags = MAV_POWER_STATUS_CHANGED)
    if f.power_flags & 0x08:  # USB_CONNECTED changed + other instability combos
        pass  # Only override on explicit critical flags — customize per FC

    # Internal resistance > 3× baseline
    if f.resistance_vs_baseline is not None and f.resistance_vs_baseline > 3.0:
        return True, f"Internal resistance {f.resistance_vs_baseline:.1f}× baseline — battery failure imminent"

    # Current spike > 150A/s
    if f.current_spike_rate is not None and abs(f.current_spike_rate) > 150:
        return True, f"Current spike {f.current_spike_rate:.0f}A/s — wiring or ESC fault"

    return False, ""


def composite_score(sub_scores: dict[str, SubScore]) -> float:
    """Weighted average of sub-scores."""
    total_weight = sum(s.weight for s in sub_scores.values())
    if total_weight == 0:
        return 0.0
    return sum(s.score * s.weight for s in sub_scores.values()) / total_weight


def score_band(composite: float) -> str:
    if composite >= 80:
        return "healthy"
    elif composite >= 50:
        return "degraded"
    return "critical"


# ─────────────────────────────────────────────
# Layer 5: Diagnostics
# ─────────────────────────────────────────────

def build_diagnostics(
    f: PowerFeatures,
    sub_scores: dict[str, SubScore],
    baseline: PowerBaseline
) -> dict:
    """
    Layer 5: Structured diagnostic output for UI explainability panel.
    Returns data the ScoreBreakdown React component can render directly.
    """
    diag = {}

    # Pre-flight checklist (only meaningful when drone is on ground / armed)
    diag["preflight"] = {
        "cell_imbalance_ok": (f.imbalance_v or 0) < 0.05,
        "min_cell_voltage_ok": (f.weakest_cell or 0) > 3.8,
        "temp_range_ok": f.battery_temp_c is not None and 10 <= f.battery_temp_c <= 40,
        "fc_voltage_ok": (f.vcc_v or 5.0) >= 4.9,
        "resistance_ok": (f.resistance_vs_baseline or 1.0) < 1.3,
        "go_nogo": all([
            (f.imbalance_v or 0) < 0.05,
            (f.weakest_cell or 0) > 3.8,
            (f.resistance_vs_baseline or 1.0) < 1.3,
        ])
    }

    # Worst sub-score for "what's dragging this down" summary
    worst = min(sub_scores.items(), key=lambda x: x[1].score)
    diag["worst_subsystem"] = {
        "name": worst[0],
        "score": round(worst[1].score, 1),
        "reason": worst[1].reason,
    }

    # Estimated flight time remaining (rough)
    if f.energy_remaining_pct is not None and f.current_a and f.current_a > 0.5:
        capacity_ah = baseline.get_capacity_ah()
        if capacity_ah:
            remaining_ah = (f.energy_remaining_pct / 100) * capacity_ah
            hours_remaining = remaining_ah / f.current_a
            diag["estimated_flight_minutes"] = round(hours_remaining * 60, 1)

    # Resistance trend label
    if f.resistance_vs_baseline is not None:
        if f.resistance_vs_baseline < 1.1:
            diag["battery_condition"] = "good"
        elif f.resistance_vs_baseline < 1.5:
            diag["battery_condition"] = "used"
        elif f.resistance_vs_baseline < 2.0:
            diag["battery_condition"] = "degraded"
        else:
            diag["battery_condition"] = "failing"

    return diag


# ─────────────────────────────────────────────
# Main Engine
# ─────────────────────────────────────────────

class PowerHealthEngine:
    """
    Top-level engine. One instance per drone.
    Call update() with each MAVLink packet, then score() to get result.
    """

    def __init__(self, drone_id: str, redis_client: redis.Redis):
        self.drone_id = drone_id
        self.state = PowerState()
        self.baseline = PowerBaseline(drone_id, redis_client)
        self._last_result: Optional[PowerScoreResult] = None

    def update(self, msg_type: str, data: dict):
        """Ingest a MAVLink message. Call this for every power-related packet."""
        self.state.ingest(msg_type, data)

    def score(self) -> PowerScoreResult:
        """Compute and return a full PowerScoreResult."""
        features = extract_features(self.state, self.baseline)

        # Hard overrides first
        override, override_reason = check_hard_overrides(features)
        if override:
            result = PowerScoreResult(
                composite=0.0,
                status="critical",
                drone_id=self.drone_id,
                ts=time.time(),
                override=True,
                override_reason=override_reason,
                sub_scores={},
                diagnostics={"override_active": True, "reason": override_reason},
            )
            self._last_result = result
            return result

        # Sub-scores
        sub_scores = {
            "cell_health": score_cell_health(features),
            "pack_health": score_pack_health(features),
            "thermal":     score_thermal(features),
            "sys_power":   score_sys_power(features),
        }

        comp = composite_score(sub_scores)
        diag = build_diagnostics(features, sub_scores, self.baseline)

        result = PowerScoreResult(
            composite=comp,
            status=score_band(comp),
            drone_id=self.drone_id,
            ts=time.time(),
            override=False,
            override_reason="",
            sub_scores=sub_scores,
            diagnostics=diag,
        )
        self._last_result = result
        return result

    def configure_battery(self, capacity_ah: float, rated_wh: float):
        """Call once when you know the battery specs. Stores in Redis."""
        self.baseline.set_capacity_ah(capacity_ah)
        self.baseline.set_capacity_wh(rated_wh)
