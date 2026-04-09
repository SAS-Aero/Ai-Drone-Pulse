/**
 * VibrationPage.jsx — Motor vibration health monitor.
 *
 * Displays live VIBE_NODES telemetry for n1–n4 (FL / FR / RL / RR arms):
 *  • Summary comparison chart — all 4 arm Z-axis values on one canvas
 *  • Per-arm detail charts    — Z (primary) + X / Y (secondary) over time
 *
 * Data flows in via WebSocket → useDroneStore.vibeHistory (ring buffer, 200 pts).
 */

import React, { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { Activity, RefreshCw } from 'lucide-react'
import useDroneStore from '../store/useDroneStore'

// ── Arm metadata ──────────────────────────────────────────────────────────────

const ARMS = [
  { key: 'n1', label: 'N1 — Front Left',  short: 'FL', color: '#06b6d4' },
  { key: 'n2', label: 'N2 — Front Right', short: 'FR', color: '#f59e0b' },
  { key: 'n3', label: 'N3 — Rear Left',   short: 'RL', color: '#a855f7' },
  { key: 'n4', label: 'N4 — Rear Right',  short: 'RR', color: '#10b981' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(t) {
  const d = new Date(t)
  return `${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function hex50(color) {
  return color + '80'
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function VibeTip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div style={{
      background: 'rgba(10,12,15,0.95)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '8px 12px',
      fontSize: 11,
    }}>
      <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color, display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
            {p.value != null ? p.value.toFixed(3) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ChartTitle({ children }) {
  return (
    <div style={{
      fontSize: 10,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      fontWeight: 700,
      marginBottom: 10,
    }}>
      {children}
    </div>
  )
}

function EmptyChart({ color }) {
  return (
    <div style={{
      height: 140,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: color + '40',
      fontSize: 12,
    }}>
      Waiting for VIBE_NODES packets…
    </div>
  )
}

// ── Comparison chart (all 4 Z values) ────────────────────────────────────────

function ComparisonChart({ vibeHistory }) {
  const data = useMemo(() =>
    vibeHistory.map((e) => ({
      t: fmtTime(e.t),
      n1z: e.n1?.z,
      n2z: e.n2?.z,
      n3z: e.n3?.z,
      n4z: e.n4?.z,
    })),
    [vibeHistory],
  )

  if (!data.length) {
    return (
      <div style={chartCard}>
        <ChartTitle>Z-Axis Comparison — All Arms (m/s²)</ChartTitle>
        <EmptyChart color="#6b7280" />
      </div>
    )
  }

  return (
    <div style={chartCard}>
      <ChartTitle>Z-Axis Comparison — All Arms (m/s²)</ChartTitle>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 10, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="t" tick={axTick} interval="preserveStartEnd" />
          <YAxis tick={axTick} width={52} tickFormatter={(v) => v.toFixed(1)} />
          <Tooltip content={<VibeTip />} />
          <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: 'var(--text-muted)' }} />
          {ARMS.map(({ key, short, color }) => (
            <Line
              key={key}
              type="monotone"
              dataKey={`${key}z`}
              name={`${short} Z`}
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Per-arm detail chart ──────────────────────────────────────────────────────

function ArmChart({ arm, vibeHistory }) {
  const { key, label, color } = arm

  const data = useMemo(() =>
    vibeHistory.map((e) => ({
      t: fmtTime(e.t),
      x: e[key]?.x,
      y: e[key]?.y,
      z: e[key]?.z,
    })),
    [vibeHistory, key],
  )

  return (
    <div style={{ ...chartCard, flex: 1, minWidth: 280 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <ChartTitle>{label}</ChartTitle>
      </div>

      {!data.length ? (
        <EmptyChart color={color} />
      ) : (
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={data} margin={{ top: 4, right: 10, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="t" tick={axTick} interval="preserveStartEnd" />
            <YAxis tick={axTick} width={52} tickFormatter={(v) => v.toFixed(1)} />
            <Tooltip content={<VibeTip />} />
            <Line type="monotone" dataKey="x" name="X" stroke={hex50(color)} strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="y" name="Y" stroke={hex50(color)} strokeWidth={1} dot={false} strokeDasharray="4 2" isAnimationActive={false} />
            <Line type="monotone" dataKey="z" name="Z" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Latest readings */}
      {data.length > 0 && (() => {
        const last = data[data.length - 1]
        return (
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            {['x', 'y', 'z'].map((axis) => (
              <div key={axis} style={{ fontSize: 10, color: axis === 'z' ? color : hex50(color) }}>
                <span style={{ textTransform: 'uppercase', letterSpacing: '0.08em', marginRight: 4 }}>{axis}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                  {last[axis] != null ? last[axis].toFixed(3) : '—'}
                </span>
              </div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function VibrationPage() {
  const drones = useDroneStore((s) => s.drones)
  const droneIds = Object.keys(drones).sort()

  const [selectedDrone, setSelectedDrone] = useState(() => droneIds[0] || '')

  const vibeHistory = useDroneStore((s) =>
    s.drones[selectedDrone]?.vibeHistory || [],
  )

  const sampleCount = vibeHistory.length

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <Activity size={16} style={{ color: '#06b6d4' }} />
        <span className="page-title">Vibration Monitor</span>
        {sampleCount > 0 && (
          <span className="page-count">{sampleCount} SAMPLES</span>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, alignItems: 'center' }}>
        <select
          value={selectedDrone}
          onChange={(e) => setSelectedDrone(e.target.value)}
          style={selectStyle}
        >
          <option value="">Select Drone…</option>
          {droneIds.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
          {/* Live indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: sampleCount > 0 ? '#10b981' : '#6b7280',
              boxShadow: sampleCount > 0 ? '0 0 6px #10b981' : 'none',
            }} />
            LIVE
          </div>

          {/* Arm legend */}
          <div style={{ display: 'flex', gap: 12, marginLeft: 16 }}>
            {ARMS.map(({ key, short, color }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color }}>
                <div style={{ width: 20, height: 2, background: color, borderRadius: 1 }} />
                {short}
              </div>
            ))}
          </div>
        </div>
      </div>

      {!selectedDrone && (
        <div className="empty-state" style={{ paddingTop: 60 }}>
          <Activity size={40} style={{ color: 'var(--text-dim)', opacity: 0.4 }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Select a drone to view vibration data.
          </span>
        </div>
      )}

      {selectedDrone && (
        <>
          {/* Z-axis comparison */}
          <ComparisonChart vibeHistory={vibeHistory} />

          {/* Per-arm detail charts in 2×2 grid */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
            {ARMS.map((arm) => (
              <ArmChart key={arm.key} arm={arm} vibeHistory={vibeHistory} />
            ))}
          </div>

          {/* Footer hint */}
          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Z-axis (solid) reflects motor thrust + gravity (≈ 9.81 m/s² at hover).
            Elevated X/Y (dashed/faded) indicates lateral vibration or frame imbalance.
            Mismatched Z values across arms may indicate a worn motor or bent prop.
          </div>
        </>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const axTick = { fill: '#6b7280', fontSize: 10 }

const chartCard = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '14px 18px',
}

const selectStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 6,
  padding: '5px 10px',
  fontSize: 12,
  cursor: 'pointer',
}
