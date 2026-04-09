package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// ======================= Configuration =======================

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var (
	port        = envOr("PORT", "8080")
	droneAPIKey = envOr("DRONE_API_KEY", "dev-secret")
	redisURL    = os.Getenv("REDIS_URL") // empty = Redis disabled
)

// ======================= Data Types =======================

type TelemetryPacket struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
	DroneID   string          `json:"drone_id,omitempty"`
	ServerTS  int64           `json:"server_ts,omitempty"`
}

type DroneConn struct {
	ID       string
	Conn     *websocket.Conn
	JoinedAt time.Time
	LastMsg  time.Time
	MsgCount uint64
}

// ======================= Hub =======================

type Hub struct {
	mu         sync.RWMutex
	drones     map[string]*DroneConn
	dashboards map[*websocket.Conn]*sync.Mutex
	buffer     map[string][]TelemetryPacket // per-drone ring buffer
	bufferMax  int
	rdb        *redis.Client
	redisOK    bool
	state      map[string]map[string]json.RawMessage // per-drone latest telemetry by type
}

func NewHub() *Hub {
	h := &Hub{
		drones:     make(map[string]*DroneConn),
		dashboards: make(map[*websocket.Conn]*sync.Mutex),
		buffer:     make(map[string][]TelemetryPacket),
		bufferMax:  100,
		state:      make(map[string]map[string]json.RawMessage),
	}

	// Optional Redis
	if redisURL != "" {
		opts, err := redis.ParseURL(redisURL)
		if err != nil {
			log.Printf("[Redis] Bad URL: %v — running without Redis", err)
		} else {
			h.rdb = redis.NewClient(opts)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := h.rdb.Ping(ctx).Err(); err != nil {
				log.Printf("[Redis] Connection failed: %v — running without Redis", err)
				h.rdb = nil
			} else {
				h.redisOK = true
				log.Println("[Redis] Connected")
			}
		}
	} else {
		log.Println("[Redis] No REDIS_URL set — running standalone (no workers pipeline)")
	}

	return h
}

func (h *Hub) addDrone(id string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.drones[id] = &DroneConn{ID: id, Conn: conn, JoinedAt: time.Now(), LastMsg: time.Now()}
	log.Printf("[Drone] %s connected", id)
}

func (h *Hub) removeDrone(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.drones, id)
	log.Printf("[Drone] %s disconnected", id)
}

func (h *Hub) addDashboard(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.dashboards[conn] = &sync.Mutex{}
	log.Printf("[Dashboard] Client connected (%d total)", len(h.dashboards))
}

func (h *Hub) removeDashboard(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.dashboards, conn)
	log.Printf("[Dashboard] Client disconnected (%d remaining)", len(h.dashboards))
}

func (h *Hub) handlePacket(droneID string, pkt TelemetryPacket) {
	pkt.DroneID = droneID
	pkt.ServerTS = time.Now().UnixMilli()

	// Update drone stats
	h.mu.Lock()
	if dc, ok := h.drones[droneID]; ok {
		dc.LastMsg = time.Now()
		dc.MsgCount++
	}

	// Track latest telemetry per type for scoring
	if h.state[droneID] == nil {
		h.state[droneID] = make(map[string]json.RawMessage)
	}
	h.state[droneID][pkt.Type] = pkt.Data

	// Buffer
	buf := h.buffer[droneID]
	buf = append(buf, pkt)
	if len(buf) > h.bufferMax {
		buf = buf[len(buf)-h.bufferMax:]
	}
	h.buffer[droneID] = buf
	h.mu.Unlock()

	// Broadcast to dashboards
	msg, err := json.Marshal(pkt)
	if err != nil {
		return
	}

	h.mu.RLock()
	for conn, wmu := range h.dashboards {
		wmu.Lock()
		conn.SetWriteDeadline(time.Now().Add(1 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			conn.Close()
		}
		wmu.Unlock()
	}
	h.mu.RUnlock()

	// Push to Redis stream
	if h.redisOK {
		ctx := context.Background()
		h.rdb.XAdd(ctx, &redis.XAddArgs{
			Stream: "telemetry:" + droneID,
			MaxLen: 10000,
			Approx: true,
			Values: map[string]interface{}{
				"type":     pkt.Type,
				"data":     string(pkt.Data),
				"drone_id": droneID,
				"ts":       pkt.ServerTS,
			},
		})
	}
}

// Publish score (from workers via Redis PubSub) to dashboards
func (h *Hub) publishScore(channel string, payload string) {
	msg := []byte(payload)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for conn, wmu := range h.dashboards {
		wmu.Lock()
		conn.SetWriteDeadline(time.Now().Add(1 * time.Second))
		conn.WriteMessage(websocket.TextMessage, msg)
		wmu.Unlock()
	}
}

// ======================= WebSocket Handlers =======================

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *Hub) droneWS(w http.ResponseWriter, r *http.Request) {
	droneID := r.URL.Query().Get("drone_id")
	apiKey := r.URL.Query().Get("api_key")

	if droneID == "" {
		http.Error(w, "missing drone_id", http.StatusBadRequest)
		return
	}
	if apiKey != droneAPIKey {
		http.Error(w, "invalid api_key", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Drone] Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	h.addDrone(droneID, conn)
	defer h.removeDrone(droneID)

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var pkt TelemetryPacket
		if err := json.Unmarshal(msg, &pkt); err != nil {
			continue
		}

		h.handlePacket(droneID, pkt)
	}
}

func (h *Hub) dashboardWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Dashboard] Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	h.addDashboard(conn)
	defer h.removeDashboard(conn)

	// Keep connection alive — read and discard client messages
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

// ======================= REST Handlers =======================

func (h *Hub) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "ok",
		"drones":     len(h.drones),
		"dashboards": len(h.dashboards),
		"redis":      h.redisOK,
	})
}

func (h *Hub) dronesHandler(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	type DroneInfo struct {
		ID       string `json:"id"`
		Since    string `json:"connected_since"`
		LastMsg  string `json:"last_message"`
		MsgCount uint64 `json:"message_count"`
	}

	drones := make([]DroneInfo, 0, len(h.drones))
	for _, dc := range h.drones {
		drones = append(drones, DroneInfo{
			ID:       dc.ID,
			Since:    dc.JoinedAt.Format(time.RFC3339),
			LastMsg:  dc.LastMsg.Format(time.RFC3339),
			MsgCount: dc.MsgCount,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(drones)
}

func (h *Hub) telemetryHandler(w http.ResponseWriter, r *http.Request) {
	droneID := r.URL.Query().Get("drone_id")
	if droneID == "" {
		http.Error(w, "missing drone_id", http.StatusBadRequest)
		return
	}

	h.mu.RLock()
	buf := h.buffer[droneID]
	h.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(buf)
}

// ======================= Redis PubSub Listener =======================

func (h *Hub) listenScores() {
	if !h.redisOK {
		return
	}

	ctx := context.Background()
	sub := h.rdb.PSubscribe(ctx, "scores:*")
	defer sub.Close()

	log.Println("[Redis] Subscribed to scores:*")
	ch := sub.Channel()
	for msg := range ch {
		h.publishScore(msg.Channel, msg.Payload)
	}
}

// ======================= Local Scoring Engine =======================

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func getFloat(raw json.RawMessage, key string) (float64, bool) {
	var m map[string]json.Number
	if err := json.Unmarshal(raw, &m); err != nil {
		return 0, false
	}
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	f, err := v.Float64()
	return f, err == nil
}

type vibeNode struct{ X, Y, Z float64 }

func getVibeNodes(raw json.RawMessage) []vibeNode {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	var nodes []vibeNode
	for _, key := range []string{"n1", "n2", "n3", "n4"} {
		nd, ok := m[key]
		if !ok {
			continue
		}
		var n struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
			Z float64 `json:"z"`
		}
		if json.Unmarshal(nd, &n) == nil {
			nodes = append(nodes, vibeNode{n.X, n.Y, n.Z})
		}
	}
	return nodes
}

func scoreMotor(state map[string]json.RawMessage) float64 {
	raw, ok := state["VIBE_NODES"]
	if !ok {
		return 100
	}
	nodes := getVibeNodes(raw)
	if len(nodes) == 0 {
		return 100
	}
	mags := make([]float64, len(nodes))
	for i, n := range nodes {
		mags[i] = math.Sqrt(n.X*n.X + n.Y*n.Y + n.Z*n.Z)
	}
	avg := 0.0
	for _, m := range mags {
		avg += m
	}
	avg /= float64(len(mags))
	maxM, minM := mags[0], mags[0]
	for _, m := range mags[1:] {
		if m > maxM {
			maxM = m
		}
		if m < minM {
			minM = m
		}
	}
	asym := 0.0
	if avg > 0.1 {
		asym = (maxM - minM) / avg
	}
	score := 100.0
	if excess := avg - 12; excess > 0 {
		score -= math.Min(excess*3, 40)
	}
	if asym > 0.2 {
		score -= math.Min((asym-0.2)*50, 30)
	}
	if maxM > 25 {
		score -= math.Min((maxM-25)*2, 30)
	}
	return clamp(score, 0, 100)
}

func scoreBattery(state map[string]json.RawMessage) float64 {
	raw, ok := state["SYS_STATUS"]
	if !ok {
		return 100
	}
	score := 100.0
	if rem, ok := getFloat(raw, "battery_remaining"); ok && rem >= 0 && rem <= 100 {
		if rem < 20 {
			score -= (20 - rem) * 3
		} else if rem < 40 {
			score -= (40 - rem) * 0.5
		}
	}
	if vmv, ok := getFloat(raw, "voltage_battery"); ok && vmv > 0 {
		v := vmv / 1000.0
		if v < 14.0 {
			score -= math.Min((14.0-v)*20, 40)
		} else if v < 14.8 {
			score -= (14.8 - v) * 10
		}
	}
	return clamp(score, 0, 100)
}

func scoreIMU(state map[string]json.RawMessage) float64 {
	score := 100.0
	if raw, ok := state["EKF_STATUS_REPORT"]; ok {
		for _, pair := range []struct {
			key    string
			weight float64
		}{
			{"velocity_variance", 30}, {"pos_horiz_variance", 20},
			{"pos_vert_variance", 15}, {"compass_variance", 15},
		} {
			if v, ok := getFloat(raw, pair.key); ok && v > 0.5 {
				score -= math.Min((v-0.5)*pair.weight, pair.weight)
			}
		}
	}
	if raw, ok := state["SCALED_IMU"]; ok {
		if zacc, ok := getFloat(raw, "zacc"); ok {
			if d := math.Abs(zacc + 1.0); d > 0.3 {
				score -= math.Min(d*10, 20)
			}
		}
	}
	return clamp(score, 0, 100)
}

func scoreGPS(state map[string]json.RawMessage) float64 {
	raw, ok := state["GPS_RAW_INT"]
	if !ok {
		return 100
	}
	score := 100.0
	if ft, ok := getFloat(raw, "fix_type"); ok {
		penalties := map[int]float64{0: 60, 1: 50, 2: 30, 3: 0, 4: 0, 5: 0, 6: 0}
		if p, ok := penalties[int(ft)]; ok {
			score -= p
		} else {
			score -= 40
		}
	}
	if sats, ok := getFloat(raw, "satellites_visible"); ok {
		if sats < 6 {
			score -= (6 - sats) * 8
		} else if sats < 10 {
			score -= (10 - sats) * 2
		}
	}
	if eph, ok := getFloat(raw, "eph"); ok {
		hdop := eph / 100.0
		if hdop > 3.0 {
			score -= math.Min((hdop-3.0)*5, 20)
		}
	}
	return clamp(score, 0, 100)
}

func scoreStructure(state map[string]json.RawMessage) float64 {
	raw, ok := state["VIBE_NODES"]
	if !ok {
		return 100
	}
	nodes := getVibeNodes(raw)
	score := 100.0
	for _, n := range nodes {
		mag := math.Sqrt(n.X*n.X + n.Y*n.Y + n.Z*n.Z)
		if mag > 30 {
			score -= math.Min((mag-30)*3, 25)
		}
	}
	return clamp(score, 0, 100)
}

func scoreComms(state map[string]json.RawMessage, lastMsg time.Time) float64 {
	score := 100.0
	if raw, ok := state["SYS_STATUS"]; ok {
		if dr, ok := getFloat(raw, "drop_rate_comm"); ok {
			pct := dr / 100.0
			if pct > 1 {
				score -= math.Min(pct*5, 40)
			}
		}
	}
	if raw, ok := state["RC_CHANNELS_RAW"]; ok {
		if rssi, ok := getFloat(raw, "rssi"); ok && rssi < 255 {
			if rssi < 50 {
				score -= math.Min((50-rssi)*1.5, 30)
			} else if rssi < 100 {
				score -= (100 - rssi) * 0.3
			}
		}
	}
	age := time.Since(lastMsg).Seconds()
	if age > 5 {
		score -= math.Min((age-5)*5, 30)
	}
	return clamp(score, 0, 100)
}

func (h *Hub) computeAndBroadcastScores() {
	h.mu.RLock()
	droneIDs := make([]string, 0, len(h.drones))
	for id := range h.drones {
		droneIDs = append(droneIDs, id)
	}
	h.mu.RUnlock()

	for _, droneID := range droneIDs {
		h.mu.RLock()
		st := h.state[droneID]
		var lastMsg time.Time
		if dc, ok := h.drones[droneID]; ok {
			lastMsg = dc.LastMsg
		}
		h.mu.RUnlock()

		if st == nil {
			continue
		}

		scores := map[string]interface{}{
			"motor":     scoreMotor(st),
			"battery":   scoreBattery(st),
			"imu":       scoreIMU(st),
			"gps":       scoreGPS(st),
			"structure": scoreStructure(st),
			"comms":     scoreComms(st, lastMsg),
		}

		pkt := TelemetryPacket{
			Type:    "HEALTH_SCORES",
			DroneID: droneID,
		}
		pkt.Data, _ = json.Marshal(scores)
		msg, _ := json.Marshal(pkt)
		log.Printf("[Scoring] %s: %v", droneID, scores)

		h.mu.RLock()
		for conn, wmu := range h.dashboards {
			wmu.Lock()
			conn.SetWriteDeadline(time.Now().Add(1 * time.Second))
			conn.WriteMessage(websocket.TextMessage, msg)
			wmu.Unlock()
		}
		h.mu.RUnlock()
	}
}

func (h *Hub) runLocalScoring() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		h.computeAndBroadcastScores()
	}
}

// ======================= Main =======================

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)

	hub := NewHub()

	// Start Redis score listener in background
	go hub.listenScores()

	// Start local scoring engine (works without Redis)
	go hub.runLocalScoring()

	// Routes
	http.HandleFunc("/drone/ws", hub.droneWS)
	http.HandleFunc("/dashboard/ws", hub.dashboardWS)
	http.HandleFunc("/health", hub.healthHandler)
	http.HandleFunc("/api/drones", hub.dronesHandler)
	http.HandleFunc("/api/telemetry", hub.telemetryHandler)

	// Serve dashboard
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, "dashboard.html")
	})

	addr := fmt.Sprintf(":%s", port)
	log.Printf("[DronePulse] Gateway starting on %s", addr)
	log.Printf("[DronePulse] Dashboard: http://localhost:%s", port)
	log.Printf("[DronePulse] Drone WS:  ws://localhost:%s/drone/ws?drone_id=DR-001&api_key=%s", port, droneAPIKey)

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
