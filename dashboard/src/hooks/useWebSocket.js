import { useEffect, useRef } from 'react'
import useDroneStore from '../store/useDroneStore'

const WS_URL = 'wss://dronepulse-production.up.railway.app/dashboard/ws'
const RECONNECT_DELAY = 3000

export function useWebSocket() {
  const ws = useRef(null)
  const reconnectTimer = useRef(null)
  const unmounted = useRef(false)

  const handleMessage = useDroneStore((state) => state.handleMessage)
  const setWsStatus = useDroneStore((state) => state.setWsStatus)

  useEffect(() => {
    unmounted.current = false

    function connect() {
      if (unmounted.current) return

      setWsStatus('connecting')

      const socket = new WebSocket(WS_URL)
      ws.current = socket

      socket.onopen = () => {
        if (unmounted.current) {
          socket.close()
          return
        }
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
          if (!unmounted.current) {
            connect()
          }
        }, RECONNECT_DELAY)
      }

      socket.onerror = (err) => {
        console.warn('[WS] Error:', err)
        if (!unmounted.current) {
          setWsStatus('error')
        }
        // onclose will fire after onerror, triggering reconnect
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
        ws.current.onclose = null
        ws.current.onerror = null
        ws.current.onmessage = null
        ws.current.onopen = null
        ws.current.close()
        ws.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

export default useWebSocket
