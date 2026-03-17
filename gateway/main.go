package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

//go:embed dashboard.html
var dashboardHTML []byte

// ─── Globals ──────────────────────────────────────────────────────────────────

var redisClient *redis.Client

// ─── Types ───────────────────────────────────────────────────────────────────

type DroneStats struct {
	DroneID      string         `json:"drone_id"`
	ConnectedAt  time.Time      `json:"connected_at"`
	MessageCount int            `json:"message_count"`
	MessageTypes map[string]int `json:"message_types"`
	LastSeen     time.Time      `json:"last_seen"`
	Online       bool           `json:"online"`
}

type Packet struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
}

// ─── Hub ─────────────────────────────────────────────────────────────────────

type Hub struct {
	mu         sync.RWMutex
	drones     map[string]*websocket.Conn
	stats      map[string]*DroneStats
	buffer     map[string][]Packet
	dashboards map[*websocket.Conn]struct{}
}

func newHub() *Hub {
	return &Hub{
		drones:     make(map[string]*websocket.Conn),
		stats:      make(map[string]*DroneStats),
		buffer:     make(map[string][]Packet),
		dashboards: make(map[*websocket.Conn]struct{}),
	}
}

func (h *Hub) broadcastToDashboards(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	conns := make([]*websocket.Conn, 0, len(h.dashboards))
	for c := range h.dashboards {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	for _, c := range conns {
		if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
			h.mu.Lock()
			delete(h.dashboards, c)
			h.mu.Unlock()
			c.Close()
		}
	}
}

func (h *Hub) connectedDroneIDs() []string {
	ids := make([]string, 0, len(h.drones))
	for id := range h.drones {
		ids = append(ids, id)
	}
	return ids
}

func (h *Hub) snapshot() map[string]any {
	h.mu.RLock()
	defer h.mu.RUnlock()

	statsList := make([]*DroneStats, 0, len(h.stats))
	for _, s := range h.stats {
		statsList = append(statsList, s)
	}
	return map[string]any{
		"event":            "snapshot",
		"drones":           statsList,
		"connected_drones": h.connectedDroneIDs(),
	}
}

// ─── Upgrader ─────────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ─── Redis helpers ────────────────────────────────────────────────────────────

func pushToStream(ctx context.Context, droneID string, rawMsg []byte) {
	if redisClient == nil {
		return
	}
	go func() {
		streamKey := "telemetry:" + droneID
		err := redisClient.XAdd(ctx, &redis.XAddArgs{
			Stream: streamKey,
			MaxLen: 1000,
			Approx: true,
			Values: map[string]any{
				"data": string(rawMsg),
			},
		}).Err()
		if err != nil {
			log.Printf("[redis] XADD error for %s: %v", streamKey, err)
		}
	}()
}

func startScoresSubscriber(ctx context.Context, hub *Hub) {
	go func() {
		for {
			if redisClient == nil {
				time.Sleep(5 * time.Second)
				continue
			}
			pubsub := redisClient.PSubscribe(ctx, "scores:*")
			ch := pubsub.Channel()
			log.Println("[redis] subscribed to scores:* PubSub")

			for msg := range ch {
				var payload map[string]any
				if err := json.Unmarshal([]byte(msg.Payload), &payload); err != nil {
					log.Printf("[redis] scores parse error: %v", err)
					continue
				}
				hub.broadcastToDashboards(map[string]any{
					"event":    "STATE_UPDATE",
					"drone_id": "DR-001",
					"scores":   payload,
				})
			}

			pubsub.Close()
			log.Println("[redis] PubSub disconnected, retrying in 5s...")
			time.Sleep(5 * time.Second)
		}
	}()
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":    "ok",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func droneWSHandler(hub *Hub, apiKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		droneID := r.URL.Query().Get("drone_id")
		key := r.URL.Query().Get("api_key")

		if droneID == "" {
			http.Error(w, "missing drone_id", http.StatusBadRequest)
			return
		}
		if key != apiKey {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("drone upgrade error: %v", err)
			return
		}

		hub.mu.Lock()
		hub.drones[droneID] = conn
		if _, exists := hub.stats[droneID]; !exists {
			hub.stats[droneID] = &DroneStats{
				DroneID:      droneID,
				MessageTypes: make(map[string]int),
			}
		}
		hub.stats[droneID].ConnectedAt = time.Now().UTC()
		hub.stats[droneID].Online = true
		hub.mu.Unlock()

		log.Printf("[drone] connected: %s", droneID)
		hub.broadcastToDashboards(map[string]any{
			"event":     "drone_connected",
			"drone_id":  droneID,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		})

		defer func() {
			hub.mu.Lock()
			delete(hub.drones, droneID)
			if s, ok := hub.stats[droneID]; ok {
				s.Online = false
			}
			hub.mu.Unlock()
			conn.Close()
			log.Printf("[drone] disconnected: %s", droneID)
			hub.broadcastToDashboards(map[string]any{
				"event":     "drone_disconnected",
				"drone_id":  droneID,
				"timestamp": time.Now().UTC().Format(time.RFC3339),
			})
		}()

		ctx := context.Background()

		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}

			var pkt Packet
			if err := json.Unmarshal(msg, &pkt); err != nil {
				continue
			}

			hub.mu.Lock()
			s := hub.stats[droneID]
			s.MessageCount++
			s.LastSeen = time.Now().UTC()
			s.MessageTypes[pkt.Type]++
			buf := append(hub.buffer[droneID], pkt)
			if len(buf) > 100 {
				buf = buf[len(buf)-100:]
			}
			hub.buffer[droneID] = buf
			hub.mu.Unlock()

			hub.broadcastToDashboards(map[string]any{
				"event":    "telemetry",
				"drone_id": droneID,
				"packet":   pkt,
			})

			// Push raw message to Redis Stream (non-blocking)
			pushToStream(ctx, droneID, msg)
		}
	}
}

func dashboardWSHandler(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("dashboard upgrade error: %v", err)
			return
		}

		hub.mu.Lock()
		hub.dashboards[conn] = struct{}{}
		hub.mu.Unlock()

		snap, _ := json.Marshal(hub.snapshot())
		_ = conn.WriteMessage(websocket.TextMessage, snap)

		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				hub.mu.Lock()
				delete(hub.dashboards, conn)
				hub.mu.Unlock()
				conn.Close()
				return
			}
		}
	}
}

func dronesAPIHandler(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hub.mu.RLock()
		statsList := make([]*DroneStats, 0, len(hub.stats))
		for _, s := range hub.stats {
			statsList = append(statsList, s)
		}
		connected := hub.connectedDroneIDs()
		hub.mu.RUnlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"stats":            statsList,
			"connected_drones": connected,
		})
	}
}

func telemetryAPIHandler(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		droneID := r.URL.Query().Get("drone_id")
		if droneID == "" {
			http.Error(w, "missing drone_id", http.StatusBadRequest)
			return
		}

		hub.mu.RLock()
		packets := hub.buffer[droneID]
		hub.mu.RUnlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"drone_id": droneID,
			"packets":  packets,
		})
	}
}

func dashboardPageHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	w.Write(dashboardHTML)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	apiKey := os.Getenv("DRONE_API_KEY")
	if apiKey == "" {
		apiKey = "dev-secret"
	}

	// Initialize Redis client
	redisURL := os.Getenv("REDIS_URL")
	if redisURL != "" {
		opts, err := redis.ParseURL(redisURL)
		if err != nil {
			log.Printf("[redis] failed to parse REDIS_URL: %v", err)
		} else {
			redisClient = redis.NewClient(opts)
			ctx := context.Background()
			if err := redisClient.Ping(ctx).Err(); err != nil {
				log.Printf("[redis] ping failed: %v", err)
				redisClient = nil
			} else {
				log.Println("[redis] connected successfully")
			}
		}
	} else {
		log.Println("[redis] REDIS_URL not set, running without Redis")
	}

	hub := newHub()

	// Start Redis scores subscriber
	if redisClient != nil {
		startScoresSubscriber(context.Background(), hub)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/drone/ws", droneWSHandler(hub, apiKey))
	mux.HandleFunc("/dashboard/ws", dashboardWSHandler(hub))
	mux.HandleFunc("/api/drones", dronesAPIHandler(hub))
	mux.HandleFunc("/api/telemetry", telemetryAPIHandler(hub))
	mux.HandleFunc("/", dashboardPageHandler)

	log.Printf("DronePulse gateway listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
