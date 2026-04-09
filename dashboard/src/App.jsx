import { Routes, Route, Navigate } from 'react-router-dom'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import FleetPage from './pages/FleetPage'
import DetailPage from './pages/DetailPage'
import AlertsPage from './pages/AlertsPage'
import MapPage from './pages/MapPage'
import HUDPage from './pages/HUDPage'
import FlightLogsPage from './pages/FlightLogsPage'
import ReplayPage from './pages/ReplayPage'
import HeatmapPage from './pages/HeatmapPage'
import ReportPage from './pages/ReportPage'
import BatteryPage from './pages/BatteryPage'
import VibrationPage from './pages/VibrationPage'
import { useWebSocket } from './hooks/useWebSocket'

// Wrappers to control per-route scroll/fill behaviour
function Fill({ children }) {
  return <div className="page-fill">{children}</div>
}
function Scroll({ children }) {
  return <div className="page-scroll">{children}</div>
}

export default function App() {
  useWebSocket()

  return (
    <div className="app-layout">
      <Titlebar />
      <div className="app-body">
        <Sidebar />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/hud" replace />} />

            {/* Full-height no-scroll pages */}
            <Route path="/hud"          element={<Fill><HUDPage /></Fill>} />
            <Route path="/hud/:droneId" element={<Fill><HUDPage /></Fill>} />
            <Route path="/map"          element={<Fill><MapPage /></Fill>} />

            {/* Normal scrollable pages */}
            <Route path="/fleet"               element={<Scroll><FleetPage /></Scroll>} />
            <Route path="/detail/:droneId"     element={<Scroll><DetailPage /></Scroll>} />
            <Route path="/alerts"              element={<Scroll><AlertsPage /></Scroll>} />
            <Route path="/logs"                element={<Scroll><FlightLogsPage /></Scroll>} />
            <Route path="/replay/:flightId"    element={<Scroll><ReplayPage /></Scroll>} />
            <Route path="/heatmap"             element={<Scroll><HeatmapPage /></Scroll>} />
            <Route path="/report/:flightId"    element={<Scroll><ReportPage /></Scroll>} />
            <Route path="/battery"             element={<Scroll><BatteryPage /></Scroll>} />
            <Route path="/vibration"           element={<Scroll><VibrationPage /></Scroll>} />

            <Route path="*" element={<Navigate to="/hud" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
