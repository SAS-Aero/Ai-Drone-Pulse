import React from 'react'

export default function ScoreBar({ label, score, color }) {
  const pct = Math.max(0, Math.min(100, score ?? 0))

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 20,
      }}
    >
      {/* Label */}
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          width: 28,
          flexShrink: 0,
        }}
      >
        {label}
      </span>

      {/* Bar track */}
      <div className="score-bar-track">
        <div
          className="score-bar-fill"
          style={{
            width: `${pct}%`,
            background: color || 'var(--green)',
          }}
        />
      </div>

      {/* Score value */}
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          fontWeight: 600,
          color: color || 'var(--green)',
          width: 28,
          textAlign: 'right',
          flexShrink: 0,
        }}
      >
        {Math.round(pct)}
      </span>
    </div>
  )
}
