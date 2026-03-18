import React from 'react'
import useDroneStore from '../store/useDroneStore'

function WsBadge({ status }) {
  const label = status === 'connected'
    ? 'LIVE'
    : status === 'connecting'
    ? 'CONNECTING'
    : status === 'error'
    ? 'ERROR'
    : 'OFFLINE'

  return (
    <span className={`ws-badge ${status}`}>
      {status === 'connected' && (
        <span
          style={{
            display: 'inline-block',
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'var(--green)',
            marginRight: 5,
            verticalAlign: 'middle',
            boxShadow: '0 0 5px var(--green)',
          }}
        />
      )}
      {label}
    </span>
  )
}

export default function Titlebar() {
  const wsStatus = useDroneStore((state) => state.wsStatus)

  const handleMinimize = () => window.electronAPI?.minimize()
  const handleMaximize = () => window.electronAPI?.maximize()
  const handleClose = () => window.electronAPI?.close()

  return (
    <div className="titlebar">
      {/* Logo */}
      <div
        style={{
          paddingLeft: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          flexShrink: 0,
          WebkitAppRegion: 'no-drag',
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: '0.12em',
            color: '#4488ff',
          }}
        >
          DRONE
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: '0.12em',
            color: '#e8edf2',
          }}
        >
          PULSE
        </span>
        <span
          style={{
            marginLeft: 10,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            letterSpacing: '0.08em',
            color: 'var(--text-dim)',
            fontWeight: 600,
            textTransform: 'uppercase',
            alignSelf: 'flex-end',
            paddingBottom: 1,
          }}
        >
          v2.0
        </span>
      </div>

      {/* Drag region (center) */}
      <div style={{ flex: 1 }} />

      {/* Right section */}
      <div
        className="titlebar-controls"
        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <WsBadge status={wsStatus} />

        <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 6px' }} />

        <button
          className="titlebar-btn"
          onClick={handleMinimize}
          title="Minimize"
          style={{ fontSize: 16, lineHeight: 1 }}
        >
          &#x2212;
        </button>
        <button
          className="titlebar-btn"
          onClick={handleMaximize}
          title="Maximize"
          style={{ fontSize: 12, lineHeight: 1 }}
        >
          &#x25A1;
        </button>
        <button
          className="titlebar-btn close"
          onClick={handleClose}
          title="Close"
          style={{ fontSize: 14, lineHeight: 1 }}
        >
          &#x2715;
        </button>
      </div>
    </div>
  )
}
