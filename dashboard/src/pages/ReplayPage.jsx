/**
 * ReplayPage.jsx — Flight replay with time scrubbing.
 *
 * Loads stored telemetry for a completed flight and replays it:
 *  • Map shows full GPS path as a polyline + animated current-position marker
 *  • Timeline slider scrubs through the flight at any point
 *  • Play / Pause with configurable speed (1×, 2×, 4×, 8×)
 *  • Score panel updates in sync with the replay position
 *  • Live telemetry values (alt, speed, heading, battery) shown at each frame
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  MapContainer,
  TileLayer,
  Polyline,
  Marker,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'
import {
  Play,
  Pause,
  SkipBack,
  ChevronLeft,
  Gauge,
  Navigation,
  BatteryMedium,
  MoveVertical,
} from 'lucide-react'

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

const SPEEDS = [1, 2, 4, 8]

// ── Fix Leaflet icon in bundler ───────────────────────────────────────────────
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function makeReplayIcon(color = '#4488ff') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="10" fill="${color}" fill-opacity="0.85" stroke="#fff" stroke-width="2"/>
    <circle cx="14" cy="14" r="4" fill="#0a0c0f"/>
    <line x1="14" y1="14" x2="5" y2="6"  stroke="${color}" stroke-width="1.5" opacity="0.6"/>
    <line x1="14" y1="14" x2="23" y2="6"  stroke="${color}" stroke-width="1.5" opacity="0.6"/>
    <line x1="14" y1="14" x2="5" y2="22" stroke="${color}" stroke-width="1.5" opacity="0.6"/>
    <line x1="14" y1="14" x2="23" y2="22" stroke="${color}" stroke-width="1.5" opacity="0.6"/>
  </svg>`
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

// Center map on first render to fit the full path
function FitPath({ path }) {
  const map = useMap()
  useEffect(() => {
    if (path.length < 2) return
    const bounds = L.latLngBounds(path.map((p) => [p.lat, p.lng]))
    map.fitBounds(bounds, { padding: [40, 40] })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(secs) {
  if (secs == null || isNaN(secs)) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function scoreColor(v) {
  if (v == null) return 'var(--text-muted)'
  if (v >= 75) return 'var(--green)'
  if (v >= 50) return 'var(--amber)'
  return 'var(--red)'
}

function fmtTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── ScoreBar ──────────────────────────────────────────────────────────────────

function ScoreBar({ label, value, color }) {
  const pct = Math.max(0, Math.min(100, value ?? 0))
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {label}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor(value), fontVariantNumeric: 'tabular-nums', fontFamily: "'JetBrains Mono', monospace" }}>
          {value != null ? value.toFixed(1) : '—'}
        </span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.1s linear' }} />
      </div>
    </div>
  )
}

// ── TelemetryCard ─────────────────────────────────────────────────────────────

function TelCard({ icon: Icon, label, value, unit, color = 'var(--text)' }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', minWidth: 100, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Icon size={13} style={{ color: 'var(--text-dim)' }} />
        <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', fontFamily: "'JetBrains Mono', monospace" }}>
        {value != null ? value : '—'}
        {value != null && unit && (
          <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 3 }}>{unit}</span>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReplayPage() {
  const { flightId } = useParams()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [path, setPath] = useState([])       // [{ts_ms, lat, lng, alt_m}]
  const [scores, setScores] = useState([])   // [{ts_s, composite, pwr, ...}]
  const [flightMeta, setFlightMeta] = useState(null)

  // Replay state
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [sliderVal, setSliderVal] = useState(0)   // 0–1000 integer

  const rafRef = useRef(null)
  const lastRealTs = useRef(null)
  const sliderRef = useRef(0)                      // mirror of sliderVal for RAF

  // ── Load data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!flightId) return
    setLoading(true)
    setError(null)

    Promise.all([
      fetch(`${API}/flights/${flightId}/path`).then((r) => {
        if (!r.ok) throw new Error(`Path API ${r.status}`)
        return r.json()
      }),
      fetch(`${API}/flights/${flightId}/scores`).then((r) => {
        if (!r.ok) throw new Error(`Scores API ${r.status}`)
        return r.json()
      }),
      fetch(`${API}/flights?limit=1000`).then((r) => r.json()),
    ])
      .then(([pathData, scoresData, flightsData]) => {
        // GPS_RAW_INT: lat/lon in 1e7 degrees, alt in mm, ts in ms
        const pts = pathData
          .filter((p) => p.lat != null && p.lon != null)
          .map((p) => ({
            ts_ms: p.ts,
            lat: p.lat / 1e7,
            lng: p.lon / 1e7,
            alt_m: p.alt != null ? p.alt / 1000 : 0,
          }))
        setPath(pts)
        setScores(scoresData)
        const meta = flightsData.find((f) => f.id === parseInt(flightId, 10))
        setFlightMeta(meta || null)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [flightId])

  // ── Derived current frame ──────────────────────────────────────────────────
  const currentPathIdx = Math.round((sliderVal / 1000) * Math.max(0, path.length - 1))
  const currentScoreIdx = Math.round((sliderVal / 1000) * Math.max(0, scores.length - 1))

  const currentPos = path[currentPathIdx] || null
  const currentScores = scores[currentScoreIdx] || null

  // VFR-like telemetry from stored path alt; speed/heading from metadata
  const flightDurationS = path.length > 1
    ? (path[path.length - 1].ts_ms - path[0].ts_ms) / 1000
    : 0
  const currentTimeS = (sliderVal / 1000) * flightDurationS

  // ── Playback RAF loop ──────────────────────────────────────────────────────
  const stopRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastRealTs.current = null
  }, [])

  const startRaf = useCallback(() => {
    stopRaf()
    const step = (now) => {
      if (lastRealTs.current === null) {
        lastRealTs.current = now
      }
      const deltaReal = (now - lastRealTs.current) / 1000 // real seconds
      lastRealTs.current = now

      // How much virtual time passes: deltaReal × speed
      // Map to slider units: totalSlider / flightDurationS × virtual_delta
      const advance = flightDurationS > 0
        ? (deltaReal * speed * 1000) / flightDurationS
        : 0

      const next = Math.min(1000, sliderRef.current + advance)
      sliderRef.current = next
      setSliderVal(Math.round(next))

      if (next >= 1000) {
        setPlaying(false)
        return
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
  }, [speed, flightDurationS, stopRaf])

  useEffect(() => {
    if (playing) {
      startRaf()
    } else {
      stopRaf()
    }
    return stopRaf
  }, [playing, startRaf, stopRaf])

  // Keep sliderRef in sync
  useEffect(() => {
    sliderRef.current = sliderVal
  }, [sliderVal])

  const handleSliderChange = (e) => {
    const v = parseInt(e.target.value, 10)
    sliderRef.current = v
    setSliderVal(v)
  }

  const handlePlayPause = () => {
    if (sliderVal >= 1000) {
      sliderRef.current = 0
      setSliderVal(0)
      setPlaying(true)
    } else {
      setPlaying((p) => !p)
    }
  }

  const handleReset = () => {
    setPlaying(false)
    sliderRef.current = 0
    setSliderVal(0)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--text-muted)', fontSize: 14 }}>
        Loading flight data…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 40, color: 'var(--red)', fontSize: 13 }}>
        <strong>Error:</strong> {error}
        <br />
        <button onClick={() => navigate('/logs')} style={{ marginTop: 16, ...backBtnStyle }}>
          ← Back to Flight Logs
        </button>
      </div>
    )
  }

  const replayIcon = makeReplayIcon(scoreColor(currentScores?.composite))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 38px)', overflow: 'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--bg)' }}>
        <button onClick={() => navigate('/logs')} style={backBtnStyle} title="Back to logs">
          <ChevronLeft size={14} />
          Logs
        </button>
        <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--text-muted)' }}>
          Flight <strong style={{ color: 'var(--text)' }}>#{flightId}</strong>
          {flightMeta && (
            <span style={{ color: 'var(--text-dim)', marginLeft: 10 }}>
              {flightMeta.drone_id} · {fmtTs(flightMeta.start_ts)}
            </span>
          )}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Speed</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              style={{ ...speedBtnStyle, background: speed === s ? 'var(--blue)' : 'var(--surface)', color: speed === s ? '#fff' : 'var(--text-muted)' }}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Map */}
        <div style={{ flex: 1, position: 'relative' }}>
          {path.length > 0 ? (
            <MapContainer
              center={path[0] ? [path[0].lat, path[0].lng] : [0, 0]}
              zoom={14}
              style={{ width: '100%', height: '100%' }}
              zoomControl
            >
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution='&copy; OpenStreetMap &copy; CARTO'
                subdomains="abcd"
                maxZoom={19}
              />
              <FitPath path={path} />

              {/* Full path polyline */}
              <Polyline
                positions={path.map((p) => [p.lat, p.lng])}
                pathOptions={{ color: '#2255aa', weight: 2, opacity: 0.5 }}
              />

              {/* Completed path in brighter colour */}
              {currentPathIdx > 0 && (
                <Polyline
                  positions={path.slice(0, currentPathIdx + 1).map((p) => [p.lat, p.lng])}
                  pathOptions={{ color: '#4488ff', weight: 3, opacity: 0.9 }}
                />
              )}

              {/* Current position marker */}
              {currentPos && (
                <Marker
                  position={[currentPos.lat, currentPos.lng]}
                  icon={replayIcon}
                />
              )}
            </MapContainer>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
              No GPS data for this flight.
            </div>
          )}

          {/* Time overlay */}
          <div style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 1000, background: 'rgba(10,12,15,0.85)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-muted)' }}>
            {fmtTime(currentTimeS)} / {fmtTime(flightDurationS)}
            {currentPos && (
              <span style={{ marginLeft: 14, color: 'var(--text-dim)' }}>
                ALT {currentPos.alt_m.toFixed(1)} m
              </span>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ width: 260, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', background: 'var(--bg)', overflowY: 'auto' }}>

          {/* Telemetry cards */}
          <div style={{ padding: '14px 12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <TelCard
              icon={MoveVertical}
              label="Altitude"
              value={currentPos ? currentPos.alt_m.toFixed(1) : null}
              unit="m"
            />
            <TelCard
              icon={BatteryMedium}
              label="Min Battery"
              value={flightMeta?.min_battery != null ? Math.round(flightMeta.min_battery) : null}
              unit="%"
              color={flightMeta?.min_battery != null && flightMeta.min_battery < 30 ? 'var(--red)' : 'var(--green)'}
            />
            {flightMeta?.max_speed != null && (
              <TelCard
                icon={Gauge}
                label="Max Speed"
                value={flightMeta.max_speed.toFixed(1)}
                unit="m/s"
              />
            )}
          </div>

          {/* Score bars */}
          <div style={{ padding: '16px 12px 8px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
              Health Scores @ {fmtTime(currentTimeS)}
            </div>
            {SCORE_KEYS.map((k) => (
              <ScoreBar
                key={k}
                label={k}
                value={currentScores?.[k] ?? null}
                color={SCORE_COLORS[k]}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Timeline bar ── */}
      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', flexShrink: 0, background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={handleReset} style={ctrlBtnStyle} title="Reset to start">
          <SkipBack size={14} />
        </button>
        <button onClick={handlePlayPause} style={{ ...ctrlBtnStyle, background: 'var(--blue)', color: '#fff', minWidth: 68 }}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
          <span style={{ fontSize: 11, marginLeft: 4 }}>{playing ? 'Pause' : sliderVal >= 1000 ? 'Replay' : 'Play'}</span>
        </button>

        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-muted)', minWidth: 38 }}>
          {fmtTime(currentTimeS)}
        </span>

        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={sliderVal}
          onChange={handleSliderChange}
          style={{ flex: 1, accentColor: 'var(--blue)', cursor: 'pointer' }}
        />

        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)', minWidth: 38 }}>
          {fmtTime(flightDurationS)}
        </span>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const backBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  borderRadius: 5,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
}

const speedBtnStyle = {
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
  fontWeight: 600,
}

const ctrlBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  borderRadius: 5,
  padding: '5px 10px',
  cursor: 'pointer',
}
