import React from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import useDroneStore from '../store/useDroneStore'
import ScoreBar from '../components/ScoreBar'

const SUBSYSTEMS = [
  { key: 'pwr', label: 'PWR', color: 'var(--pwr)' },
  { key: 'imu', label: 'IMU', color: 'var(--imu)' },
  { key: 'ekf', label: 'EKF', color: 'var(--ekf)' },
  { key: 'gps', label: 'GPS', color: 'var(--gps)' },
  { key: 'ctl', label: 'CTL', color: 'var(--ctl)' },
  { key: 'mot', label: 'MOT', color: 'var(--mot)' },
  { key: 'com', label: 'COM', color: 'var(--com)' },
]

function scoreColor(s) {
  if (s >= 85) return '#00ff88'
  if (s >= 70) return '#44dd88'
  if (s >= 50) return '#ffaa00'
  if (s >= 30) return '#ff7700'
  return '#ff3d3d'
}

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function DroneCard({ drone, isActive, onClick }) {
  const composite = drone.scores?.composite ?? 0
  const alertCount = drone.alerts?.length ?? 0
  const color = scoreColor(composite)

  return (
    <div
      className={`drone-card${isActive ? ' active' : ''}`}
      onClick={onClick}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className={`status-dot ${drone.connected ? 'online' : 'offline'}`}
          />
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: '0.06em',
              color: 'var(--text)',
            }}
          >
            {drone.id}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {alertCount > 0 && (
            <span className="alert-badge">{alertCount}</span>
          )}
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              letterSpacing: '0.08em',
              color: drone.connected ? 'var(--green)' : 'var(--text-dim)',
              textTransform: 'uppercase',
            }}
          >
            {drone.connected ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </div>

      {/* Composite score */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          marginBottom: 16,
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 40,
            fontWeight: 700,
            color,
            lineHeight: 1,
            transition: 'color 0.4s',
          }}
        >
          {Math.round(composite)}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.1em',
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
            paddingBottom: 6,
          }}
        >
          COMPOSITE
        </span>
      </div>

      {/* Score bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {SUBSYSTEMS.map(({ key, label, color: c }) => (
          <ScoreBar
            key={key}
            label={label}
            score={drone.scores?.[key] ?? 0}
            color={c}
          />
        ))}
      </div>

      {/* Footer */}
      {!drone.connected && drone.lastSeen && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px solid var(--border)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            color: 'var(--text-dim)',
            letterSpacing: '0.06em',
          }}
        >
          LAST SEEN {formatTime(drone.lastSeen)}
        </div>
      )}
    </div>
  )
}

export default function FleetPage() {
  const drones = useDroneStore((state) => state.drones)
  const activeDroneId = useDroneStore((state) => state.activeDroneId)
  const setActiveDrone = useDroneStore((state) => state.setActiveDrone)
  const navigate = useNavigate()

  const droneList = Object.values(drones)
  const count = droneList.length

  function handleCardClick(drone) {
    setActiveDrone(drone.id)
    navigate(`/detail/${drone.id}`)
  }

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <span className="page-title">Fleet Overview</span>
        <span className="page-count">{count} DRONE{count !== 1 ? 'S' : ''}</span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            letterSpacing: '0.08em',
            color: 'var(--text-dim)',
          }}
        >
          {count > 0
            ? `${droneList.filter((d) => d.connected).length} ONLINE`
            : ''}
        </span>
      </div>

      {/* Empty state */}
      {count === 0 && (
        <div className="empty-state">
          <RefreshCw size={32} className="spin" style={{ color: 'var(--text-dim)' }} />
          <span>Awaiting Drone Connection</span>
          <span
            style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.06em' }}
          >
            Listening on WebSocket...
          </span>
        </div>
      )}

      {/* Fleet grid */}
      {count > 0 && (
        <div className="fleet-grid">
          {droneList.map((drone) => (
            <DroneCard
              key={drone.id}
              drone={drone}
              isActive={drone.id === activeDroneId}
              onClick={() => handleCardClick(drone)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
