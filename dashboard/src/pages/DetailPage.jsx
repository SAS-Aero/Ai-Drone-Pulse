import React from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChevronLeft, AlertTriangle, Info } from 'lucide-react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import useDroneStore from '../store/useDroneStore'
import ArcGauge from '../components/ArcGauge'

const SUBSYSTEMS = [
  { key: 'pwr', label: 'Power', color: '#ffcc00' },
  { key: 'imu', label: 'IMU', color: '#00e5ff' },
  { key: 'ekf', label: 'EKF', color: '#a78bfa' },
  { key: 'gps', label: 'GPS', color: '#00ff88' },
  { key: 'ctl', label: 'Control', color: '#ff6b35' },
  { key: 'mot', label: 'Motors', color: '#39ff8f' },
  { key: 'com', label: 'Comms', color: '#ff4daa' },
  { key: 'composite', label: 'Composite', color: null }, // auto color
]

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatCoord(val, pos) {
  if (val === null || val === undefined) return '—'
  const abs = Math.abs(val).toFixed(5)
  if (pos === 'lat') return `${abs}° ${val >= 0 ? 'N' : 'S'}`
  return `${abs}° ${val >= 0 ? 'E' : 'W'}`
}

// Build chart data from history arrays
function buildChartData(history) {
  // Find the longest array
  const keys = Object.keys(history)
  if (!keys.length) return []

  // Use composite as the time reference (or whichever is longest)
  const ref = history.composite || history.pwr || []
  if (!ref.length) return []

  return ref.map((point, i) => {
    const row = { t: point.t, time: formatTime(point.t) }
    keys.forEach((k) => {
      const arr = history[k] || []
      row[k] = arr[i]?.v ?? null
    })
    return row
  })
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        padding: '10px 14px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      }}
    >
      <div style={{ color: 'var(--text-muted)', marginBottom: 6, fontSize: 10 }}>
        {label}
      </div>
      {payload.map((entry) => (
        <div
          key={entry.dataKey}
          style={{ color: entry.color, display: 'flex', justifyContent: 'space-between', gap: 16 }}
        >
          <span>{entry.dataKey.toUpperCase()}</span>
          <span>{entry.value !== null ? Math.round(entry.value) : '—'}</span>
        </div>
      ))}
    </div>
  )
}

export default function DetailPage() {
  const { droneId } = useParams()
  const navigate = useNavigate()
  const drone = useDroneStore((state) => state.drones[droneId])

  if (!drone) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        <AlertTriangle size={32} style={{ color: 'var(--red)' }} />
        <span>Drone Not Found</span>
        <span style={{ fontSize: 10, letterSpacing: '0.06em' }}>{droneId}</span>
        <button
          className="back-btn"
          onClick={() => navigate('/fleet')}
          style={{ marginTop: 12 }}
        >
          <ChevronLeft size={14} /> Back to Fleet
        </button>
      </div>
    )
  }

  const chartData = buildChartData(drone.history || {})

  return (
    <div>
      {/* Back + header */}
      <div style={{ marginBottom: 20 }}>
        <button className="back-btn" onClick={() => navigate('/fleet')}>
          <ChevronLeft size={14} />
          Fleet
        </button>
      </div>

      <div className="page-header" style={{ marginBottom: 20 }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'var(--text)',
          }}
        >
          {drone.id}
        </span>
        <span className={`status-dot ${drone.connected ? 'online' : 'offline'}`} />
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: drone.connected ? 'var(--green)' : 'var(--text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {drone.connected ? 'Online' : 'Offline'}
        </span>
        {!drone.connected && drone.lastSeen && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: 'var(--text-dim)',
              letterSpacing: '0.06em',
              marginLeft: 8,
            }}
          >
            Last seen {formatTime(drone.lastSeen)}
          </span>
        )}
        {drone.position && (
          <div style={{ flex: 1, textAlign: 'right' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: 'var(--text-muted)',
                letterSpacing: '0.06em',
              }}
            >
              {formatCoord(drone.position.lat, 'lat')} &nbsp;
              {formatCoord(drone.position.lng, 'lng')} &nbsp;
              {drone.position.alt !== null ? `${drone.position.alt.toFixed(1)}m` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Gauge grid */}
      <div className="gauge-grid" style={{ marginBottom: 24 }}>
        {SUBSYSTEMS.map(({ key, label, color }) => (
          <ArcGauge
            key={key}
            score={drone.scores?.[key] ?? 0}
            label={label}
            color={color || undefined}
            size={110}
          />
        ))}
      </div>

      {/* History Chart */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">
          Score History
          <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 400 }}>
            Last {chartData.length} points
          </span>
        </div>
        {chartData.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 200,
              color: 'var(--text-dim)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              letterSpacing: '0.08em',
            }}
          >
            NO DATA YET
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2530" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fill: '#6b7280' }}
                tickLine={false}
                axisLine={{ stroke: '#1e2530' }}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fill: '#6b7280' }}
                tickLine={false}
                axisLine={false}
                width={30}
                tickCount={6}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 9,
                  letterSpacing: '0.06em',
                }}
              />
              {SUBSYSTEMS.map(({ key, color }) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={color || '#4488ff'}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Alerts section */}
      <div className="panel">
        <div className="panel-header">
          Active Alerts
          {drone.alerts?.length > 0 && (
            <span className="alert-badge" style={{ marginLeft: 8 }}>
              {drone.alerts.length}
            </span>
          )}
        </div>

        {(!drone.alerts || drone.alerts.length === 0) ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--green)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              letterSpacing: '0.08em',
              padding: '12px 0',
            }}
          >
            <Info size={14} />
            SYSTEM NOMINAL
          </div>
        ) : (
          <div>
            {drone.alerts.map((alert, i) => {
              const severity = alert.severity?.toLowerCase() || 'warn'
              return (
                <div
                  key={alert.code ?? i}
                  className={`alert-item ${severity === 'critical' ? 'critical' : 'warn'}`}
                >
                  <span
                    className={`severity-badge ${severity === 'critical' ? 'critical' : 'warn'}`}
                  >
                    {severity === 'critical' ? 'CRIT' : 'WARN'}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        fontWeight: 700,
                        color: 'var(--text)',
                        marginBottom: 2,
                      }}
                    >
                      {alert.code || alert.type || 'UNKNOWN'}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-muted)',
                      }}
                    >
                      {alert.message || alert.msg || ''}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
