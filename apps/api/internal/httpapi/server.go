package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"audiohub/api/internal/db"
	"github.com/google/uuid"
	"github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type Server struct{ store *db.Store }

func New(s *db.Store) *Server { return &Server{store: s} }
func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func decode(r *http.Request, v any) error { return json.NewDecoder(r.Body).Decode(v) }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, map[string]any{"ok": true, "time": time.Now()})
	})
	mux.HandleFunc("GET /api/channels", s.listChannels)
	mux.HandleFunc("POST /api/channels", s.createChannel)
	mux.HandleFunc("GET /api/devices", s.listDevices)
	mux.HandleFunc("POST /api/devices/provision", s.provisionDevice)
	mux.HandleFunc("POST /api/devices/{id}/heartbeat", s.heartbeat)
	mux.HandleFunc("PATCH /api/devices/{id}", s.updateDevice)
	mux.HandleFunc("POST /api/channels/{id}/assign", s.assignDevice)
	mux.HandleFunc("POST /api/livekit/token", s.livekitToken)
	mux.HandleFunc("GET /api/sessions", s.listSessions)
	mux.HandleFunc("POST /api/sessions/start", s.startSession)
	mux.HandleFunc("POST /api/sessions/{id}/stop", s.stopSession)
	return cors(mux)
}
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := os.Getenv("CORS_ORIGIN")
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) listChannels(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.Pool.Query(r.Context(), `SELECT id,name,slug,coalesce(description,''),priority,is_active,created_at FROM channels ORDER BY priority DESC,name`)
	if err != nil {
		jsonOut(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, slug, desc string
		var p int
		var active bool
		var created time.Time
		_ = rows.Scan(&id, &name, &slug, &desc, &p, &active, &created)
		out = append(out, map[string]any{"id": id, "name": name, "slug": slug, "description": desc, "priority": p, "isActive": active, "createdAt": created})
	}
	jsonOut(w, 200, out)
}
func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name, Slug, Description string
		Priority                int
	}
	if decode(r, &in) != nil || in.Name == "" || in.Slug == "" {
		jsonOut(w, 400, map[string]string{"error": "name and slug required"})
		return
	}
	if in.Priority == 0 {
		in.Priority = 5
	}
	var id string
	err := s.store.Pool.QueryRow(r.Context(), `INSERT INTO channels(name,slug,description,priority) VALUES($1,$2,$3,$4) RETURNING id`, in.Name, in.Slug, in.Description, in.Priority).Scan(&id)
	if err != nil {
		jsonOut(w, 400, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, 201, map[string]string{"id": id})
}
func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.Pool.Query(r.Context(), `SELECT id,name,device_key,type,coalesce(location,''),CASE WHEN last_seen_at > now()-interval '30 seconds' THEN 'online' ELSE 'offline' END,volume,last_seen_at,created_at FROM devices ORDER BY name`)
	if err != nil {
		jsonOut(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, n, k, t, l, st string
		var vol int
		var seen *time.Time
		var created time.Time
		_ = rows.Scan(&id, &n, &k, &t, &l, &st, &vol, &seen, &created)
		out = append(out, map[string]any{"id": id, "name": n, "deviceKey": k, "type": t, "location": l, "status": st, "volume": vol, "lastSeenAt": seen, "createdAt": created})
	}
	jsonOut(w, 200, out)
}
func (s *Server) provisionDevice(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name, Type, Location string }
	_ = decode(r, &in)
	if in.Type != "player" && in.Type != "broadcaster" {
		jsonOut(w, 400, map[string]string{"error": "type must be player or broadcaster"})
		return
	}
	key := strings.ToUpper(uuid.NewString()[0:8])
	var id string
	err := s.store.Pool.QueryRow(r.Context(), `INSERT INTO devices(name,device_key,type,location) VALUES($1,$2,$3,$4) RETURNING id`, in.Name, key, in.Type, in.Location).Scan(&id)
	if err != nil {
		jsonOut(w, 500, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, 201, map[string]string{"id": id, "deviceKey": key})
}
func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ct, err := s.store.Pool.Exec(r.Context(), `UPDATE devices SET last_seen_at=now(),status='online' WHERE id=$1`, id)
	if err != nil || ct.RowsAffected() == 0 {
		jsonOut(w, 404, map[string]string{"error": "device not found"})
		return
	}
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Server) updateDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in struct {
		Name, Location string
		Volume         *int
	}
	_ = decode(r, &in)
	_, err := s.store.Pool.Exec(r.Context(), `UPDATE devices SET name=COALESCE(NULLIF($2,''),name),location=COALESCE(NULLIF($3,''),location),volume=COALESCE($4,volume) WHERE id=$1`, id, in.Name, in.Location, in.Volume)
	if err != nil {
		jsonOut(w, 400, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Server) assignDevice(w http.ResponseWriter, r *http.Request) {
	cid := r.PathValue("id")
	var in struct{ DeviceID, Role string }
	_ = decode(r, &in)
	if in.Role != "listener" && in.Role != "broadcaster" {
		jsonOut(w, 400, map[string]string{"error": "invalid role"})
		return
	}
	_, err := s.store.Pool.Exec(r.Context(), `INSERT INTO channel_devices(channel_id,device_id,role) VALUES($1,$2,$3) ON CONFLICT(channel_id,device_id) DO UPDATE SET role=excluded.role`, cid, in.DeviceID, in.Role)
	if err != nil {
		jsonOut(w, 400, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, 200, map[string]bool{"ok": true})
}
func (s *Server) livekitToken(w http.ResponseWriter, r *http.Request) {
	var in struct{ Room, Identity, Name, Role string }
	_ = decode(r, &in)
	if in.Room == "" || in.Identity == "" {
		jsonOut(w, 400, map[string]string{"error": "room and identity required"})
		return
	}
	key, secret := os.Getenv("LIVEKIT_API_KEY"), os.Getenv("LIVEKIT_API_SECRET")
	at := auth.NewAccessToken(key, secret)
	grant := &auth.VideoGrant{RoomJoin: true, Room: in.Room, CanSubscribe: boolPtr(true)}
	if in.Role == "broadcaster" {
		grant.CanPublish = boolPtr(true)
	} else {
		grant.CanPublish = boolPtr(false)
	}
	at.AddGrant(grant).SetIdentity(in.Identity).SetName(in.Name).SetValidFor(2 * time.Hour)
	token, err := at.ToJWT()
	if err != nil {
		jsonOut(w, 500, map[string]string{"error": err.Error()})
		return
	}
	url := os.Getenv("PUBLIC_LIVEKIT_URL")
	jsonOut(w, 200, map[string]string{"token": token, "url": url})
}
func boolPtr(v bool) *bool { return &v }
func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.Pool.Query(r.Context(), `SELECT bs.id,c.name,bs.started_at,bs.ended_at,bs.peak_listeners,bs.status FROM broadcast_sessions bs JOIN channels c ON c.id=bs.channel_id ORDER BY bs.started_at DESC LIMIT 100`)
	if err != nil {
		jsonOut(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, channel, status string
		var start time.Time
		var end *time.Time
		var peak int
		_ = rows.Scan(&id, &channel, &start, &end, &peak, &status)
		out = append(out, map[string]any{"id": id, "channel": channel, "startedAt": start, "endedAt": end, "peakListeners": peak, "status": status})
	}
	jsonOut(w, 200, out)
}
func (s *Server) startSession(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ChannelID           string
		BroadcasterDeviceID *string
	}
	_ = decode(r, &in)
	var id string
	err := s.store.Pool.QueryRow(r.Context(), `INSERT INTO broadcast_sessions(channel_id,broadcaster_device_id) VALUES($1,$2) RETURNING id`, in.ChannelID, in.BroadcasterDeviceID).Scan(&id)
	if err != nil {
		jsonOut(w, 400, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, 201, map[string]string{"id": id})
}
func (s *Server) stopSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_, err := s.store.Pool.Exec(r.Context(), `UPDATE broadcast_sessions SET ended_at=now(),status='ended' WHERE id=$1`, id)
	if err != nil {
		jsonOut(w, 500, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, 200, map[string]bool{"ok": true})
}

func ShutdownLiveKit(ctx context.Context) {
	client := lksdk.NewRoomServiceClient(os.Getenv("LIVEKIT_URL"), os.Getenv("LIVEKIT_API_KEY"), os.Getenv("LIVEKIT_API_SECRET"))
	_ = client
	_ = ctx
}
func LogErr(err error) {
	if err != nil {
		log.Print(fmt.Errorf("audiohub: %w", err))
	}
}
