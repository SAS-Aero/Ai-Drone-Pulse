import React from 'react'
import { NavLink } from 'react-router-dom'
import { LayoutGrid, Bell, Map, Radio } from 'lucide-react'
import useDroneStore from '../store/useDroneStore'

export default function Sidebar() {
  const wsStatus = useDroneStore((state) => state.wsStatus)

  const wsColor =
    wsStatus === 'connected'
      ? 'var(--green)'
      : wsStatus === 'connecting'
      ? 'var(--amber)'
      : 'var(--red)'

  return (
    <div className="sidebar">
      {/* Nav links */}
      <NavLink
        to="/fleet"
        className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
        title="Fleet Overview"
      >
        <LayoutGrid size={20} />
      </NavLink>

      <NavLink
        to="/alerts"
        className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
        title="Alerts"
      >
        <Bell size={20} />
      </NavLink>

      <NavLink
        to="/map"
        className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
        title="Map"
      >
        <Map size={20} />
      </NavLink>

      {/* Separator */}
      <div
        style={{
          width: 28,
          height: 1,
          background: 'var(--border)',
          margin: 'auto 0 8px 0',
          marginTop: 'auto',
        }}
      />

      {/* WS signal indicator */}
      <div
        style={{
          width: '100%',
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: wsColor,
          transition: 'color 0.3s',
        }}
        title={`WebSocket: ${wsStatus}`}
      >
        <Radio size={18} />
      </div>
    </div>
  )
}
