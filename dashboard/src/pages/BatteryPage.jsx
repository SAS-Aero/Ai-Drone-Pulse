/**
 * BatteryPage.jsx — Battery cycle count and degradation tracking.
 *
 * Shows per-drone battery health trends across all completed flights:
 *  • Total cycle count (1 flight = 1 discharge cycle)
 *  • Min battery % trend chart over cycles (area chart via Recharts)
 *  • Power health score trend over cycles
 *  • Per-cycle table with duration, min battery, power scores, and tags
 *  • Visual health status badge (GOOD / CAUTION / WORN)
 */

import React, { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { BatteryFull, BatteryMedium, BatteryLow, RefreshCw, BatteryWarning } from 'lucide-react'
import useDroneStore from '../store/useDroneStore'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8081'

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

function parseTags(raw) {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

function fmtDuration(s) {
  if (s == null) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

function fmtTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function batteryHealthStatus(cycles) {
  if (!cycles || cycles.length === 0) return null
  // Look at the last 5 cycles' min_battery and end_pwr_score to judge health
  const recent = cycles.slice(-5)
  const avgEndPwr = recent
    .filter((c) => c.end_pwr_score != null)
    .reduce((s, c, _, a) => s + c.end_pwr_score / a.length, 0)
  const lowBattCount = recent.filter((c) => c.min_battery_pct != null && c.min_battery_pct < 30).length

  if (avgEndPwr < 40 || lowBattCount >= 3) return 'worn'
  if (avgEndPwr < 60 || lowBattCount >= 1) return 'caution'
  return 'good'
}

const HEALTH_INFO = {
  good:    { label: 'GOOD',    color: '#10b981', Icon: BatteryFull },
  caution: { label: 'CAUTION', color: '#f59e0b', Icon: BatteryMedium },
  worn:    { label: 'WORN',    color: '#ef4444', Icon: BatteryLow },
}

// ── Custom tooltip for charts ─────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div style={{ background: 'rgba(10,12,15,0.95)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontSize: 11 }}>
      <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>Cycle #{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color, display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
            {p.value != null ? p.value.toFixed(1) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BatteryPage() {
  const liveDrones = useDroneStore((s) => s.drones)
  const liveDroneIds = Object.keys(liveDrones).sort()

  const [storedDroneIds, setStoredDroneIds] = useState([])
  const [selectedDrone, setSelectedDrone] = useState('')
  const [cycleData, setCycleData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Pull all known drones from storage API
  useEffect(() => {
    fetch(`${API}/drones`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const ids = data.map((d) => d.drone_id)
        setStoredDroneIds(ids)
        if (ids.length > 0 && !selectedDrone) {
          setSelectedDrone(ids[0])
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const allDroneIds = [...new Set([...liveDroneIds, ...storedDroneIds])].sort()

  const fetchCycles = useCallback(async () => {
    if (!selectedDrone) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API}/drones/${selectedDrone}/battery-cycles`)
      if (!res.ok) throw new Error(`API ${res.status}`)
      setCycleData(await res.json())
    } catch (e) {
      setError(`Cannot reach API (${e.message})`)
      setCycleData(null)
    } finally {
      setLoading(false)
    }
  }, [selectedDrone])

  useEffect(() => {
    fetchCycles()
  }, [fetchCycles])

  const cycles = cycleData?.cycles || []
  const health = batteryHealthStatus(cycles)
  const healthInfo = health ? HEALTH_INFO[health] : null

  // Chart data
  const chartData = cycles.map((c) => ({
    cycle: c.cycle,
    min_battery: c.min_battery_pct,
    end_pwr: c.end_pwr_score,
    start_pwr: c.start_pwr_score,
  }))

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <BatteryFull size={16} style={{ color: '#f59e0b' }} />
        <span className="page-title">Battery Health</span>
        {cycleData && (
          <span className="page-count">{cycleData.total_cycles} CYCLES</span>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={selectedDrone}
          onChange={(e) => setSelectedDrone(e.target.value)}
          style={selectStyle}
        >
          <option value="">Select Drone…</option>
          {allDroneIds.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>

        <button onClick={fetchCycles} disabled={loading || !selectedDrone} style={iconBtnStyle} title="Refresh">
          <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>

        {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
      </div>

      {/* No drone selected */}
      {!selectedDrone && (
        <div className="empty-state" style={{ paddingTop: 60 }}>
          <BatteryWarning size={40} style={{ color: 'var(--text-dim)', opacity: 0.4 }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Select a drone to view battery cycles.</span>
        </div>
      )}

      {selectedDrone && !loading && cycleData && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            <SummaryCard label="Total Cycles" value={cycleData.total_cycles} sub="discharge cycles logged" />
            <SummaryCard label="Total Flights" value={cycleData.total_flights} sub="flight sessions" />
            {cycles.length > 0 && (
              <>
                <SummaryCard
                  label="Lowest Min Battery"
                  value={`${Math.round(Math.min(...cycles.filter((c) => c.min_battery_pct != null).map((c) => c.min_battery_pct)))}%`}
                  sub="across all cycles"
                  valueColor={
                    Math.min(...cycles.filter((c) => c.min_battery_pct != null).map((c) => c.min_battery_pct)) < 30
                      ? 'var(--red)' : 'var(--green)'
                  }
                />
                {cycles[cycles.length - 1]?.end_pwr_score != null && (
                  <SummaryCard
                    label="Last Pwr Score"
                    value={cycles[cycles.length - 1].end_pwr_score.toFixed(1)}
                    sub="at end of last flight"
                    valueColor={
                      cycles[cycles.length - 1].end_pwr_score >= 75 ? 'var(--green)'
                        : cycles[cycles.length - 1].end_pwr_score >= 50 ? 'var(--amber)'
                        : 'var(--red)'
                    }
                  />
                )}
              </>
            )}

            {/* Health badge */}
            {healthInfo && (
              <div style={{ background: `${healthInfo.color}12`, border: `1px solid ${healthInfo.color}40`, borderRadius: 10, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 160 }}>
                <healthInfo.Icon size={28} style={{ color: healthInfo.color }} />
                <div>
                  <div style={{ fontSize: 9, color: healthInfo.color, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                    Battery Status
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: healthInfo.color }}>
                    {healthInfo.label}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    Based on last 5 cycles
                  </div>
                </div>
              </div>
            )}
          </div>

          {cycles.length < 2 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
              At least 2 cycles needed to show trend charts.
            </div>
          )}

          {/* Min Battery % trend */}
          {chartData.filter((d) => d.min_battery != null).length >= 2 && (
            <div style={chartCard}>
              <ChartTitle>Min Battery % per Cycle</ChartTitle>
              <ChartHint>Lower values over time indicate reduced capacity or more aggressive discharge.</ChartHint>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="bat-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="cycle" tick={axTick} label={{ value: 'Cycle', position: 'insideBottom', offset: -2, fill: '#6b7280', fontSize: 10 }} />
                  <YAxis domain={[0, 100]} tick={axTick} />
                  <ReferenceLine y={30} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'LOW', fill: '#ef4444', fontSize: 9 }} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="min_battery" name="Min Battery %" stroke="#f59e0b" fill="url(#bat-grad)" strokeWidth={2} dot={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Power health score trend */}
          {chartData.filter((d) => d.end_pwr != null).length >= 2 && (
            <div style={{ ...chartCard, marginTop: 16 }}>
              <ChartTitle>Power Health Score per Cycle</ChartTitle>
              <ChartHint>Declining end-of-flight power scores suggest battery wear or wiring degradation.</ChartHint>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="pwr-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4488ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#4488ff" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="cycle" tick={axTick} label={{ value: 'Cycle', position: 'insideBottom', offset: -2, fill: '#6b7280', fontSize: 10 }} />
                  <YAxis domain={[0, 100]} tick={axTick} />
                  <ReferenceLine y={50} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: 'CAUTION', fill: '#f59e0b', fontSize: 9 }} />
                  <ReferenceLine y={30} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'CRITICAL', fill: '#ef4444', fontSize: 9 }} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="start_pwr" name="Start Pwr Score" stroke="#6b7280" fill="none" strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls />
                  <Area type="monotone" dataKey="end_pwr" name="End Pwr Score" stroke="#4488ff" fill="url(#pwr-grad)" strokeWidth={2} dot={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Cycle table */}
          {cycles.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <ChartTitle>Cycle Log</ChartTitle>
              <div style={{ overflowX: 'auto' }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      {['#', 'Date', 'Duration', 'Min Battery', 'Start Pwr', 'End Pwr', 'Tags'].map((h) => (
                        <th key={h} style={thStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...cycles].reverse().map((c) => {
                      const endColor = c.end_pwr_score >= 75 ? 'var(--green)' : c.end_pwr_score >= 50 ? 'var(--amber)' : c.end_pwr_score != null ? 'var(--red)' : 'var(--text-muted)'
                      return (
                        <tr key={c.cycle} style={{ background: 'transparent' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                        >
                          <td style={{ ...tdStyle, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                            {c.cycle}
                          </td>
                          <td style={{ ...tdStyle, color: 'var(--text-muted)', fontSize: 12 }}>
                            {fmtTs(c.start_ts)}
                          </td>
                          <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                            {fmtDuration(c.duration_s)}
                          </td>
                          <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', color: c.min_battery_pct != null && c.min_battery_pct < 30 ? 'var(--red)' : 'inherit' }}>
                            {c.min_battery_pct != null ? `${Math.round(c.min_battery_pct)}%` : '—'}
                          </td>
                          <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                            {c.start_pwr_score != null ? c.start_pwr_score.toFixed(1) : '—'}
                          </td>
                          <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', color: endColor, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700 }}>
                            {c.end_pwr_score != null ? c.end_pwr_score.toFixed(1) : '—'}
                          </td>
                          <td style={tdStyle}>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {parseTags(c.tags).map((tag) => (
                                <span key={tag} style={{ ...tagBadge, background: TAG_COLORS[tag] || 'var(--border2)' }}>
                                  {tag.replace(/_/g, ' ')}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, valueColor = 'var(--text)' }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px', minWidth: 130, flex: 1 }}>
      <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: valueColor, fontVariantNumeric: 'tabular-nums', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>{sub}</div>
    </div>
  )
}

function ChartTitle({ children }) {
  return (
    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 4 }}>
      {children}
    </div>
  )
}

function ChartHint({ children }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.5 }}>
      {children}
    </div>
  )
}

const axTick = { fill: '#6b7280', fontSize: 10 }

// ── Styles ────────────────────────────────────────────────────────────────────

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

const chartCard = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '16px 20px',
}

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
