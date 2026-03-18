import React, { useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import useDroneStore from '../store/useDroneStore'

// Fix Leaflet default icon issue in bundlers
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function scoreToColor(score) {
  if (score >= 85) return '#00ff88'
  if (score >= 70) return '#44dd88'
  if (score >= 50) return '#ffaa00'
  if (score >= 30) return '#ff7700'
  return '#ff3d3d'
}

function createDroneIcon(color, connected) {
  const opacity = connected ? 1 : 0.45
  const svgStr = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="36" viewBox="0 0 32 36">
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="blur"/>
          <feFlood flood-color="${color}" flood-opacity="0.6" result="color"/>
          <feComposite in="color" in2="blur" operator="in" result="g"/>
          <feMerge>
            <feMergeNode in="g"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <!-- Body circle -->
      <circle cx="16" cy="18" r="9" fill="${color}" fill-opacity="${opacity}"
        stroke="${color}" stroke-width="1.5" filter="url(#glow)"/>
      <!-- Inner dot -->
      <circle cx="16" cy="18" r="3" fill="#0a0c0f"/>
      <!-- Arrow pointing up (heading north) -->
      <polygon points="16,2 20,12 16,9 12,12" fill="${color}" fill-opacity="${opacity}"/>
      <!-- Arm lines -->
      <line x1="16" y1="18" x2="4" y2="8" stroke="${color}" stroke-width="1.5" opacity="${opacity * 0.6}"/>
      <line x1="16" y1="18" x2="28" y2="8" stroke="${color}" stroke-width="1.5" opacity="${opacity * 0.6}"/>
      <line x1="16" y1="18" x2="4" y2="28" stroke="${color}" stroke-width="1.5" opacity="${opacity * 0.6}"/>
      <line x1="16" y1="18" x2="28" y2="28" stroke="${color}" stroke-width="1.5" opacity="${opacity * 0.6}"/>
      <!-- Rotor tips -->
      <circle cx="4" cy="8" r="2" fill="${color}" fill-opacity="${opacity * 0.7}"/>
      <circle cx="28" cy="8" r="2" fill="${color}" fill-opacity="${opacity * 0.7}"/>
      <circle cx="4" cy="28" r="2" fill="${color}" fill-opacity="${opacity * 0.7}"/>
      <circle cx="28" cy="28" r="2" fill="${color}" fill-opacity="${opacity * 0.7}"/>
    </svg>
  `.trim()

  return L.divIcon({
    html: svgStr,
    className: 'drone-marker-container',
    iconSize: [32, 36],
    iconAnchor: [16, 18],
    popupAnchor: [0, -20],
  })
}

function formatCoord(val, axis) {
  if (val === null || val === undefined) return '—'
  const abs = Math.abs(val).toFixed(5)
  if (axis === 'lat') return `${abs}° ${val >= 0 ? 'N' : 'S'}`
  return `${abs}° ${val >= 0 ? 'E' : 'W'}`
}

function MapBounds({ drones }) {
  const map = useMap()

  React.useEffect(() => {
    const points = drones.filter((d) => d.position).map((d) => [
      d.position.lat,
      d.position.lng,
    ])
    if (points.length === 1) {
      map.setView(points[0], Math.max(map.getZoom(), 12))
    } else if (points.length > 1) {
      map.fitBounds(points, { padding: [60, 60] })
    }
  }, []) // Only on mount
  return null
}

export default function MapPage() {
  const drones = useDroneStore((state) => state.drones)

  const droneList = useMemo(() => Object.values(drones), [drones])
  const dronesWithPos = useMemo(
    () => droneList.filter((d) => d.position && d.position.lat !== null),
    [droneList]
  )

  return (
    <div
      style={{
        position: 'relative',
        height: 'calc(100vh - 38px)',
        margin: -24,
        marginTop: -24,
      }}
    >
      <MapContainer
        center={[0, 0]}
        zoom={2}
        style={{ width: '100%', height: '100%' }}
        zoomControl={true}
        attributionControl={true}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={19}
        />

        {dronesWithPos.length > 0 && <MapBounds drones={dronesWithPos} />}

        {dronesWithPos.map((drone) => {
          const composite = drone.scores?.composite ?? 0
          const color = scoreToColor(composite)
          const icon = createDroneIcon(color, drone.connected)

          return (
            <Marker
              key={drone.id}
              position={[drone.position.lat, drone.position.lng]}
              icon={icon}
            >
              <Popup>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    minWidth: 180,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#e8edf2',
                      marginBottom: 8,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: drone.connected ? '#00ff88' : '#3d4550',
                        display: 'inline-block',
                        boxShadow: drone.connected ? '0 0 6px #00ff88' : 'none',
                      }}
                    />
                    {drone.id}
                  </div>
                  <table style={{ fontSize: 10, borderCollapse: 'collapse', width: '100%' }}>
                    <tbody>
                      <tr>
                        <td style={{ color: '#6b7280', paddingRight: 10, paddingBottom: 3 }}>STATUS</td>
                        <td style={{ color: drone.connected ? '#00ff88' : '#3d4550' }}>
                          {drone.connected ? 'ONLINE' : 'OFFLINE'}
                        </td>
                      </tr>
                      <tr>
                        <td style={{ color: '#6b7280', paddingRight: 10, paddingBottom: 3 }}>COMPOSITE</td>
                        <td style={{ color }}>{Math.round(composite)}</td>
                      </tr>
                      <tr>
                        <td style={{ color: '#6b7280', paddingRight: 10, paddingBottom: 3 }}>LAT</td>
                        <td style={{ color: '#e8edf2' }}>{formatCoord(drone.position.lat, 'lat')}</td>
                      </tr>
                      <tr>
                        <td style={{ color: '#6b7280', paddingRight: 10, paddingBottom: 3 }}>LNG</td>
                        <td style={{ color: '#e8edf2' }}>{formatCoord(drone.position.lng, 'lng')}</td>
                      </tr>
                      {drone.position.alt !== null && (
                        <tr>
                          <td style={{ color: '#6b7280', paddingRight: 10 }}>ALT</td>
                          <td style={{ color: '#e8edf2' }}>
                            {drone.position.alt !== undefined ? `${drone.position.alt.toFixed(1)} m` : '—'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Popup>
            </Marker>
          )
        })}
      </MapContainer>

      {/* No GPS fix overlay */}
      {dronesWithPos.length === 0 && (
        <div className="map-no-fix">
          {droneList.length === 0 ? 'NO DRONES CONNECTED' : 'NO GPS FIX'}
        </div>
      )}

      {/* Drone count badge */}
      {dronesWithPos.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 1000,
            background: 'rgba(17, 20, 24, 0.92)',
            border: '1px solid #1e2530',
            padding: '6px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            letterSpacing: '0.08em',
            color: '#6b7280',
          }}
        >
          {dronesWithPos.length} DRONE{dronesWithPos.length !== 1 ? 'S' : ''} ON MAP
        </div>
      )}
    </div>
  )
}
