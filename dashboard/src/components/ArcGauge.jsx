import React, { useMemo } from 'react'

function scoreToColor(score) {
  if (score >= 85) return '#00ff88'
  if (score >= 70) return '#44dd88'
  if (score >= 50) return '#ffaa00'
  if (score >= 30) return '#ff7700'
  return '#ff3d3d'
}

/**
 * ArcGauge
 * Props:
 *   score: 0-100
 *   label: string
 *   color: string (optional, auto-computed if omitted)
 *   size: number (default 120)
 */
export default function ArcGauge({ score = 0, label = '', color, size = 120 }) {
  const strokeWidth = 7
  const padding = 4
  const cx = size / 2
  const cy = size / 2
  const radius = cx - strokeWidth - padding

  // Arc math: 220 degrees span, starting at 200deg (from positive X axis, clockwise)
  // SVG angles: 0deg = right, clockwise positive
  // We go from 200deg to 200+220=420deg (=60deg) clockwise
  const ARC_DEG = 220
  const START_DEG = 200

  const circumference = 2 * Math.PI * radius
  const arcLength = (ARC_DEG / 360) * circumference

  // Convert degrees to radians for SVG path
  function degToRad(deg) {
    return (deg * Math.PI) / 180
  }

  function polarToCartesian(angle) {
    const rad = degToRad(angle)
    return {
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    }
  }

  // Build arc path using SVG arc
  function buildArcPath(startDeg, spanDeg) {
    const endDeg = startDeg + spanDeg
    const start = polarToCartesian(startDeg)
    const end = polarToCartesian(endDeg)
    const largeArc = spanDeg > 180 ? 1 : 0
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`
  }

  const trackPath = buildArcPath(START_DEG, ARC_DEG)
  const scoreArcSpan = (Math.max(0, Math.min(100, score)) / 100) * ARC_DEG
  const scorePath = buildArcPath(START_DEG, Math.max(0.01, scoreArcSpan))

  const resolvedColor = color || scoreToColor(score)
  const filterId = useMemo(
    () => `glow-${Math.random().toString(36).slice(2, 8)}`,
    []
  )

  const displayScore = Math.round(score)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        padding: '12px 8px 10px',
        position: 'relative',
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ overflow: 'visible' }}
      >
        <defs>
          <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feFlood floodColor={resolvedColor} floodOpacity="0.6" result="color" />
            <feComposite in="color" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Track arc */}
        <path
          d={trackPath}
          fill="none"
          stroke="#1e2530"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />

        {/* Score arc */}
        {scoreArcSpan > 0 && (
          <path
            d={scorePath}
            fill="none"
            stroke={resolvedColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            filter={`url(#${filterId})`}
            style={{ transition: 'all 0.4s ease' }}
          />
        )}

        {/* Score value */}
        <text
          x={cx}
          y={cy + 6}
          textAnchor="middle"
          fontFamily="'JetBrains Mono', monospace"
          fontSize={size * 0.22}
          fontWeight="700"
          fill={resolvedColor}
          style={{ transition: 'fill 0.4s ease' }}
        >
          {displayScore}
        </text>
      </svg>

      {/* Label below SVG */}
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.1em',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          textAlign: 'center',
        }}
      >
        {label}
      </div>
    </div>
  )
}
