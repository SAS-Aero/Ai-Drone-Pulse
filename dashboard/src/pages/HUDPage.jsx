/**
 * HUDPage.jsx — Cockpit-style live heads-up display.
 *
 * Layout:
 *  Row 1 : Metric tiles — ALTITUDE / SPEED / HEADING / THROTTLE / FLIGHT MODE / PACKETS/S
 *  Row 2 : Health scores — 7 arc gauges (mot, pwr, imu, ekf, gps, ctl, com) + overall tier
 *  Row 3 : 3-column body
 *           Left   → Attitude Indicator + GPS mini-map
 *           Centre → Motor Vibration (X-config quad with magnitude glow)
 *           Right  → Battery · Alerts · Message Types
 *  Row 4 : Packet Log (vertical scrollable)
 */

import React, { useRef, useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import useDroneStore from '../store/useDroneStore'
import ArcGauge from '../components/ArcGauge'

// ── Leaflet icon fix ───────────────────────────────────────────────────────────

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_LOG = 80

const FLIGHT_MODES = {
  0:'STABILIZE', 1:'ACRO', 2:'ALT_HOLD', 3:'AUTO', 4:'GUIDED',
  5:'LOITER', 6:'RTL', 7:'CIRCLE', 9:'LAND', 11:'DRIFT',
  13:'SPORT', 16:'POSHOLD', 17:'BRAKE', 18:'THROW',
}

const HEALTH_GAUGES = [
  { id: 'mot', label: 'Motor' },
  { id: 'pwr', label: 'Battery' },
  { id: 'imu', label: 'IMU' },
  { id: 'ekf', label: 'EKF' },
  { id: 'gps', label: 'GPS/Nav' },
  { id: 'ctl', label: 'Control' },
  { id: 'com', label: 'Comms' },
]

// Motor arm positions in the 360×400 SVG viewbox (X-config)
const QUAD_ARMS = [
  { key: 'n1', num: 1, label: 'FR', cx: 285, cy: 82  },
  { key: 'n2', num: 2, label: 'FL', cx: 75,  cy: 82  },
  { key: 'n3', num: 3, label: 'RL', cx: 75,  cy: 278 },
  { key: 'n4', num: 4, label: 'RR', cx: 285, cy: 278 },
]

// Vibration severity thresholds (m/s²)
const VIBE_WARN     = 13
const VIBE_CRITICAL = 18

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(s) {
  if (s == null) return '#4b5563'
  if (s >= 85) return '#00ff88'
  if (s >= 70) return '#44dd88'
  if (s >= 50) return '#ffaa00'
  if (s >= 30) return '#ff7700'
  return '#ff3d3d'
}

function scoreTier(s) {
  if (s == null) return 'WAITING'
  if (s >= 85) return 'NOMINAL'
  if (s >= 70) return 'GOOD'
  if (s >= 50) return 'DEGRADED'
  if (s >= 30) return 'POOR'
  return 'CRITICAL'
}

function vibeColor(mag) {
  if (mag == null) return '#4b5563'
  if (mag > VIBE_CRITICAL) return '#ff3d3d'
  if (mag > VIBE_WARN)     return '#ffaa00'
  return '#00ff88'
}

function fmt(val, dec = 1) {
  if (val == null) return '—'
  return Number(val).toFixed(dec)
}

// ── Metric tile ───────────────────────────────────────────────────────────────

function MetricTile({ title, value, subtitle, accent = false }) {
  return (
    <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 14px', minWidth: 0 }}>
      <div style={{ fontSize: 8, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.14em', color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 22, fontFamily: 'JetBrains Mono, monospace', fontWeight: 800, color: accent ? '#06b6d4' : 'var(--text)', lineHeight: 1, letterSpacing: '0.04em' }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
        {subtitle}
      </div>
    </div>
  )
}

// ── Attitude Indicator ────────────────────────────────────────────────────────

function AttitudeIndicator({ roll = 0, pitch = 0, yaw = 0 }) {
  const rollDeg  = (roll  * 180) / Math.PI
  const pitchDeg = (pitch * 180) / Math.PI
  const yawDeg   = (yaw   * 180) / Math.PI
  const pitchPx  = pitchDeg * 2.2

  const heading = ((yawDeg % 360) + 360) % 360
  const tapeItems = useMemo(() => {
    const items = []
    for (let d = -40; d <= 40; d += 10) {
      const deg   = Math.round((heading + d + 360) % 360)
      const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : String(deg)
      items.push({ offset: d, deg, label, cardinal: ['N','E','S','W'].includes(label) })
    }
    return items
  }, [heading])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
      {/* Main sphere */}
      <div style={{
        width: 190, height: 190, borderRadius: '50%', overflow: 'hidden',
        border: '2px solid rgba(255,255,255,0.12)', position: 'relative', flexShrink: 0,
        boxShadow: 'inset 0 0 24px rgba(0,0,0,0.6)',
      }}>
        {/* Rotating interior */}
        <div style={{
          position: 'absolute', inset: -40,
          transform: `rotate(${rollDeg}deg)`,
          transformOrigin: 'center center',
        }}>
          <div style={{
            position: 'absolute', left: 0, right: 0, top: 0,
            height: `calc(50% - ${pitchPx}px)`,
            background: 'linear-gradient(to bottom, #0a2a4a 0%, #1a5080 60%, #2060a0 100%)',
          }} />
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            height: `calc(50% + ${pitchPx}px)`,
            background: 'linear-gradient(to top, #3d1800 0%, #6b3010 70%, #7a3a12 100%)',
          }} />
          <div style={{
            position: 'absolute', left: 0, right: 0,
            top: `calc(50% - ${pitchPx}px)`,
            height: 1.5, background: 'rgba(255,255,255,0.7)',
          }} />
          {[-20, -10, 10, 20].map((p) => {
            const offset = -pitchPx + p * 2.2
            return (
              <div key={p} style={{
                position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                top: `calc(50% + ${offset}px)`,
                height: 1, width: Math.abs(p) === 10 ? 60 : 80,
                background: 'rgba(255,255,255,0.35)',
              }}>
                <span style={{
                  position: 'absolute', right: '100%', top: -7, marginRight: 4, fontSize: 8,
                  fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.5)',
                }}>
                  {Math.abs(p)}
                </span>
              </div>
            )
          })}
        </div>

        {/* Roll arc + pointer SVG overlay */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} viewBox="0 0 190 190">
          <path d="M 25 95 A 70 70 0 0 1 165 95" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
          {[-45,-30,-20,-10,0,10,20,30,45].map((a) => {
            const rad = ((-90 + a) * Math.PI) / 180
            const r1 = 68, r2 = 60
            return (
              <line key={a}
                x1={95 + r1 * Math.cos(rad)} y1={95 + r1 * Math.sin(rad)}
                x2={95 + r2 * Math.cos(rad)} y2={95 + r2 * Math.sin(rad)}
                stroke={a === 0 ? '#ffaa00' : 'rgba(255,255,255,0.4)'}
                strokeWidth={a === 0 ? 2 : 1}
              />
            )
          })}
          <polygon points="95,22 91,30 99,30" fill="#ffaa00" transform={`rotate(${rollDeg} 95 95)`} />
        </svg>

        {/* Fixed aircraft crosshair */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <svg width="100" height="24" viewBox="0 0 100 24">
            <rect x="0" y="10" width="32" height="4" rx="2" fill="#ffaa00" />
            <rect x="68" y="10" width="32" height="4" rx="2" fill="#ffaa00" />
            <rect x="44" y="16" width="12" height="4" rx="1" fill="#ffaa00" />
            <circle cx="50" cy="12" r="4" fill="none" stroke="#ffaa00" strokeWidth="2" />
            <circle cx="50" cy="12" r="1.5" fill="#ffaa00" />
          </svg>
        </div>
      </div>

      {/* Compass tape */}
      <div style={{
        width: 190, background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.08)',
        borderTop: 'none', display: 'flex', alignItems: 'center', height: 24, overflow: 'hidden', position: 'relative',
      }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, width: 1, height: 6, background: '#ffaa00', transform: 'translateX(-50%)' }} />
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-around', alignItems: 'center', paddingTop: 6 }}>
          {tapeItems.map(({ offset, label, cardinal }) => (
            <span key={offset} style={{
              fontSize: cardinal ? 10 : 9,
              fontFamily: 'JetBrains Mono, monospace',
              color: offset === 0 ? '#ffaa00' : cardinal ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)',
              fontWeight: cardinal || offset === 0 ? 700 : 400,
            }}>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* R / P / Y readout */}
      <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
        {[
          { label: 'R', value: rollDeg.toFixed(1) },
          { label: 'P', value: pitchDeg.toFixed(1) },
          { label: 'Y', value: (((yawDeg % 360) + 360) % 360).toFixed(1) },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <span style={{ fontSize: 9, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)' }}>{label}:</span>
            <span style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text)', fontWeight: 700 }}>{value}°</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── GPS map ───────────────────────────────────────────────────────────────────

function MapCenter({ lat, lng }) {
  const map = useMap()
  useEffect(() => { map.setView([lat, lng], Math.max(map.getZoom(), 13)) }, [lat, lng]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function GpsPanel({ position, gpsRaw }) {
  const sats = gpsRaw?.satellites_visible ?? null
  const hdop = gpsRaw ? (gpsRaw.eph / 100).toFixed(1) : null
  const fixNames = { 0:'No GPS', 1:'No Fix', 2:'2D Fix', 3:'3D Fix', 4:'DGPS', 5:'RTK Float', 6:'RTK Fix' }
  const fixType  = gpsRaw?.fix_type ?? 0
  const fixLabel = fixNames[fixType] ?? `Fix ${fixType}`
  const fixOk    = fixType >= 3

  const droneIcon = useMemo(() => L.divIcon({
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="7" fill="#06b6d4" fill-opacity="0.85" stroke="#06b6d4" stroke-width="1.5"/>
      <polygon points="10,1 13,8 10,6 7,8" fill="#fff"/>
    </svg>`,
    className: '', iconSize: [20, 20], iconAnchor: [10, 10],
  }), [])

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
      <div style={panelTitle}>GPS POSITION</div>
      {/* Fix badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 9, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
          padding: '2px 8px', letterSpacing: '0.08em',
          color: fixOk ? '#00ff88' : '#ffaa00',
          background: fixOk ? 'rgba(0,255,136,0.1)' : 'rgba(255,170,0,0.1)',
          border: `1px solid ${fixOk ? 'rgba(0,255,136,0.3)' : 'rgba(255,170,0,0.3)'}`,
        }}>
          {fixLabel}
        </span>
        <span style={{ fontSize: 9, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)' }}>
          Sats: <b style={{ color: 'var(--text)' }}>{sats ?? '—'}</b>
          <span style={{ marginLeft: 8 }}>HDOP: <b style={{ color: 'var(--text)' }}>{hdop ?? '—'}</b></span>
        </span>
      </div>
      <div style={{ height: 150, borderRadius: 4, overflow: 'hidden', background: '#0d1117' }}>
        {position ? (
          <MapContainer center={[position.lat, position.lng]} zoom={13}
            style={{ width: '100%', height: '100%' }} zoomControl={false} attributionControl={false}>
            <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" subdomains="abcd" maxZoom={19} />
            <MapCenter lat={position.lat} lng={position.lng} />
            <Marker position={[position.lat, position.lng]} icon={droneIcon} />
          </MapContainer>
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
            NO FIX
          </div>
        )}
      </div>
      {position && (
        <span style={{ fontSize: 9, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)' }}>
          {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
        </span>
      )}
    </div>
  )
}

// ── Motor Vibration (X-config quad with glow) ─────────────────────────────────

function MotorVibPanel({ vibeData, composite }) {
  const statusColor = scoreColor(composite)
  const statusTier  = scoreTier(composite)

  // Compute magnitude for each arm
  const armData = QUAD_ARMS.map((arm) => {
    const nd  = vibeData?.[arm.key]
    const mag = nd ? Math.sqrt(nd.x * nd.x + nd.y * nd.y + nd.z * nd.z) : null
    const col = vibeColor(mag)
    const glowR  = mag > VIBE_CRITICAL ? 44 : mag > VIBE_WARN ? 41 : 38
    const glowOp = mag > VIBE_CRITICAL ? 0.22 : mag > VIBE_WARN ? 0.14 : 0.06
    return { ...arm, nd, mag, col, glowR, glowOp }
  })

  const worstMag = Math.max(...armData.map((a) => a.mag ?? 0))
  const vibeStatusColor = vibeColor(worstMag)
  const vibeStatusLabel = worstMag > VIBE_CRITICAL ? 'CRITICAL' : worstMag > VIBE_WARN ? 'WARNING' : vibeData ? 'NOMINAL' : 'WAITING'

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 14px', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexShrink: 0 }}>
        <span style={panelTitle}>MOTOR VIBRATION</span>
        <span style={{
          fontSize: 9, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
          padding: '2px 10px', letterSpacing: '0.1em',
          color: vibeStatusColor, background: `${vibeStatusColor}18`, border: `1px solid ${vibeStatusColor}40`,
        }}>
          {vibeStatusLabel}
        </span>
      </div>

      {/* X-config SVG quad */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
        <svg viewBox="0 0 360 400" style={{ width: '100%', maxWidth: 340, maxHeight: 340 }}>
          <defs>
            <filter id="glow-g"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            <filter id="glow-y"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            <filter id="glow-r"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>

          {/* FRONT arrow */}
          <polygon points="180,28 172,42 188,42" fill="#06b6d4" opacity="0.7" />
          <text x="180" y="22" fill="#06b6d4" fontSize="10" fontFamily="sans-serif" fontWeight="600" textAnchor="middle">FRONT</text>

          {/* Frame arms */}
          {QUAD_ARMS.map((arm) => (
            <line key={arm.key} x1="180" y1="180" x2={arm.cx} y2={arm.cy}
              stroke="rgba(255,255,255,0.15)" strokeWidth="3" strokeLinecap="round" />
          ))}

          {/* Center body */}
          <rect x="158" y="158" width="44" height="44" rx="8" fill="#1a2540" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />

          {/* Per-motor nodes */}
          {armData.map((arm) => {
            const filterAttr = arm.mag > VIBE_CRITICAL ? 'url(#glow-r)' : arm.mag > VIBE_WARN ? 'url(#glow-y)' : 'url(#glow-g)'
            // axis label positions relative to node center
            const below = arm.cy > 180  // rear motors → labels below prop
            const yOff  = below ? 36 : -36
            const yBase = arm.cy + yOff
            return (
              <g key={arm.key}>
                {/* Glow halo */}
                <circle cx={arm.cx} cy={arm.cy} r={arm.glowR}
                  fill={arm.col} opacity={arm.glowOp} />
                {/* Prop circle */}
                <circle cx={arm.cx} cy={arm.cy} r="36"
                  fill="none" stroke={arm.col} strokeWidth="1.5" opacity="0.3" />
                {/* Motor ring */}
                <circle cx={arm.cx} cy={arm.cy} r="28"
                  fill="none" stroke={arm.col} strokeWidth="2.5"
                  filter={arm.nd ? filterAttr : undefined}
                  style={{ transition: 'stroke 0.3s ease' }} />
                {/* Motor number */}
                <text x={arm.cx} y={arm.cy} textAnchor="middle" dominantBaseline="central"
                  fontFamily="sans-serif" fontSize="14" fontWeight="700" fill="rgba(255,255,255,0.9)">
                  {arm.num}
                </text>
                {/* Magnitude above/below prop */}
                <text x={arm.cx} y={below ? arm.cy - 34 : arm.cy + 42}
                  textAnchor="middle" fontFamily="sans-serif" fontSize="11" fontWeight="700"
                  fill={arm.col} style={{ transition: 'fill 0.3s ease' }}>
                  {arm.mag != null ? `${arm.mag.toFixed(1)} m/s²` : '—'}
                </text>
                {/* X/Y/Z axis values */}
                <text x={arm.cx} y={yBase + (below ? 16 : 0)} textAnchor="middle" fontFamily="sans-serif" fontSize="9" fontWeight="600" fill="#ef4444">
                  X: {fmt(arm.nd?.x, 2)}
                </text>
                <text x={arm.cx} y={yBase + (below ? 27 : 11)} textAnchor="middle" fontFamily="sans-serif" fontSize="9" fontWeight="600" fill="#22c55e">
                  Y: {fmt(arm.nd?.y, 2)}
                </text>
                <text x={arm.cx} y={yBase + (below ? 38 : 22)} textAnchor="middle" fontFamily="sans-serif" fontSize="9" fontWeight="600" fill="#3b82f6">
                  Z: {fmt(arm.nd?.z, 2)}
                </text>
              </g>
            )
          })}

          {/* Legend */}
          <rect x="120" y="370" width="8" height="8" rx="1" fill="#ef4444" />
          <text x="132" y="378" fill="rgba(255,255,255,0.4)" fontSize="9" fontFamily="sans-serif">X</text>
          <rect x="148" y="370" width="8" height="8" rx="1" fill="#22c55e" />
          <text x="160" y="378" fill="rgba(255,255,255,0.4)" fontSize="9" fontFamily="sans-serif">Y</text>
          <rect x="176" y="370" width="8" height="8" rx="1" fill="#3b82f6" />
          <text x="188" y="378" fill="rgba(255,255,255,0.4)" fontSize="9" fontFamily="sans-serif">Z</text>
          <text x="214" y="378" fill="rgba(255,255,255,0.4)" fontSize="9" fontFamily="sans-serif">m/s²</text>
        </svg>
      </div>

      {/* Overall composite score bar */}
      <div style={{ flexShrink: 0, marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 9, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>COMPOSITE</span>
        <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${composite ?? 0}%`,
            background: statusColor,
            transition: 'width 0.5s ease, background 0.4s ease',
          }} />
        </div>
        <span style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: statusColor, minWidth: 30 }}>
          {composite != null ? Math.round(composite) : '—'}
        </span>
      </div>
    </div>
  )
}

// ── Battery panel ─────────────────────────────────────────────────────────────

function BatteryPanel({ pct, voltage, current }) {
  const barColor = pct == null ? '#4b5563' : pct > 50 ? '#00ff88' : pct > 25 ? '#ffaa00' : '#ff3d3d'
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
      <div style={panelTitle}>BATTERY</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Battery shape */}
        <div style={{ position: 'relative', width: 60, height: 26, flexShrink: 0 }}>
          <div style={{ position: 'absolute', inset: 0, border: '2px solid rgba(255,255,255,0.2)', borderRadius: 4 }} />
          <div style={{ position: 'absolute', top: '25%', right: -6, width: 5, height: '50%', background: 'rgba(255,255,255,0.2)', borderRadius: '0 2px 2px 0' }} />
          <div style={{
            position: 'absolute', top: 2, left: 2, bottom: 2,
            width: `calc(${Math.min(100, pct ?? 0)}% - 4px)`,
            background: barColor, borderRadius: 2,
            transition: 'width 0.5s ease, background 0.4s ease',
          }} />
        </div>
        <span style={{ fontSize: 28, fontFamily: 'JetBrains Mono, monospace', fontWeight: 800, color: barColor, letterSpacing: '0.02em', lineHeight: 1 }}>
          {pct != null ? `${Math.round(pct)}%` : '--%'}
        </span>
      </div>
      <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>
        {voltage != null ? `${voltage} V` : '-- V'}
        <span style={{ marginLeft: 12 }}>{current != null ? `${current} A` : '-- A'}</span>
      </div>
    </div>
  )
}

// ── Alerts panel ──────────────────────────────────────────────────────────────

function AlertsPanel({ alerts = [] }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={panelTitle}>ALERTS</span>
        {alerts.length > 0 && (
          <span style={{ background: '#ff3d3d', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3 }}>
            {alerts.length}
          </span>
        )}
      </div>
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        {alerts.length === 0 ? (
          <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)' }}>All systems nominal</div>
        ) : (
          alerts.map((a, i) => (
            <div key={a.code ?? i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <span style={{
                fontSize: 8, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
                padding: '1px 5px', letterSpacing: '0.08em', flexShrink: 0, marginTop: 1,
                color: (a.level || a.severity) === 'critical' ? '#ff3d3d' : '#ffaa00',
                background: (a.level || a.severity) === 'critical' ? 'rgba(255,61,61,0.12)' : 'rgba(255,170,0,0.12)',
              }}>
                {(a.level || a.severity) === 'critical' ? 'CRIT' : 'WARN'}
              </span>
              <div>
                {a.code && <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text)', fontWeight: 700 }}>{a.code}</div>}
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{a.message}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Message types panel ───────────────────────────────────────────────────────

function MsgTypesPanel({ telemetry }) {
  const types = Object.keys(telemetry || {})
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
      <span style={panelTitle}>MESSAGE TYPES</span>
      {types.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {types.map((t) => (
            <span key={t} style={{
              fontSize: 8, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.06em',
              color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)',
              padding: '1px 6px', borderRadius: 3,
            }}>
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Packet log (vertical scrollable) ─────────────────────────────────────────

function PacketLog({ log, rate }) {
  const logRef = useRef(null)
  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
      maxHeight: 140,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '5px 12px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={panelTitle}>PACKET LOG</span>
        <span style={{
          fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
          color: rate > 0 ? '#06b6d4' : 'var(--text-dim)',
          background: rate > 0 ? 'rgba(6,182,212,0.1)' : 'transparent',
          border: `1px solid ${rate > 0 ? 'rgba(6,182,212,0.3)' : 'transparent'}`,
          padding: '1px 8px', borderRadius: 3,
        }}>
          {rate} pkts/s
        </span>
      </div>
      <div ref={logRef} style={{ overflowY: 'auto', flex: 1 }}>
        {log.length === 0 ? (
          <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            waiting for packets…
          </div>
        ) : (
          log.map((entry, i) => (
            <div key={entry.ts ? `${entry.ts}-${i}` : i} style={{
              display: 'flex', gap: 10, padding: '2px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.02)',
              fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
            }}>
              <span style={{ color: 'var(--text-dim)', minWidth: 60, flexShrink: 0 }}>{entry.ts}</span>
              <span style={{ color: '#b388ff', minWidth: 70, flexShrink: 0 }}>{entry.drone}</span>
              <span style={{ color: '#06b6d4', minWidth: 140, flexShrink: 0 }}>{entry.type}</span>
              <span style={{ color: 'rgba(255,255,255,0.25)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.preview}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Main HUD page ─────────────────────────────────────────────────────────────

export default function HUDPage() {
  const { droneId: paramId } = useParams()
  const drones        = useDroneStore((s) => s.drones)
  const activeDroneId = useDroneStore((s) => s.activeDroneId)
  const wsStatus      = useDroneStore((s) => s.wsStatus)
  const navigate      = useNavigate()

  const droneId = paramId
    || activeDroneId
    || Object.values(drones).find((d) => d.connected)?.id
    || Object.keys(drones)[0]
    || null

  const drone = droneId ? drones[droneId] : null

  // ── Packet rate tracking ──────────────────────────────────────────────────
  const [pktRate,  setPktRate]  = useState(0)
  const [pktTotal, setPktTotal] = useState(0)
  const pktCountRef   = useRef(0)
  const prevLastSeen  = useRef(null)

  useEffect(() => {
    if (!drone?.lastSeen || drone.lastSeen === prevLastSeen.current) return
    prevLastSeen.current = drone.lastSeen
    pktCountRef.current++
  }, [drone?.lastSeen])

  useEffect(() => {
    const id = setInterval(() => {
      setPktRate(pktCountRef.current)
      setPktTotal((t) => t + pktCountRef.current)
      pktCountRef.current = 0
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // ── Packet log ────────────────────────────────────────────────────────────
  const [packetLog, setPacketLog] = useState([])
  const prevTelemetry = useRef({})

  useEffect(() => {
    if (!drone?.telemetry) return
    const newEntries = []
    Object.keys(drone.telemetry).forEach((t) => {
      if (prevTelemetry.current[t] !== drone.telemetry[t]) {
        newEntries.push({
          ts:      new Date().toLocaleTimeString(),
          drone:   droneId || '',
          type:    t,
          preview: JSON.stringify(drone.telemetry[t]).slice(0, 80),
        })
      }
    })
    if (newEntries.length === 0) return
    prevTelemetry.current = drone.telemetry
    setPacketLog((log) => {
      const next = [...log, ...newEntries]
      return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next
    })
  }, [drone?.telemetry, droneId])

  // ── Waiting / no drone state ──────────────────────────────────────────────
  if (!drone && (wsStatus === 'disconnected' || wsStatus === 'connecting' || wsStatus === 'error')) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
        <span>{wsStatus === 'connecting' ? 'CONNECTING…' : wsStatus === 'error' ? 'CONNECTION ERROR' : 'NO CONNECTION'}</span>
      </div>
    )
  }

  if (!drone) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2}>
          <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
        <span>Waiting for drone…</span>
      </div>
    )
  }

  // ── Extract telemetry ─────────────────────────────────────────────────────
  const telem      = drone.telemetry || {}
  const attitude   = telem.ATTITUDE
  const gpsRaw     = telem.GPS_RAW_INT
  const vfrHud     = telem.VFR_HUD
  const sysStatus  = telem.SYS_STATUS
  const vibeNodes  = telem.VIBE_NODES
  const heartbeat  = telem.HEARTBEAT
  const scores     = drone.scores || {}

  const altM     = vfrHud?.alt?.toFixed(1) ?? (gpsRaw ? (gpsRaw.alt / 1000).toFixed(1) : null)
  const speed    = vfrHud?.groundspeed?.toFixed(1) ?? null
  const hdgRaw   = vfrHud?.heading ?? (attitude ? ((attitude.yaw * 180) / Math.PI) : null)
  const hdg      = hdgRaw != null ? ((hdgRaw % 360) + 360) % 360 : null
  const hdgDir   = hdg != null ? ['N','NE','E','SE','S','SW','W','NW'][Math.round(hdg / 45) % 8] : null
  const throttle = vfrHud?.throttle?.toFixed(0) ?? null
  const modeNum  = heartbeat?.custom_mode
  const modeStr  = modeNum != null ? (FLIGHT_MODES[modeNum] ?? `Mode ${modeNum}`) : '—'
  const battPct  = sysStatus?.battery_remaining ?? null
  const battV    = sysStatus?.voltage_battery != null ? (sysStatus.voltage_battery / 1000).toFixed(1) : null
  const battA    = sysStatus?.current_battery != null ? (sysStatus.current_battery / 100).toFixed(1) : null

  const composite   = scores.composite ?? null
  const tierColor   = scoreColor(composite)
  const overallTier = scoreTier(composite)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', overflow: 'hidden', minHeight: 0 }}>

      {/* ── Multi-drone selector ── */}
      {Object.keys(drones).length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          {Object.values(drones).map((d) => (
            <button key={d.id} onClick={() => navigate(`/hud/${d.id}`)}
              style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                padding: '4px 12px', cursor: 'pointer', letterSpacing: '0.08em', borderRadius: 4,
                background: d.id === droneId ? '#06b6d4' : 'var(--surface)',
                border: `1px solid ${d.id === droneId ? '#06b6d4' : 'var(--border)'}`,
                color: d.id === droneId ? '#fff' : 'var(--text-muted)',
              }}>
              <span style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 6,
                background: d.connected ? '#00ff88' : '#4b5563',
                boxShadow: d.connected ? '0 0 4px #00ff88' : 'none',
              }} />
              {d.id}
            </button>
          ))}
        </div>
      )}

      {/* ── Row 1: Metric tiles ── */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <MetricTile title="ALTITUDE"    value={altM    ?? '—'} subtitle="meters AGL" />
        <MetricTile title="SPEED"       value={speed   ?? '—'} subtitle="m/s ground" />
        <MetricTile title="HEADING"     value={hdg != null ? `${Math.round(hdg)}°` : '—'} subtitle={hdgDir ?? 'degrees'} />
        <MetricTile title="THROTTLE"    value={throttle != null ? `${throttle}%` : '—'} subtitle="percent" />
        <MetricTile title="FLIGHT MODE" value={modeStr} subtitle={drone.connected ? 'ACTIVE' : 'OFFLINE'} />
        <MetricTile title="PACKETS/S"   value={pktRate} subtitle={`${pktTotal} total`} accent />
      </div>

      {/* ── Row 2: Health scores ── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <span style={{ fontSize: 8, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.14em', color: 'var(--text-dim)', textTransform: 'uppercase', marginRight: 4, whiteSpace: 'nowrap' }}>
          HEALTH
        </span>
        <div style={{ display: 'flex', gap: 6, flex: 1, justifyContent: 'space-around' }}>
          {HEALTH_GAUGES.map(({ id, label }) => (
            <ArcGauge key={id} score={scores[id] ?? 0} label={label} size={70} />
          ))}
        </div>
        <span style={{
          fontSize: 9, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
          padding: '3px 10px', letterSpacing: '0.1em', whiteSpace: 'nowrap', marginLeft: 4,
          color: tierColor, background: `${tierColor}18`, border: `1px solid ${tierColor}40`,
          borderRadius: 4,
        }}>
          {overallTier}
        </span>
      </div>

      {/* ── Row 3: 3-column body ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr 220px', gap: 6, flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* Left: Attitude + GPS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <div style={panelTitle}>ATTITUDE INDICATOR</div>
            <AttitudeIndicator
              roll={attitude?.roll   ?? 0}
              pitch={attitude?.pitch ?? 0}
              yaw={attitude?.yaw     ?? 0}
            />
          </div>
          <GpsPanel position={drone.position ?? null} gpsRaw={gpsRaw} />
        </div>

        {/* Centre: Motor vibration */}
        <MotorVibPanel vibeData={vibeNodes} composite={composite} />

        {/* Right: Battery · Alerts · Message types */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
          <BatteryPanel pct={battPct} voltage={battV} current={battA} />
          <AlertsPanel  alerts={drone.alerts ?? []} />
          <MsgTypesPanel telemetry={telem} />
        </div>
      </div>

      {/* ── Row 4: Packet log ── */}
      <PacketLog log={packetLog} rate={pktRate} />
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const panelTitle = {
  fontSize: 8,
  fontFamily: 'JetBrains Mono, monospace',
  fontWeight: 700,
  letterSpacing: '0.16em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
}
