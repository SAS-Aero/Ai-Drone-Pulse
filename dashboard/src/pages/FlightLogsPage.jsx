import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, Download, ChevronDown, ChevronRight, RefreshCw, FileJson, FileText, Play, Printer, Map } from 'lucide-react'
import useDroneStore from '../store/useDroneStore'

// Point this at the storage API. Override with VITE_API_URL env var at build time.
const API = import.meta.env.VITE_API_URL || 'http://localhost:8081'

const SCORE_KEYS = ['composite', 'pwr', 'imu', 'ekf', 'gps', 'ctl', 'mot', 'com']
const SCORE_COLORS = {
  composite: 'var(--blue)',
  pwr: 'var(--pwr)',
  imu: 'var(--imu)',
  ekf: 'var(--ekf)',
  gps: 'var(--gps)',
  ctl: 'var(--ctl)',
  mot: 'var(--mot)',
  com: 'var(--com)',
}

const TAG_COLORS = {
  night_flight: '#6366f1',
  high_speed:   '#f59e0b',
  low_battery:  '#ef4444',
  high_altitude:'#06b6d4',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(s) {
  if (s == null) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

function parseTags(raw) {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

function scoreColor(v) {
  if (v == null) return 'var(--text-muted)'
  if (v >= 75) return 'var(--green)'
  if (v >= 50) return 'var(--amber)'
  return 'var(--red)'
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ data, color }) {
  if (!data || data.length < 2) return null
  const W = 500, H = 50, pad = 3
  const pts = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (W - pad * 2)
      const y = H - pad - (Math.max(0, Math.min(100, v ?? 0)) / 100) * (H - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={W} height={H} style={{ display: 'block', maxWidth: '100%', overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

// ── Expanded row — score detail ───────────────────────────────────────────────

function FlightDetail({ flightId }) {
  const [scores, setScores] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API}/flights/${flightId}/scores`)
      .then((r) => r.json())
      .then(setScores)
      .catch(() => setScores([]))
      .finally(() => setLoading(false))
  }, [flightId])

  if (loading) return <p style={mutedText}>Loading scores…</p>
  if (!scores || scores.length === 0) return <p style={mutedText}>No score data for this flight.</p>

  const last = scores[scores.length - 1]

  return (
    <div style={{ paddingTop: 12 }}>
      {/* Final score chips */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        {SCORE_KEYS.map((k) => (
          <div key={k} style={{ textAlign: 'center', minWidth: 52 }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              {k}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: SCORE_COLORS[k], fontVariantNumeric: 'tabular-nums' }}>
              {last[k] != null ? last[k].toFixed(1) : '—'}
            </div>
          </div>
        ))}
        <div style={{ textAlign: 'right', marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
          {scores.length} score snapshots
        </div>
      </div>

      {/* Composite health over flight */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Composite health over flight
        </div>
        <Sparkline data={scores.map((s) => s.composite)} color={SCORE_COLORS.composite} />
      </div>

      {/* Power subscore */}
      <div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Power health over flight
        </div>
        <Sparkline data={scores.map((s) => s.pwr)} color={SCORE_COLORS.pwr} />
      </div>
    </div>
  )
}

// ── Download helpers ──────────────────────────────────────────────────────────

async function downloadJSON(flight, setDownloading) {
  setDownloading(`json-${flight.id}`)
  try {
    const [scoresRes, pathRes] = await Promise.all([
      fetch(`${API}/flights/${flight.id}/scores`),
      fetch(`${API}/flights/${flight.id}/path`),
    ])
    const payload = {
      flight,
      scores: scoresRes.ok ? await scoresRes.json() : [],
      gps_path: pathRes.ok ? await pathRes.json() : [],
      exported_at: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    triggerDownload(blob, `flight_${flight.id}_${flight.drone_id}.json`)
  } finally {
    setDownloading(null)
  }
}

function downloadCSV(flight, scores) {
  const headers = ['ts', 'composite', 'pwr', 'imu', 'ekf', 'gps', 'ctl', 'mot', 'com']
  const rows = scores.map((s) => headers.map((h) => s[h] ?? '').join(','))
  const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' })
  triggerDownload(blob, `flight_${flight.id}_${flight.drone_id}_scores.csv`)
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function downloadGPX(flight, setDownloading) {
  setDownloading(`gpx-${flight.id}`)
  try {
    const res = await fetch(`${API}/flights/${flight.id}/export/gpx`)
    if (!res.ok) throw new Error(`API ${res.status}`)
    const blob = await res.blob()
    triggerDownload(blob, `flight_${flight.id}_${flight.drone_id}.gpx`)
  } finally {
    setDownloading(null)
  }
}

async function downloadKML(flight, setDownloading) {
  setDownloading(`kml-${flight.id}`)
  try {
    const res = await fetch(`${API}/flights/${flight.id}/export/kml`)
    if (!res.ok) throw new Error(`API ${res.status}`)
    const blob = await res.blob()
    triggerDownload(blob, `flight_${flight.id}_${flight.drone_id}.kml`)
  } finally {
    setDownloading(null)
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FlightLogsPage() {
  const navigate = useNavigate()
  const drones = useDroneStore((s) => s.drones)
  const droneIds = Object.keys(drones).sort()

  const [flights, setFlights] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filterDrone, setFilterDrone] = useState('')
  const [expanded, setExpanded] = useState(null)        // currently expanded flight id
  const [expandedScores, setExpandedScores] = useState({}) // cache {flightId: [...]}
  const [downloading, setDownloading] = useState(null)

  const fetchFlights = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (filterDrone) params.set('drone_id', filterDrone)
      const res = await fetch(`${API}/flights?${params}`)
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      setFlights(await res.json())
    } catch (e) {
      setError(`Cannot reach storage API at ${API} — is it running? (${e.message})`)
    } finally {
      setLoading(false)
    }
  }, [filterDrone])

  useEffect(() => { fetchFlights() }, [fetchFlights])

  const toggleRow = (flight) => {
    if (expanded === flight.id) {
      setExpanded(null)
      return
    }
    setExpanded(flight.id)
  }

  // Cache scores for CSV download when a row is expanded
  const onScoresCached = (flightId, scores) => {
    setExpandedScores((prev) => ({ ...prev, [flightId]: scores }))
  }

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <Database size={16} style={{ color: 'var(--blue)' }} />
        <span className="page-title">Flight Logs</span>
        <span className="page-count">{flights.length} FLIGHTS</span>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <select
          value={filterDrone}
          onChange={(e) => setFilterDrone(e.target.value)}
          style={selectStyle}
        >
          <option value="">All Drones</option>
          {droneIds.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>

        <button onClick={fetchFlights} style={iconBtnStyle} title="Refresh">
          <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>

        {error && (
          <span style={{ fontSize: 12, color: 'var(--red)', maxWidth: 500 }}>{error}</span>
        )}
      </div>

      {/* Empty state */}
      {!loading && flights.length === 0 && !error && (
        <div className="empty-state" style={{ paddingTop: 80 }}>
          <Database size={40} style={{ color: 'var(--text-dim)', opacity: 0.5 }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No completed flights found.</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', letterSpacing: '0.06em' }}>
            Flights are logged automatically and closed after 30 s of silence.
          </span>
        </div>
      )}

      {/* Table */}
      {flights.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                {['', 'Drone', 'Date', 'Duration', 'Max Alt', 'Max Speed', 'Min Bat', 'Tags', 'Actions'].map((h) => (
                  <th key={h || 'expand'} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flights.map((f) => (
                <React.Fragment key={f.id}>
                  <tr
                    onClick={() => toggleRow(f)}
                    style={{
                      cursor: 'pointer',
                      background: expanded === f.id ? 'rgba(68,136,255,0.06)' : 'transparent',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { if (expanded !== f.id) e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = expanded === f.id ? 'rgba(68,136,255,0.06)' : 'transparent' }}
                  >
                    {/* Expand icon */}
                    <td style={{ ...tdStyle, width: 24, color: 'var(--text-dim)' }}>
                      {expanded === f.id
                        ? <ChevronDown size={13} />
                        : <ChevronRight size={13} />}
                    </td>

                    {/* Drone ID */}
                    <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>
                      {f.drone_id}
                    </td>

                    {/* Date */}
                    <td style={{ ...tdStyle, color: 'var(--text-muted)', fontSize: 12 }}>
                      {fmtTs(f.start_ts)}
                    </td>

                    {/* Duration */}
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtDuration(f.duration_s)}
                    </td>

                    {/* Max alt */}
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                      {f.max_alt_m != null ? `${f.max_alt_m.toFixed(1)} m` : '—'}
                    </td>

                    {/* Max speed */}
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                      {f.max_speed != null ? `${f.max_speed.toFixed(1)} m/s` : '—'}
                    </td>

                    {/* Min battery */}
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', color: f.min_battery != null && f.min_battery < 30 ? 'var(--red)' : 'inherit' }}>
                      {f.min_battery != null ? `${Math.round(f.min_battery)}%` : '—'}
                    </td>

                    {/* Tags */}
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {parseTags(f.tags).map((tag) => (
                          <span key={tag} style={{ ...tagBadge, background: TAG_COLORS[tag] || 'var(--border2)' }}>
                            {tag.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    </td>

                    {/* Actions */}
                    <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {/* Replay */}
                        <button
                          onClick={() => navigate(`/replay/${f.id}`)}
                          style={dlBtnStyle}
                          title="Replay this flight"
                        >
                          <Play size={11} />
                          Replay
                        </button>

                        {/* Report */}
                        <button
                          onClick={() => navigate(`/report/${f.id}`)}
                          style={dlBtnStyle}
                          title="View printable flight report"
                        >
                          <Printer size={11} />
                          Report
                        </button>

                        {/* JSON */}
                        <button
                          onClick={() => downloadJSON(f, setDownloading)}
                          disabled={downloading === `json-${f.id}`}
                          style={dlBtnStyle}
                          title="Download full flight data as JSON"
                        >
                          <FileJson size={11} />
                          {downloading === `json-${f.id}` ? '…' : 'JSON'}
                        </button>

                        {/* CSV */}
                        <button
                          onClick={() => expandedScores[f.id] && downloadCSV(f, expandedScores[f.id])}
                          disabled={!expandedScores[f.id]}
                          style={{ ...dlBtnStyle, opacity: expandedScores[f.id] ? 1 : 0.35 }}
                          title={expandedScores[f.id] ? 'Download score history as CSV' : 'Expand row first to load scores'}
                        >
                          <FileText size={11} />
                          CSV
                        </button>

                        {/* GPX */}
                        <button
                          onClick={() => downloadGPX(f, setDownloading)}
                          disabled={downloading === `gpx-${f.id}`}
                          style={dlBtnStyle}
                          title="Download GPS path as GPX (Garmin / Strava compatible)"
                        >
                          <Map size={11} />
                          {downloading === `gpx-${f.id}` ? '…' : 'GPX'}
                        </button>

                        {/* KML */}
                        <button
                          onClick={() => downloadKML(f, setDownloading)}
                          disabled={downloading === `kml-${f.id}`}
                          style={dlBtnStyle}
                          title="Download GPS path as KML (Google Earth compatible)"
                        >
                          <Download size={11} />
                          {downloading === `kml-${f.id}` ? '…' : 'KML'}
                        </button>
                      </div>
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expanded === f.id && (
                    <tr>
                      <td colSpan={9} style={{ padding: '4px 40px 20px 40px', borderBottom: `1px solid var(--border)`, background: 'rgba(68,136,255,0.03)' }}>
                        <ScoreDetailRow
                          flightId={f.id}
                          onScoresLoaded={(scores) => onScoresCached(f.id, scores)}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Score detail row (loaded lazily when expanded) ────────────────────────────

function ScoreDetailRow({ flightId, onScoresLoaded }) {
  const [scores, setScores] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API}/flights/${flightId}/scores`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setScores(data)
        onScoresLoaded(data)
      })
      .catch(() => setScores([]))
      .finally(() => setLoading(false))
  }, [flightId, onScoresLoaded])

  if (loading) return <p style={mutedText}>Loading scores…</p>
  if (!scores || scores.length === 0) return <p style={mutedText}>No score data recorded for this flight.</p>

  const last = scores[scores.length - 1]

  return (
    <div style={{ paddingTop: 14 }}>
      {/* Final score summary */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 18 }}>
        {SCORE_KEYS.map((k) => (
          <div key={k} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              {k}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: scoreColor(last[k]), fontVariantNumeric: 'tabular-nums', fontFamily: "'JetBrains Mono', monospace" }}>
              {last[k] != null ? last[k].toFixed(1) : '—'}
            </div>
          </div>
        ))}
        <div style={{ marginLeft: 'auto', alignSelf: 'flex-end', fontSize: 10, color: 'var(--text-dim)' }}>
          {scores.length} snapshots
        </div>
      </div>

      {/* Composite sparkline */}
      <ChartRow label="Composite" data={scores.map((s) => s.composite)} color={SCORE_COLORS.composite} />
      <ChartRow label="Power" data={scores.map((s) => s.pwr)} color={SCORE_COLORS.pwr} />
    </div>
  )
}

function ChartRow({ label, data, color }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
        {label}
      </div>
      <Sparkline data={data} color={color} />
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
}

const thStyle = {
  padding: '6px 10px',
  textAlign: 'left',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 9,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 400,
}

const tdStyle = {
  padding: '9px 10px',
  borderBottom: '1px solid rgba(255,255,255,0.03)',
  verticalAlign: 'middle',
  fontSize: 13,
}

const tagBadge = {
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 10,
  color: '#fff',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
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

const iconBtnStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  borderRadius: 6,
  padding: '5px 8px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
}

const dlBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  borderRadius: 4,
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
  fontFamily: "'JetBrains Mono', monospace",
}

const mutedText = {
  fontSize: 12,
  color: 'var(--text-muted)',
  padding: '8px 0',
}

// Inject spin keyframe once
if (typeof document !== 'undefined' && !document.getElementById('fl-spin-style')) {
  const s = document.createElement('style')
  s.id = 'fl-spin-style'
  s.textContent = '@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }'
  document.head.appendChild(s)
}
