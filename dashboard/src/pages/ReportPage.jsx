/**
 * ReportPage.jsx — Printable HTML/PDF flight report.
 *
 * Fetches the comprehensive /flights/{id}/report data bundle and renders
 * a clean print-ready layout. A "Print / Save as PDF" button triggers the
 * browser print dialog (Ctrl+P / Cmd+P shortcut works too).
 *
 * Print media query hides navigation and controls automatically.
 */

import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Printer, ChevronLeft, AlertTriangle, CheckCircle, XCircle } from 'lucide-react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8081'

const SCORE_KEYS = ['composite', 'pwr', 'imu', 'ekf', 'gps', 'ctl', 'mot', 'com']
const SCORE_COLORS = {
  composite: '#4488ff',
  pwr: '#f59e0b',
  imu: '#a78bfa',
  ekf: '#34d399',
  gps: '#22d3ee',
  ctl: '#fb923c',
  mot: '#f472b6',
  com: '#94a3b8',
}
const SCORE_LABELS = {
  composite: 'Overall',
  pwr: 'Power',
  imu: 'IMU',
  ekf: 'Navigation',
  gps: 'GPS',
  ctl: 'Control',
  mot: 'Motors',
  com: 'Comms',
}

const TAG_COLORS = {
  night_flight:    '#6366f1',
  high_speed:      '#f59e0b',
  low_battery:     '#ef4444',
  high_altitude:   '#06b6d4',
  long_flight:     '#10b981',
  extended_flight: '#059669',
  battery_warning: '#f97316',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtDuration(s) {
  if (s == null) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m > 0 ? `${m} min ${sec} sec` : `${sec} sec`
}

function fmtDist(m) {
  if (m == null) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

function scoreColor(v) {
  if (v == null) return '#6b7280'
  if (v >= 75) return '#10b981'
  if (v >= 50) return '#f59e0b'
  return '#ef4444'
}

function scoreLabel(v) {
  if (v == null) return 'N/A'
  if (v >= 75) return 'GOOD'
  if (v >= 50) return 'CAUTION'
  return 'CRITICAL'
}

function parseTags(raw) {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

// ── Inline SVG sparkline for print-friendly chart ─────────────────────────────

function PrintSparkline({ data, color, height = 60 }) {
  if (!data || data.length < 2) return null
  const W = 600, H = height, pad = 4
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (W - pad * 2)
    const y = H - pad - (Math.max(0, Math.min(100, v ?? 0)) / 100) * (H - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  // Area fill
  const first = pts.split(' ')[0]
  const last = pts.split(' ').slice(-1)[0]
  const [lx] = last.split(',')
  const areaPath = `M${first} L${pts.split(' ').join(' L')} L${lx},${H - pad} L${pad},${H - pad} Z`

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
      <path d={areaPath} fill={color} fillOpacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ── Score tile ────────────────────────────────────────────────────────────────

function ScoreTile({ label, value, color }) {
  const sColor = scoreColor(value)
  return (
    <div style={{
      border: `1px solid ${sColor}33`,
      borderRadius: 8,
      padding: '12px 14px',
      background: `${sColor}08`,
      textAlign: 'center',
      minWidth: 90,
      flex: 1,
    }}>
      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: sColor, fontVariantNumeric: 'tabular-nums', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>
        {value != null ? Math.round(value) : '—'}
      </div>
      <div style={{ fontSize: 9, color: sColor, fontWeight: 700, marginTop: 4, letterSpacing: '0.06em' }}>
        {scoreLabel(value)}
      </div>
    </div>
  )
}

// ── Alert row ─────────────────────────────────────────────────────────────────

function AlertRow({ alert }) {
  const isCrit = alert.level === 'critical'
  const Icon = isCrit ? XCircle : AlertTriangle
  const color = isCrit ? '#ef4444' : '#f59e0b'
  const ts = alert.ts
    ? new Date(alert.ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f3f4f610' }}>
      <Icon size={14} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: 11, color, fontWeight: 700, minWidth: 80, fontFamily: "'JetBrains Mono', monospace" }}>
        {alert.code}
      </span>
      <span style={{ fontSize: 11, color: '#9ca3af', flex: 1 }}>
        {isCrit ? 'CRITICAL' : 'WARNING'}
        {alert.value != null && ` · value=${alert.value.toFixed(1)}`}
      </span>
      <span style={{ fontSize: 10, color: '#6b7280', fontFamily: "'JetBrains Mono', monospace" }}>
        {ts}
      </span>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportPage() {
  const { flightId } = useParams()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!flightId) return
    fetch(`${API}/flights/${flightId}/report`)
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [flightId])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--text-muted)', fontSize: 14 }}>
        Generating report…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 40, color: 'var(--red)', fontSize: 13 }}>
        <strong>Error:</strong> {error}
        <br />
        <button onClick={() => navigate('/logs')} style={backBtnStyle}>← Back</button>
      </div>
    )
  }

  if (!data) return null

  const { flight, final_scores, alert_count, alerts, distance_m, gps_point_count, score_timeline } = data
  const tags = parseTags(flight.tags)
  const overallScore = final_scores?.composite

  return (
    <>
      {/* Print-only / screen styles */}
      <style>{`
        @media print {
          .report-no-print { display: none !important; }
          body { background: #fff !important; color: #111 !important; }
          .report-page { padding: 0 !important; max-width: 100% !important; box-shadow: none !important; }
        }
        @page { size: A4; margin: 16mm; }
      `}</style>

      {/* Screen nav bar — hidden on print */}
      <div className="report-no-print" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={() => navigate('/logs')} style={backBtnStyle}>
          <ChevronLeft size={14} /> Logs
        </button>
        <button
          onClick={() => window.print()}
          style={{ ...backBtnStyle, background: 'var(--blue)', color: '#fff', border: 'none', marginLeft: 'auto' }}
        >
          <Printer size={14} /> Print / Save PDF
        </button>
      </div>

      {/* Report body */}
      <div className="report-page" style={{ maxWidth: 780, margin: '0 auto', fontFamily: 'system-ui, sans-serif', color: 'var(--text)', fontSize: 13 }}>

        {/* Header */}
        <div style={{ borderBottom: '2px solid #4488ff', paddingBottom: 16, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                DronePulse · Flight Report
              </div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text)', lineHeight: 1.2 }}>
                Flight #{flight.id}
              </h1>
              <div style={{ marginTop: 4, fontSize: 13, color: '#9ca3af' }}>
                Drone: <strong style={{ color: 'var(--text)' }}>{flight.drone_id}</strong>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Start time</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{fmtTs(flight.start_ts)}</div>
              {tags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6, justifyContent: 'flex-end' }}>
                  {tags.map((tag) => (
                    <span key={tag} style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: TAG_COLORS[tag] || '#374151', color: '#fff', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {tag.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Key metrics row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginBottom: 28 }}>
          {[
            { label: 'Duration', value: fmtDuration(flight.duration_s) },
            { label: 'Distance', value: fmtDist(distance_m) },
            { label: 'Max Altitude', value: flight.max_alt_m != null ? `${flight.max_alt_m.toFixed(1)} m` : '—' },
            { label: 'Max Speed', value: flight.max_speed != null ? `${flight.max_speed.toFixed(1)} m/s` : '—' },
            { label: 'Min Battery', value: flight.min_battery != null ? `${Math.round(flight.min_battery)}%` : '—' },
            { label: 'GPS Points', value: gps_point_count.toLocaleString() },
            { label: 'Alerts', value: alert_count },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
                {label}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontFamily: "'JetBrains Mono', monospace" }}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* Health scores */}
        <section style={{ marginBottom: 28 }}>
          <SectionTitle>Health Scores (End of Flight)</SectionTitle>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {SCORE_KEYS.map((k) => (
              <ScoreTile
                key={k}
                label={SCORE_LABELS[k]}
                value={final_scores?.[k] ?? null}
                color={SCORE_COLORS[k]}
              />
            ))}
          </div>
        </section>

        {/* Score timeline chart */}
        {score_timeline.length > 1 && (
          <section style={{ marginBottom: 28 }}>
            <SectionTitle>Composite Health Over Flight</SectionTitle>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px' }}>
              {/* Y-axis labels */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 9, color: '#6b7280' }}>100</span>
                <span style={{ fontSize: 9, color: '#6b7280' }}>50</span>
                <span style={{ fontSize: 9, color: '#6b7280' }}>0</span>
              </div>
              <PrintSparkline
                data={score_timeline.map((s) => s.composite)}
                color={SCORE_COLORS.composite}
                height={70}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 9, color: '#6b7280' }}>Start</span>
                <span style={{ fontSize: 9, color: '#6b7280' }}>End</span>
              </div>
            </div>

            {/* Power line */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginTop: 8 }}>
              <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                Power Health
              </div>
              <PrintSparkline
                data={score_timeline.map((s) => s.pwr)}
                color={SCORE_COLORS.pwr}
                height={50}
              />
            </div>
          </section>
        )}

        {/* Alerts */}
        <section style={{ marginBottom: 28 }}>
          <SectionTitle>
            Alert Log
            <span style={{ marginLeft: 10, fontSize: 11, color: alert_count === 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
              {alert_count === 0 ? '✓ No alerts' : `${alert_count} alert${alert_count !== 1 ? 's' : ''}`}
            </span>
          </SectionTitle>

          {alerts.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: '#10b98110', border: '1px solid #10b98130', borderRadius: 8 }}>
              <CheckCircle size={16} style={{ color: '#10b981' }} />
              <span style={{ fontSize: 13, color: '#10b981' }}>Flight completed with no health alerts.</span>
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 16px' }}>
              {alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
            </div>
          )}
        </section>

        {/* Footer */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', justifyContent: 'space-between', color: '#6b7280', fontSize: 10 }}>
          <span>DronePulse Automated Report</span>
          <span>Generated {new Date().toLocaleString()}</span>
        </div>
      </div>
    </>
  )
}

// ── Section title ─────────────────────────────────────────────────────────────

function SectionTitle({ children }) {
  return (
    <h2 style={{ margin: '0 0 12px', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: 8 }}>
      {children}
    </h2>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const backBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  borderRadius: 6,
  padding: '5px 12px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
}
