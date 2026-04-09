package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
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

// PostPacket is the per-packet shape sent by the ESP32 HTTP forwarder.
type PostPacket struct {
	Type string          `json:"type"`
	Ts   int64           `json:"ts"`
	Data json.RawMessage `json:"data"`
}

// PostTelemetryRequest is the body shape for POST /drone/telemetry.
type PostTelemetryRequest struct {
	DroneID string       `json:"drone_id"`
	APIKey  string       `json:"api_key"`
	Packets []PostPacket `json:"packets"`
}

// VibeNode holds a single arm's X/Y/Z accelerometer reading (m/s²).
type VibeNode struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// VibeNodesData is the data payload for VIBE_NODES packets.
type VibeNodesData struct {
	N1 VibeNode `json:"n1"`
	N2 VibeNode `json:"n2"`
	N3 VibeNode `json:"n3"`
	N4 VibeNode `json:"n4"`
}

// VibeRecord is one timestamped VIBE_NODES sample stored in memory.
type VibeRecord struct {
	DroneID string    `json:"drone_id"`
	Ts      int64     `json:"ts"`
	WallTs  time.Time `json:"wall_ts"`
	N1      VibeNode  `json:"n1"`
	N2      VibeNode  `json:"n2"`
	N3      VibeNode  `json:"n3"`
	N4      VibeNode  `json:"n4"`
}

// ─── Hub ─────────────────────────────────────────────────────────────────────

type Hub struct {
	mu          sync.RWMutex
	drones      map[string]*websocket.Conn
	stats       map[string]*DroneStats
	buffer      map[string][]Packet
	vibeBuffer  map[string][]VibeRecord
	dashboards  map[*websocket.Conn]struct{}
	droneState  map[string]map[string]json.RawMessage // per-drone latest telemetry by msg type
}

func newHub() *Hub {
	return &Hub{
		drones:     make(map[string]*websocket.Conn),
		stats:      make(map[string]*DroneStats),
		buffer:     make(map[string][]Packet),
		vibeBuffer: make(map[string][]VibeRecord),
		dashboards: make(map[*websocket.Conn]struct{}),
		droneState: make(map[string]map[string]json.RawMessage),
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

	var dead []*websocket.Conn
	for _, c := range conns {
		c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
			dead = append(dead, c)
		}
	}
	if len(dead) > 0 {
		h.mu.Lock()
		for _, c := range dead {
			delete(h.dashboards, c)
			c.Close()
		}
		h.mu.Unlock()
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

// updateDroneState caches the latest raw data for each telemetry message type.
func (h *Hub) updateDroneState(droneID, msgType string, data json.RawMessage) {
	h.mu.Lock()
	if h.droneState[droneID] == nil {
		h.droneState[droneID] = make(map[string]json.RawMessage)
	}
	h.droneState[droneID][msgType] = data
	h.mu.Unlock()
}

// ─── Local Scoring Engine ─────────────────────────────────────────────────────

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
	n, ok := m[key]
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

// scorePwr rates battery power health using SYS_STATUS.
func scorePwr(state map[string]json.RawMessage) float64 {
	raw, ok := state["SYS_STATUS"]
	if !ok {
		return 50
	}
	score := 100.0
	if rem, ok := getFloat(raw, "battery_remaining"); ok && rem >= 0 {
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

// scoreIMU rates IMU health using SCALED_IMU.
func scoreIMU(state map[string]json.RawMessage) float64 {
	raw, ok := state["SCALED_IMU"]
	if !ok {
		return 50
	}
	score := 100.0
	if zacc, ok := getFloat(raw, "zacc"); ok {
		// zacc should be close to -1000 (mg) at rest
		if d := math.Abs(zacc + 1000); d > 150 {
			score -= math.Min(d/15, 40)
		}
	}
	return clamp(score, 0, 100)
}

// scoreEKF rates EKF health using EKF_STATUS_REPORT.
func scoreEKF(state map[string]json.RawMessage) float64 {
	raw, ok := state["EKF_STATUS_REPORT"]
	if !ok {
		return 50
	}
	score := 100.0
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
	return clamp(score, 0, 100)
}

// scoreGPS rates GPS health using GPS_RAW_INT.
func scoreGPS(state map[string]json.RawMessage) float64 {
	raw, ok := state["GPS_RAW_INT"]
	if !ok {
		return 50
	}
	score := 100.0
	if ft, ok := getFloat(raw, "fix_type"); ok {
		penalties := map[int]float64{0: 60, 1: 50, 2: 30, 3: 0, 4: 0, 5: 0, 6: 0}
		if p, exists := penalties[int(ft)]; exists {
			score -= p
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

// scoreCTL rates control stability using ATTITUDE.
func scoreCTL(state map[string]json.RawMessage) float64 {
	raw, ok := state["ATTITUDE"]
	if !ok {
		return 50
	}
	score := 100.0
	for _, axis := range []string{"roll", "pitch"} {
		if v, ok := getFloat(raw, axis); ok {
			abs := math.Abs(v)
			if abs > 0.5 {
				score -= math.Min((abs-0.5)*30, 30)
			}
		}
	}
	return clamp(score, 0, 100)
}

// scoreMOT rates motor/prop health using VIBE_NODES vibration data.
func scoreMOT(state map[string]json.RawMessage) float64 {
	raw, ok := state["VIBE_NODES"]
	if !ok {
		// Fall back to RC_CHANNELS_RAW if no vibration data yet
		if rcRaw, ok2 := state["RC_CHANNELS_RAW"]; ok2 {
			_ = rcRaw
		}
		return 50
	}
	var nodes []struct{ X, Y, Z float64 }
	var m map[string]struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
		Z float64 `json:"z"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return 50
	}
	for _, key := range []string{"n1", "n2", "n3", "n4"} {
		if n, ok := m[key]; ok {
			nodes = append(nodes, struct{ X, Y, Z float64 }{n.X, n.Y, n.Z})
		}
	}
	if len(nodes) == 0 {
		return 50
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
	score := 100.0
	if excess := avg - 12; excess > 0 {
		score -= math.Min(excess*3, 40)
	}
	asym := 0.0
	if avg > 0.1 {
		asym = (maxM - minM) / avg
	}
	if asym > 0.2 {
		score -= math.Min((asym-0.2)*50, 30)
	}
	if maxM > 25 {
		score -= math.Min((maxM-25)*2, 30)
	}
	return clamp(score, 0, 100)
}

// scoreCOM rates comms health using SYS_STATUS drop rate and last-seen time.
func scoreCOM(state map[string]json.RawMessage, lastSeen time.Time) float64 {
	score := 100.0
	if raw, ok := state["SYS_STATUS"]; ok {
		if dr, ok := getFloat(raw, "drop_rate_comm"); ok {
			pct := dr / 100.0
			if pct > 1 {
				score -= math.Min(pct*5, 40)
			}
		}
	}
	if !lastSeen.IsZero() {
		age := time.Since(lastSeen).Seconds()
		if age > 5 {
			score -= math.Min((age-5)*5, 30)
		}
	}
	return clamp(score, 0, 100)
}

func (h *Hub) computeAndBroadcastScores() {
	h.mu.RLock()
	droneIDs := make([]string, 0, len(h.stats))
	for id := range h.stats {
		droneIDs = append(droneIDs, id)
	}
	h.mu.RUnlock()

	for _, droneID := range droneIDs {
		h.mu.RLock()
		st := h.droneState[droneID]
		var lastSeen time.Time
		if s, ok := h.stats[droneID]; ok {
			lastSeen = s.LastSeen
		}
		h.mu.RUnlock()

		if st == nil {
			continue
		}

		pwr := scorePwr(st)
		imu := scoreIMU(st)
		ekf := scoreEKF(st)
		gps := scoreGPS(st)
		ctl := scoreCTL(st)
		mot := scoreMOT(st)
		com := scoreCOM(st, lastSeen)
		composite := math.Round(pwr*0.20+imu*0.10+ekf*0.20+gps*0.15+ctl*0.10+mot*0.15+com*0.10)

		scores := map[string]any{
			"pwr":       math.Round(pwr*100) / 100,
			"imu":       math.Round(imu*100) / 100,
			"ekf":       math.Round(ekf*100) / 100,
			"gps":       math.Round(gps*100) / 100,
			"ctl":       math.Round(ctl*100) / 100,
			"mot":       math.Round(mot*100) / 100,
			"com":       math.Round(com*100) / 100,
			"composite": composite,
		}

		h.broadcastToDashboards(map[string]any{
			"event":    "HEALTH_SCORES",
			"drone_id": droneID,
			"scores":   scores,
		})
		log.Printf("[scoring] %s: pwr=%.0f imu=%.0f ekf=%.0f gps=%.0f ctl=%.0f mot=%.0f com=%.0f composite=%.0f",
			droneID, pwr, imu, ekf, gps, ctl, mot, com, composite)
	}
}

func (h *Hub) runLocalScoring() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		h.computeAndBroadcastScores()
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

			// Update per-drone telemetry state for local scoring
			hub.updateDroneState(droneID, pkt.Type, pkt.Data)

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

func postTelemetryHandler(hub *Hub, apiKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req PostTelemetryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}

		if req.APIKey != apiKey {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		droneID := req.DroneID
		if droneID == "" {
			http.Error(w, `{"error":"missing drone_id"}`, http.StatusBadRequest)
			return
		}

		ctx := context.Background()
		now := time.Now().UTC()

		// Ensure stats entry exists and mark drone as seen.
		hub.mu.Lock()
		if _, exists := hub.stats[droneID]; !exists {
			hub.stats[droneID] = &DroneStats{
				DroneID:      droneID,
				ConnectedAt:  now,
				MessageTypes: make(map[string]int),
			}
		}
		hub.stats[droneID].Online = true
		hub.stats[droneID].LastSeen = now
		hub.mu.Unlock()

		processed := 0
		for _, pp := range req.Packets {
			if pp.Type == "" || pp.Data == nil {
				continue
			}

			// Convert to the canonical Packet used everywhere else.
			pkt := Packet{
				Timestamp: now.Format(time.RFC3339),
				Type:      pp.Type,
				Data:      pp.Data,
			}

			// Update in-memory stats and buffer (same as WS handler).
			hub.mu.Lock()
			s := hub.stats[droneID]
			s.MessageCount++
			s.MessageTypes[pkt.Type]++
			buf := append(hub.buffer[droneID], pkt)
			if len(buf) > 100 {
				buf = buf[len(buf)-100:]
			}
			hub.buffer[droneID] = buf
			hub.mu.Unlock()

			// Update per-drone telemetry state for local scoring
			hub.updateDroneState(droneID, pkt.Type, pkt.Data)

			// Broadcast to dashboard clients (same envelope as WS handler).
			hub.broadcastToDashboards(map[string]any{
				"event":    "telemetry",
				"drone_id": droneID,
				"packet":   pkt,
			})

			// Push to Redis Stream for the workers scoring pipeline.
			// Re-encode as the full gateway packet shape the workers expect.
			raw, err := json.Marshal(map[string]any{
				"drone_id": droneID,
				"type":     pkt.Type,
				"ts":       pp.Ts,
				"data":     pp.Data,
			})
			if err == nil {
				pushToStream(ctx, droneID, raw)
			}

			// VIBE_NODES: store in the in-memory vibration ring buffer.
			if pp.Type == "VIBE_NODES" {
				var vd VibeNodesData
				if err := json.Unmarshal(pp.Data, &vd); err == nil {
					rec := VibeRecord{
						DroneID: droneID,
						Ts:      pp.Ts,
						WallTs:  now,
						N1:      vd.N1,
						N2:      vd.N2,
						N3:      vd.N3,
						N4:      vd.N4,
					}
					hub.mu.Lock()
					vbuf := append(hub.vibeBuffer[droneID], rec)
					if len(vbuf) > 500 {
						vbuf = vbuf[len(vbuf)-500:]
					}
					hub.vibeBuffer[droneID] = vbuf
					hub.mu.Unlock()
				}
			}

			processed++
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"received": processed,
		})
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

// vibrationAPIHandler serves GET /api/vibration?drone_id=&from=&to=
// from/to are optional unix millisecond timestamps for time-range filtering.
func vibrationAPIHandler(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		droneID := r.URL.Query().Get("drone_id")
		if droneID == "" {
			http.Error(w, `{"error":"missing drone_id"}`, http.StatusBadRequest)
			return
		}

		fromMs, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
		toMs, _ := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)

		hub.mu.RLock()
		all := hub.vibeBuffer[droneID]
		hub.mu.RUnlock()

		filtered := make([]VibeRecord, 0, len(all))
		for _, rec := range all {
			wt := rec.WallTs.UnixMilli()
			if fromMs > 0 && wt < fromMs {
				continue
			}
			if toMs > 0 && wt > toMs {
				continue
			}
			filtered = append(filtered, rec)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"drone_id": droneID,
			"records":  filtered,
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

	// Start local scoring engine (runs even without Redis)
	go hub.runLocalScoring()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/drone/ws", droneWSHandler(hub, apiKey))
	mux.HandleFunc("/drone/telemetry", postTelemetryHandler(hub, apiKey))
	mux.HandleFunc("/dashboard/ws", dashboardWSHandler(hub))
	mux.HandleFunc("/api/drones", dronesAPIHandler(hub))
	mux.HandleFunc("/api/telemetry", telemetryAPIHandler(hub))
	mux.HandleFunc("/api/vibration", vibrationAPIHandler(hub))
	mux.HandleFunc("/", dashboardPageHandler)

	log.Printf("DronePulse gateway listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
