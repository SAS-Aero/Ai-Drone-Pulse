import React, { useState, useMemo } from 'react'
import { ShieldCheck } from 'lucide-react'
import useDroneStore from '../store/useDroneStore'

function AlertItem({ alert, droneId }) {
  const severity = alert.severity?.toLowerCase() || 'warn'
  const isCritical = severity === 'critical'

  return (
    <div className={`alert-item ${isCritical ? 'critical' : 'warn'}`}>
      <span className={`severity-badge ${isCritical ? 'critical' : 'warn'}`}>
        {isCritical ? 'CRIT' : 'WARN'}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--text)',
            }}
          >
            {alert.code || alert.type || 'UNKNOWN'}
          </span>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: 'var(--text-dim)',
              letterSpacing: '0.06em',
            }}
          >
            {droneId}
          </span>
        </div>
        {(alert.message || alert.msg) && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {alert.message || alert.msg}
          </div>
        )}
      </div>
    </div>
  )
}

export default function AlertsPage() {
  const drones = useDroneStore((state) => state.drones)
  const [filter, setFilter] = useState('all')

  // Gather all alerts grouped by drone
  const grouped = useMemo(() => {
    const result = []
    Object.values(drones).forEach((drone) => {
      const alerts = drone.alerts || []
      if (alerts.length === 0) return

      let filtered = alerts
      if (filter === 'critical') {
        filtered = alerts.filter(
          (a) => a.severity?.toLowerCase() === 'critical'
        )
      } else if (filter === 'warn') {
        filtered = alerts.filter(
          (a) => a.severity?.toLowerCase() !== 'critical'
        )
      }

      if (filtered.length === 0) return

      // Sort: critical first
      const sorted = [...filtered].sort((a, b) => {
        const aIsCrit = a.severity?.toLowerCase() === 'critical'
        const bIsCrit = b.severity?.toLowerCase() === 'critical'
        if (aIsCrit && !bIsCrit) return -1
        if (!aIsCrit && bIsCrit) return 1
        return 0
      })

      result.push({ droneId: drone.id, alerts: sorted, connected: drone.connected })
    })
    return result
  }, [drones, filter])

  const totalAlerts = useMemo(() => {
    return Object.values(drones).reduce((sum, d) => sum + (d.alerts?.length || 0), 0)
  }, [drones])

  const critCount = useMemo(() => {
    return Object.values(drones).reduce(
      (sum, d) =>
        sum +
        (d.alerts || []).filter((a) => a.severity?.toLowerCase() === 'critical').length,
      0
    )
  }, [drones])

  const warnCount = totalAlerts - critCount

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <span className="page-title">Alerts</span>
        <span className="page-count">
          {totalAlerts} ACTIVE
        </span>
        {critCount > 0 && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: 'var(--red)',
              letterSpacing: '0.06em',
            }}
          >
            {critCount} CRITICAL
          </span>
        )}
        {warnCount > 0 && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: 'var(--amber)',
              letterSpacing: '0.06em',
            }}
          >
            {warnCount} WARN
          </span>
        )}
      </div>

      {/* Filter tabs */}
      <div className="filter-tabs">
        {[
          { id: 'all', label: `ALL (${totalAlerts})` },
          { id: 'critical', label: `CRITICAL (${critCount})` },
          { id: 'warn', label: `WARN (${warnCount})` },
        ].map((tab) => (
          <button
            key={tab.id}
            className={`filter-tab${filter === tab.id ? ' active' : ''}`}
            onClick={() => setFilter(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Empty state — no alerts at all */}
      {totalAlerts === 0 && (
        <div
          className="empty-state"
          style={{ color: 'var(--green)', paddingTop: 80 }}
        >
          <ShieldCheck size={48} style={{ color: 'var(--green)', opacity: 0.8 }} />
          <span style={{ color: 'var(--green)', fontSize: 14, fontWeight: 700 }}>
            SYSTEM NOMINAL
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.06em' }}>
            No active alerts
          </span>
        </div>
      )}

      {/* Grouped alerts */}
      {grouped.length === 0 && totalAlerts > 0 && (
        <div className="empty-state">
          <span>No alerts match filter</span>
        </div>
      )}

      {grouped.map(({ droneId, alerts, connected }) => (
        <div key={droneId} className="drone-group">
          <div className="drone-group-header">
            <span className={`status-dot ${connected ? 'online' : 'offline'}`} />
            {droneId}
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: 'var(--text-dim)',
              }}
            >
              {alerts.length} ALERT{alerts.length !== 1 ? 'S' : ''}
            </span>
          </div>
          <div>
            {alerts.map((alert, i) => (
              <AlertItem key={i} alert={alert} droneId={droneId} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
