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

function initDrone(id, overrides = {}) {
  return {
    id,
    connected: false,
    scores: { ...DEFAULT_SCORES },
    alerts: [],
    position: null,
    history: createEmptyHistory(),
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

const useDroneStore = create((set, get) => ({
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
        const incoming = msg.drones || {}
        const drones = {}
        Object.entries(incoming).forEach(([id, data]) => {
          drones[id] = initDrone(id, {
            connected: data?.connected ?? false,
            scores: { ...DEFAULT_SCORES, ...(data?.scores || {}) },
            alerts: data?.alerts || [],
            position: data?.position || null,
            lastSeen: data?.connected ? Date.now() : null,
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
        if (msg.type === 'GLOBAL_POSITION_INT') {
          const data = msg.data || {}
          const lat = data.lat !== undefined ? data.lat / 1e7 : null
          const lng = data.lon !== undefined ? data.lon / 1e7 : null
          const alt = data.alt !== undefined ? data.alt / 1000 : null
          if (lat !== null && lng !== null) {
            set((state) => ({
              drones: {
                ...state.drones,
                [id]: {
                  ...(state.drones[id] || initDrone(id)),
                  position: { lat, lng, alt },
                  lastSeen: Date.now(),
                },
              },
            }))
          }
        }
        break
      }

      case 'STATE_UPDATE': {
        const id = msg.drone_id
        if (!id) break
        const scores = msg.scores || {}
        const alerts = msg.alerts || []
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
