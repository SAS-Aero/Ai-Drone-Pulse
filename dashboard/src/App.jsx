import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import FleetPage from './pages/FleetPage'
import DetailPage from './pages/DetailPage'
import AlertsPage from './pages/AlertsPage'
import MapPage from './pages/MapPage'
import HUDPage from './pages/HUDPage'
import { useWebSocket } from './hooks/useWebSocket'

export default function App() {
  useWebSocket()

  return (
    <div className="app-layout">
      <Titlebar />
      <div className="app-body">
        <Sidebar />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/fleet" replace />} />
            <Route path="/hud" element={<HUDPage />} />
            <Route path="/hud/:droneId" element={<HUDPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/detail/:droneId" element={<DetailPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="*" element={<Navigate to="/fleet" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

