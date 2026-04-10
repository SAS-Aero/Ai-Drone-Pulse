/**
 * HeatmapPage.jsx — Activity heatmap across all completed flights.
 *
 * Fetches all GPS positions from the /heatmap API and renders them as
 * semi-transparent canvas circles on a Leaflet map.  Overlapping circles
 * naturally produce a density heatmap with no extra npm packages.
 *
 * Features:
 *  • Drone filter to show one drone's footprint vs all drones
 *  • Point count + coverage stats overlay
 *  • Auto-fit bounds to all loaded points
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Flame, RefreshCw } from 'lucide-react'
import useDroneStore from '../store/useDroneStore'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8081'

// ── Canvas heatmap Leaflet layer ──────────────────────────────────────────────

/**
 * Renders GPS points as canvas circles with low opacity.
 * Overlapping hot-spots stack up to full brightness naturally.
 */
function CanvasHeatLayer({ points, radius = 5, opacity = 0.08, color = '#ff6600' }) {
  const map = useMap()
  const layerGroupRef = useRef(null)

  useEffect(() => {
    if (!map) return

    // Clean up previous layer
    if (layerGroupRef.current) {
      map.removeLayer(layerGroupRef.current)
    }

    if (points.length === 0) return

    // Use Leaflet's canvas renderer for performance
    const renderer = L.canvas({ padding: 0.5 })
    const group = L.layerGroup()

    points.forEach(({ lat, lng }) => {
      const circle = L.circleMarker([lat, lng], {
        renderer,
        radius,
        fillColor: color,
        fillOpacity: opacity,
        stroke: false,
        interactive: false,
      })
      group.addLayer(circle)
    })

    group.addTo(map)
    layerGroupRef.current = group

    // Fit bounds on first load
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]))
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40] })
    }

    return () => {
      if (layerGroupRef.current) {
        map.removeLayer(layerGroupRef.current)
        layerGroupRef.current = null
      }
    }
  }, [map, points, radius, opacity, color])

  return null
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HeatmapPage() {
  const drones = useDroneStore((s) => s.drones)
  const droneIds = Object.keys(drones).sort()

  const [points, setPoints] = useState([])
  const [meta, setMeta] = useState(null)    // {total, returned}
  const [filterDrone, setFilterDrone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [dronelist, setDroneList] = useState([]) // from /drones API

  // Also try to pull drones list from the storage API
  useEffect(() => {
    fetch(`${API}/drones`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setDroneList(data.map((d) => d.drone_id)))
      .catch(() => {})
  }, [])

  // Merged drone list: live drones + stored drones
  const allDroneIds = [...new Set([...droneIds, ...dronelist])].sort()

  const fetchHeatmap = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ max_points: '5000' })
      if (filterDrone) params.set('drone_id', filterDrone)
      const res = await fetch(`${API}/heatmap?${params}`)
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      const data = await res.json()
      setPoints(data.points || [])
      setMeta({ total: data.total, returned: data.returned })
    } catch (e) {
      setError(`Cannot reach API at ${API} (${e.message})`)
    } finally {
      setLoading(false)
    }
  }, [filterDrone])

  useEffect(() => {
    fetchHeatmap()
  }, [fetchHeatmap])

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - 38px)', margin: -24, marginTop: -24, overflow: 'hidden' }}>

      {/* Map */}
      <MapContainer
        center={[20, 0]}
        zoom={2}
        style={{ width: '100%', height: '100%' }}
        zoomControl
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; OpenStreetMap &copy; CARTO'
          subdomains="abcd"
          maxZoom={19}
        />
        {points.length > 0 && (
          <CanvasHeatLayer
            points={points}
            radius={6}
            opacity={0.09}
            color="#ff6600"
          />
        )}
      </MapContainer>

      {/* Controls overlay — top left */}
      <div style={overlayStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Flame size={14} style={{ color: '#ff6600' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.04em' }}>
            Activity Heatmap
          </span>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
            Filter Drone
          </div>
          <select
            value={filterDrone}
            onChange={(e) => setFilterDrone(e.target.value)}
            style={selectStyle}
          >
            <option value="">All Drones</option>
            {allDroneIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

        <button
          onClick={fetchHeatmap}
          disabled={loading}
          style={refreshBtnStyle}
        >
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>

        {error && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--red)', maxWidth: 200 }}>
            {error}
          </div>
        )}
      </div>

      {/* Stats overlay — top right */}
      {meta && !loading && (
        <div style={{ ...overlayStyle, left: 'auto', right: 12 }}>
          <div style={statRow}>
            <span style={statLabel}>GPS POINTS</span>
            <span style={statVal}>{meta.total.toLocaleString()}</span>
          </div>
          <div style={statRow}>
            <span style={statLabel}>DISPLAYED</span>
            <span style={statVal}>{meta.returned.toLocaleString()}</span>
          </div>
          {filterDrone && (
            <div style={statRow}>
              <span style={statLabel}>DRONE</span>
              <span style={{ ...statVal, color: '#ff6600' }}>{filterDrone}</span>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!loading && points.length === 0 && !error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ background: 'rgba(10,12,15,0.85)', border: '1px solid var(--border)', borderRadius: 10, padding: '28px 40px', textAlign: 'center' }}>
            <Flame size={36} style={{ color: 'var(--text-dim)', opacity: 0.4, marginBottom: 12 }} />
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No flight GPS data found.</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              Complete a flight to populate the heatmap.
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{ position: 'absolute', bottom: 28, right: 12, zIndex: 1000, background: 'rgba(10,12,15,0.88)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Density
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          {['#331100', '#662200', '#993300', '#cc5500', '#ff6600', '#ff9944', '#ffcc88'].map((c) => (
            <div key={c} style={{ width: 18, height: 10, background: c }} />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>Low</span>
          <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>High</span>
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const overlayStyle = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 1000,
  background: 'rgba(10,12,15,0.92)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '14px 16px',
  minWidth: 190,
}

const selectStyle = {
  width: '100%',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 5,
  padding: '5px 8px',
  fontSize: 12,
  cursor: 'pointer',
}

const refreshBtnStyle = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  borderRadius: 5,
  padding: '6px 0',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
}

const statRow = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
  marginBottom: 4,
}

const statLabel = {
  fontSize: 9,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
}

const statVal = {
  fontSize: 12,
  fontFamily: "'JetBrains Mono', monospace",
  color: 'var(--text)',
  fontWeight: 700,
}
