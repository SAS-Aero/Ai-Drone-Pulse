import React, { useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts'
import useDroneStore from '../store/useDroneStore'

// ── Score helpers ─────────────────────────────────────────────────────────────

function scoreColor(s) {
  if (s >= 85) return '#00ff88'
  if (s >= 70) return '#44dd88'
  if (s >= 50) return '#ffaa00'
  if (s >= 30) return '#ff7700'
  return '#ff3d3d'
}

function scoreTier(s) {
  if (s >= 85) return 'NOMINAL'
  if (s >= 70) return 'GOOD'
  if (s >= 50) return 'DEGRADED'
  if (s >= 30) return 'POOR'
  return 'CRITICAL'
}

// ── Subsystem config ──────────────────────────────────────────────────────────

const SUBSYSTEMS = [
  { id: 'pwr', name: 'Power',   color: 'var(--pwr)' },
  { id: 'imu', name: 'IMU',     color: 'var(--imu)' },
  { id: 'ekf', name: 'EKF',     color: 'var(--ekf)' },
  { id: 'gps', name: 'GPS',     color: 'var(--gps)' },
  { id: 'ctl', name: 'Control', color: 'var(--ctl)' },
  { id: 'mot', name: 'Motors',  color: 'var(--mot)' },
  { id: 'com', name: 'Comms',   color: 'var(--com)' },
]

// ── Attitude Indicator ────────────────────────────────────────────────────────

function AttitudeIndicator({ roll = 0, pitch = 0 }) {
  const rollDeg  = (roll  * 180) / Math.PI
  const pitchDeg = (pitch * 180) / Math.PI
  const pitchPx  = pitchDeg * 1.8

  return (
    <div style={{
      width: 148, height: 148,
      borderRadius: '50%',
      overflow: 'hidden',
      border: '2px solid rgba(255,255,255,0.10)',
      position: 'relative',
      flexShrink: 0,
      margin: '0 auto',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        transform: `rotate(${rollDeg}deg)`,
        transformOrigin: 'center center',
      }}>
        <div style={{
          position: 'absolute', left: 0, right: 0, top: 0,
          height: `calc(50% - ${pitchPx}px)`,
          background: 'linear-gradient(to bottom, #0a2a4a, #1a4a7a)',
        }} />
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          height: `calc(50% + ${pitchPx}px)`,
          background: 'linear-gradient(to top, #3d1f00, #6b3a0f)',
        }} />
        <div style={{
          position: 'absolute', left: 0, right: 0,
          top: `calc(50% - ${pitchPx}px)`,
          height: 1,
          background: 'rgba(255,255,255,0.45)',
        }} />
      </div>
      {/* Fixed crosshair */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{ position: 'relative', width: 80 }}>
          <div style={{ position: 'absolute', left: 0, top: '50%', width: 24, height: 2, background: '#ffaa00', transform: 'translateY(-50%)' }} />
          <div style={{ position: 'absolute', right: 0, top: '50%', width: 24, height: 2, background: '#ffaa00', transform: 'translateY(-50%)' }} />
          <div style={{
            position: 'absolute', left: '50%', top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 8, height: 8, borderRadius: '50%',
            border: '2px solid #ffaa00',
          }} />
        </div>
      </div>
    </div>
  )
}

// ── Compass ───────────────────────────────────────────────────────────────────

function Compass({ heading = 0 }) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const dir  = dirs[Math.round(heading / 45) % 8]
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>
        {String(Math.round(heading)).padStart(3, '0')}°
      </div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, letterSpacing: '0.14em', color: 'var(--text-muted)', marginTop: 4 }}>
        {dir}
      </div>
    </div>
  )
}

// ── Data row ─────────────────────────────────────────────────────────────────

function DataRow({ label, value, unit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: 'var(--text)', letterSpacing: '0.04em', textAlign: 'right' }}>
        {value !== null && value !== undefined ? (
          <>
            {value}
            {unit && <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 2 }}>{unit}</span>}
          </>
        ) : '—'}
      </span>
    </div>
  )
}

// ── Score ring (SVG arc, 220°) ────────────────────────────────────────────────

function ScoreRing({ score = 0, color, subsysColor }) {
  const size = 82, sw = 7, r = (size - sw) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (Math.min(100, Math.max(0, score)) / 100) * circ
  const cx = size / 2, cy = size / 2

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <filter id={`hud-glow-${Math.round(score)}-${subsysColor?.replace(/[^a-z]/gi,'')}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw} />
      <circle
        cx={cx} cy={cy} r={r} fill="none"
        stroke={color} strokeWidth={sw}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dashoffset 0.5s ease, stroke 0.4s ease' }}
      />
      <text x={cx} y={cy - 4} textAnchor="middle" dominantBaseline="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={22} fontWeight="700" fill={color}
        style={{ transition: 'fill 0.4s ease' }}>
        {Math.round(score)}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle"
        fontFamily="JetBrains Mono, monospace" fontSize={7} letterSpacing="1" fill="rgba(255,255,255,0.2)">
        /100
      </text>
      {subsysColor && (
        <circle cx={cx} cy={sw / 2} r={3} fill={subsysColor} opacity={0.9} />
      )}
    </svg>
  )
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ data, color, id }) {
  const chartData = useMemo(() => data.map((pt, i) => ({ i, v: Math.round(pt.v ?? pt) })), [data])
  if (!chartData.length) return (
    <div style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.08em' }}>NO DATA</span>
    </div>
  )
  const gradId = `spark-${id}`
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip content={({ active, payload }) =>
          active && payload?.length ? (
            <div style={{ background: 'var(--surface)', border: `1px solid ${color}40`, padding: '2px 6px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color }}>
              {payload[0].value}
            </div>
          ) : null
        } />
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#${gradId})`} dot={false} activeDot={{ r: 2, fill: color, stroke: 'none' }}
          isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// ── Subsystem card ────────────────────────────────────────────────────────────

function SubsystemCard({ id, name, color, score = 0, sparkData = [] }) {
  const c = scoreColor(score)
  const tier = scoreTier(score)
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      padding: '14px 12px 10px',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Left accent bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, width: 3, height: '100%',
        background: `linear-gradient(to bottom, ${c}, ${c}00)`, opacity: 0.8,
      }} />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'stretch', paddingLeft: 6 }}>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color, textTransform: 'uppercase' }}>
          {name}
        </span>
      </div>
      {/* Score ring */}
      <ScoreRing score={score} color={c} subsysColor={color} />
      {/* Tier badge */}
      <div style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700,
        letterSpacing: '0.14em', color: c,
        background: `${c}18`, border: `1px solid ${c}30`,
        padding: '2px 8px',
      }}>
        {tier}
      </div>
      {/* Sparkline */}
      <div style={{ width: '100%', marginTop: 2 }}>
        <Sparkline data={sparkData} color={color} id={id} />
      </div>
    </div>
  )
}

// ── Panel wrapper ─────────────────────────────────────────────────────────────

function Panel({ title, children, style }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
      {title && (
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700, letterSpacing: '0.16em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

// ── HUD Page ──────────────────────────────────────────────────────────────────

export default function HUDPage() {
  const drones       = useDroneStore((s) => s.drones)
  const activeDroneId = useDroneStore((s) => s.activeDroneId)
  const wsStatus     = useDroneStore((s) => s.wsStatus)
  const navigate     = useNavigate()

  // Pick drone: activeDroneId first, then first connected, then first available
  const droneId = activeDroneId
    || Object.values(drones).find((d) => d.connected)?.id
    || Object.keys(drones)[0]
    || null

  const drone = droneId ? drones[droneId] : null

  // History ref for sparklines (kept in component to survive re-renders)
  const histRef = useRef({})
  useEffect(() => {
    if (!drone) return
    SUBSYSTEMS.forEach(({ id }) => {
      histRef.current[id] = drone.history[id] || []
    })
  }, [drone])

  // ── No WS / no drone states ───────────────────────────────────────────────

  if (wsStatus === 'disconnected' || wsStatus === 'connecting') {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
        <span>{wsStatus === 'connecting' ? 'CONNECTING…' : 'NO CONNECTION'}</span>
        <span style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0 }}>
          Waiting for gateway WebSocket
        </span>
      </div>
    )
  }

  if (!drone) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
        <span>NO DRONE</span>
        <span style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0 }}>
          Awaiting drone connection
        </span>
      </div>
    )
  }

  // ── Extract telemetry ─────────────────────────────────────────────────────

  const telem    = drone.telemetry || {}
  const attitude = telem.ATTITUDE
  const gpsRaw   = telem.GPS_RAW_INT
  const vfrHud   = telem.VFR_HUD
  const sysStatus = telem.SYS_STATUS
  const scores   = drone.scores

  const rollDeg  = attitude ? ((attitude.roll  * 180) / Math.PI).toFixed(1) : null
  const pitchDeg = attitude ? ((attitude.pitch * 180) / Math.PI).toFixed(1) : null
  const altM     = vfrHud?.alt?.toFixed(1) ?? (gpsRaw ? (gpsRaw.alt / 1000).toFixed(1) : null)
  const sats     = gpsRaw?.satellites_visible ?? null
  const hdop     = gpsRaw ? (gpsRaw.eph / 100).toFixed(1) : null
  const lat      = gpsRaw ? (gpsRaw.lat / 1e7).toFixed(5) : null
  const lon      = gpsRaw ? (gpsRaw.lon / 1e7).toFixed(5) : null
  const battPct  = sysStatus?.battery_remaining ?? null
  const battV    = sysStatus?.voltage_battery ? (sysStatus.voltage_battery / 1000).toFixed(1) : null
  const heading  = vfrHud?.heading ?? 0

  const composite  = scores.composite ?? 50
  const compColor  = scoreColor(composite)
  const compTier   = scoreTier(composite)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'auto' }}>

      {/* Drone selector bar */}
      {Object.keys(drones).length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.values(drones).map((d) => (
            <button key={d.id} onClick={() => navigate(`/hud/${d.id}`)}
              style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                padding: '4px 12px', cursor: 'pointer', letterSpacing: '0.08em',
                background: d.id === droneId ? 'var(--blue)' : 'var(--surface)',
                border: `1px solid ${d.id === droneId ? 'var(--blue)' : 'var(--border)'}`,
                color: d.id === droneId ? '#fff' : 'var(--text-muted)',
              }}>
              {d.id}
            </button>
          ))}
        </div>
      )}

      {/* ── Top row: attitude / flight data / health ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>

        {/* Attitude */}
        <Panel title="Attitude">
          <AttitudeIndicator roll={attitude?.roll ?? 0} pitch={attitude?.pitch ?? 0} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <DataRow label="Roll"  value={rollDeg}  unit="°" />
            <DataRow label="Pitch" value={pitchDeg} unit="°" />
          </div>
        </Panel>

        {/* Flight data */}
        <Panel title="Flight Data">
          <DataRow label="Altitude"    value={altM}                                        unit="m"   />
          <DataRow label="Groundspeed" value={vfrHud?.groundspeed?.toFixed(1) ?? null}    unit="m/s" />
          <DataRow label="Airspeed"    value={vfrHud?.airspeed?.toFixed(1) ?? null}        unit="m/s" />
          <DataRow label="Climb"       value={vfrHud?.climb?.toFixed(1) ?? null}           unit="m/s" />
          <DataRow label="Throttle"    value={vfrHud?.throttle?.toFixed(0) ?? null}        unit="%"   />
          <DataRow label="Battery"     value={battPct !== null ? `${battPct}%` : null}    unit={battV ? `${battV}V` : undefined} />
          <DataRow label="GPS"         value={sats !== null ? `${sats} sats  HDOP ${hdop}` : null} />
          <DataRow label="Position"    value={lat !== null ? `${lat}, ${lon}` : null} />
          <div style={{ marginTop: 4, display: 'flex', justifyContent: 'center' }}>
            <Compass heading={heading} />
          </div>
        </Panel>

        {/* System health */}
        <Panel title={null} style={{ gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700, letterSpacing: '0.16em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              System Health
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="status-dot" style={{ background: drone.connected ? 'var(--green)' : 'var(--text-dim)', boxShadow: drone.connected ? '0 0 6px var(--green)' : 'none' }} />
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'var(--text-muted)' }}>{drone.id}</span>
            </span>
          </div>

          {/* Composite score ring */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
            <svg width="52" height="52" viewBox="0 0 52 52">
              <circle cx="26" cy="26" r="21" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
              <circle cx="26" cy="26" r="21" fill="none" stroke={compColor} strokeWidth="5"
                strokeDasharray={2 * Math.PI * 21}
                strokeDashoffset={2 * Math.PI * 21 * (1 - composite / 100)}
                strokeLinecap="round" transform="rotate(-90 26 26)"
                style={{ transition: 'stroke-dashoffset 0.5s ease, stroke 0.4s ease' }} />
              <text x="26" y="27" textAnchor="middle" dominantBaseline="middle"
                fontFamily="JetBrains Mono, monospace" fontSize="13" fontWeight="700" fill={compColor}>
                {Math.round(composite)}
              </text>
            </svg>
            <div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: compColor }}>{compTier}</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 8, color: 'var(--text-muted)', marginTop: 3 }}>COMPOSITE</div>
            </div>
          </div>

          {/* Per-subsystem score bars */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {SUBSYSTEMS.map(({ id, color }) => {
              const s = scores[id] ?? 50
              const c = scoreColor(s)
              return (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 7, letterSpacing: '0.1em', color: 'var(--text-dim)', width: 28, textTransform: 'uppercase' }}>{id}</span>
                  <div style={{ flex: 1, height: 3, background: 'var(--border2)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${s}%`, background: c, transition: 'width 0.4s ease, background 0.4s ease' }} />
                  </div>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'var(--text-muted)', width: 22, textAlign: 'right' }}>{Math.round(s)}</span>
                </div>
              )
            })}
          </div>
        </Panel>
      </div>

      {/* ── Subsystem cards row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 10 }}>
        {SUBSYSTEMS.map(({ id, name, color }) => (
          <SubsystemCard
            key={id} id={id} name={name} color={color}
            score={scores[id] ?? 50}
            sparkData={drone.history[id] || []}
          />
        ))}
      </div>

      {/* ── Alert feed ── */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: 0, flexShrink: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Alerts
            </span>
            {drone.alerts.length > 0 && (
              <span style={{ background: 'var(--red)', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, padding: '1px 6px', minWidth: 18, textAlign: 'center' }}>
                {drone.alerts.length}
              </span>
            )}
          </div>
        </div>

        {drone.alerts.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', gap: 8 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--green)', letterSpacing: '0.1em' }}>
              ✓ SYSTEM NOMINAL
            </span>
          </div>
        ) : (
          <div>
            {drone.alerts.map((alert, i) => (
              <div key={i} className={`alert-item ${alert.level === 'critical' ? 'critical' : 'warn'}`}>
                <span style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
                  padding: '2px 6px', letterSpacing: '0.08em',
                  color: alert.level === 'critical' ? 'var(--red)' : 'var(--amber)',
                  background: alert.level === 'critical' ? 'rgba(255,61,61,0.12)' : 'rgba(255,170,0,0.12)',
                  flexShrink: 0,
                }}>
                  {alert.level === 'critical' ? 'CRIT' : 'WARN'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.06em' }}>
                    {alert.code}
                  </div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                    {alert.message}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
