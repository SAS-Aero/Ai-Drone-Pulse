import { create } from 'zustand'

const MAX_HISTORY = 60

const DEFAULT_SCORES = {
  pwr: 50,
  imu: 50,
  ekf: 50,
  gps: 50,
  ctl: 50,
  mot: 50,
  com: 50,
  composite: 50,
}

const SCORE_KEYS = ['pwr', 'imu', 'ekf', 'gps', 'ctl', 'mot', 'com', 'composite']

function createEmptyHistory() {
  const h = {}
  SCORE_KEYS.forEach((k) => {
    h[k] = []
  })
  return h
}

const TELEMETRY_TYPES = new Set([
  'ATTITUDE', 'GPS_RAW_INT', 'GLOBAL_POSITION_INT',
  'VFR_HUD', 'SYS_STATUS', 'HEARTBEAT', 'RC_CHANNELS_RAW', 'BATTERY_STATUS',
])

function initDrone(id, overrides = {}) {
  return {
    id,
    connected: false,
    scores: { ...DEFAULT_SCORES },
    alerts: [],
    position: null,
    history: createEmptyHistory(),
    telemetry: {},        // raw telemetry cache: { ATTITUDE: {...}, VFR_HUD: {...}, ... }
    lastSeen: null,
    ...overrides,
  }
}

function appendHistory(history, scores) {
  const t = Date.now()
  const next = {}
  SCORE_KEYS.forEach((k) => {
    const arr = [...(history[k] || [])]
    if (scores[k] !== undefined) {
      arr.push({ t, v: scores[k] })
      if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY)
    }
    next[k] = arr
  })
  return next
}

const useDroneStore = create((set) => ({
  drones: {},
  activeDroneId: null,
  wsStatus: 'disconnected',

  setWsStatus: (status) => set({ wsStatus: status }),

  setActiveDrone: (droneId) => set({ activeDroneId: droneId }),

  handleMessage: (msg) => {
    if (!msg || !msg.event) return

    const { event } = msg

    switch (event) {
      case 'snapshot': {
        // Gateway sends drones as an array of DroneStats objects
        const incoming = msg.drones || []
        const drones = {}
        const arr = Array.isArray(incoming) ? incoming : Object.values(incoming)
        arr.forEach((data) => {
          const id = data?.drone_id || data?.id
          if (!id) return
          drones[id] = initDrone(id, {
            connected: data?.online ?? data?.connected ?? false,
            lastSeen: data?.online ? Date.now() : null,
          })
        })
        set({ drones })
        break
      }

      case 'drone_connected': {
        const id = msg.drone_id
        if (!id) break
        set((state) => ({
          drones: {
            ...state.drones,
            [id]: {
              ...(state.drones[id] || initDrone(id)),
              connected: true,
              lastSeen: Date.now(),
            },
          },
        }))
        break
      }

      case 'drone_disconnected': {
        const id = msg.drone_id
        if (!id) break
        set((state) => ({
          drones: {
            ...state.drones,
            [id]: {
              ...(state.drones[id] || initDrone(id)),
              connected: false,
              lastSeen: Date.now(),
            },
          },
        }))
        break
      }

      case 'telemetry': {
        const id = msg.drone_id
        if (!id) break
        // Gateway wraps packet under msg.packet; fall back to flat format
        const pkt = msg.packet || msg
        const type = pkt.type || msg.type
        const data = pkt.data || msg.data || {}
        if (!type) break
        set((state) => {
          const existing = state.drones[id] || initDrone(id)
          const updates = { lastSeen: Date.now(), connected: true }

          // Cache raw packet if it's a known type
          if (TELEMETRY_TYPES.has(type)) {
            updates.telemetry = { ...existing.telemetry, [type]: data }
          }

          // Update GPS position from GLOBAL_POSITION_INT
          if (type === 'GLOBAL_POSITION_INT') {
            const lat = data.lat !== undefined ? data.lat / 1e7 : null
            const lng = data.lon !== undefined ? data.lon / 1e7 : null
            const alt = data.alt !== undefined ? data.alt / 1000 : null
            if (lat !== null && lng !== null) {
              updates.position = { lat, lng, alt }
            }
          }

          return {
            drones: {
              ...state.drones,
              [id]: { ...existing, ...updates },
            },
          }
        })
        break
      }

      case 'STATE_UPDATE': {
        const id = msg.drone_id
        if (!id) break
        const raw = msg.scores || {}
        // alerts live inside scores payload from the worker
        const alerts = raw.alerts || msg.alerts || []
        // strip non-score keys before merging
        const { alerts: _a, drone_id: _d, timestamp: _t, ...scores } = raw
        set((state) => {
          const existing = state.drones[id] || initDrone(id)
          const mergedScores = { ...existing.scores, ...scores }
          const newHistory = appendHistory(existing.history, mergedScores)
          return {
            drones: {
              ...state.drones,
              [id]: {
                ...existing,
                scores: mergedScores,
                alerts,
                history: newHistory,
                lastSeen: Date.now(),
              },
            },
          }
        })
        break
      }

      default:
        break
    }
  },
}))

export default useDroneStore
