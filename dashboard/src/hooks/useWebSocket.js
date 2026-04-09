import { useEffect, useRef } from 'react'
import useDroneStore from '../store/useDroneStore'

// Dynamically build the WebSocket URL:
// • Electron / local dev  → ws://localhost:8080/dashboard/ws
// • Browser on Railway    → wss://your-app.up.railway.app/dashboard/ws
// Override with VITE_WS_URL in .env for custom deployments.
function getWsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL
  // In Electron the window.location.host is not meaningful; fall back to localhost
  const isElectron = typeof window !== 'undefined' && window.navigator.userAgent.includes('Electron')
  if (isElectron) return 'ws://localhost:8080/dashboard/ws'
  // Browser: use current host with protocol upgrade
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/dashboard/ws`
}

const WS_URL = getWsUrl()
const RECONNECT_DELAY = 3000

export function useWebSocket() {
  const ws = useRef(null)
  const reconnectTimer = useRef(null)
  const unmounted = useRef(false)

  const handleMessage = useDroneStore((state) => state.handleMessage)
  const setWsStatus   = useDroneStore((state) => state.setWsStatus)

  useEffect(() => {
    unmounted.current = false

    function connect() {
      if (unmounted.current) return
      setWsStatus('connecting')

      const socket = new WebSocket(WS_URL)
      ws.current = socket

      socket.onopen = () => {
        if (unmounted.current) { socket.close(); return }
        setWsStatus('connected')
      }

      socket.onmessage = (event) => {
        if (unmounted.current) return
        try {
          const msg = JSON.parse(event.data)
          handleMessage(msg)
        } catch (err) {
          console.warn('[WS] Failed to parse message:', err)
        }
      }

      socket.onclose = () => {
        if (unmounted.current) return
        setWsStatus('disconnected')
        reconnectTimer.current = setTimeout(() => {
          if (!unmounted.current) connect()
        }, RECONNECT_DELAY)
      }

      socket.onerror = (err) => {
        console.warn('[WS] Error:', err)
        if (!unmounted.current) setWsStatus('error')
      }
    }

    connect()

    return () => {
      unmounted.current = true
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      if (ws.current) {
        ws.current.onclose   = null
        ws.current.onerror   = null
        ws.current.onmessage = null
        ws.current.onopen    = null
        ws.current.close()
        ws.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

export default useWebSocket
