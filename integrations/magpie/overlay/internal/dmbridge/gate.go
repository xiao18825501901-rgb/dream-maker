// Package dmbridge guards the sole listener inside the DM-specific Magpie process.
// Grant is controller-pipe-only. This package owns neither scheduling nor budgets.
package dmbridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const bodyLimit = 2 * 1024 * 1024

var denied = errors.New("DM_MAGPIE_ADMISSION_DENIED")
var ref = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
var modelRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`)
var accountID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,170}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// CodexCredentialBinding binds ephemeral request headers to an owner grant. It
// is not a login or qualification proof and never replaces upstream authentication.
func CodexCredentialBinding(h http.Header) string {
	auth, workspace := h.Values("Authorization"), h.Values("ChatGPT-Account-ID")
	if len(auth) != 1 || len(workspace) > 1 || !strings.HasPrefix(auth[0], "Bearer ") {
		return ""
	}
	token := strings.TrimPrefix(auth[0], "Bearer ")
	if len(token) == 0 || len(token) > 16384 || strings.IndexFunc(token, func(c rune) bool { return c < 33 || c > 126 }) >= 0 {
		return ""
	}
	id := ""
	if len(workspace) == 1 {
		id = workspace[0]
		if !accountID.MatchString(id) {
			return ""
		}
	}
	sum := sha256.Sum256([]byte(auth[0] + "\x00" + id))
	return hex.EncodeToString(sum[:])
}

func codexSubscriptionAccept(h http.Header) bool {
	values := h.Values("Accept")
	return len(values) == 1 && values[0] == "text/event-stream"
}

type Admission struct {
	SubscriptionRequestHash string `json:"subscriptionRequestHash,omitempty"`
	Token                   string `json:"token"`
	ID                      string `json:"id"`
	Epoch                   string `json:"epoch"`
	ProjectID               string `json:"projectId"`
	FlowID                  string `json:"flowId"`
	ConfigurationHash       string `json:"configurationHash"`
	BindingHash             string `json:"bindingHash"`
	RouteHash               string `json:"routeHash"`
	RoleID                  string `json:"roleId"`
	Role                    string `json:"role"`
	ReservationID           string `json:"reservationId"`
	Provider                string `json:"provider"`
	Runtime                 string `json:"runtime"`
	Protocol                string `json:"protocol"`
	Authentication          string `json:"authentication"`
	Model                   string `json:"model"`
	AccountRef              string `json:"accountRef"`
	UpstreamAccountRef      string `json:"upstreamAccountRef"`
	AuthRef                 string `json:"authRef"`
	UpstreamKeyID           string `json:"upstreamKeyId"`
	UpstreamKey             string `json:"upstreamKey"`
	Method                  string `json:"method"`
	Path                    string `json:"path"`
	BodyHash                string `json:"bodyHash"`
	ExpiresAtMs             int64  `json:"expiresAtMs"`
	MaxInputTokens          int64  `json:"maxInputTokens"`
	MaxOutputTokens         int64  `json:"maxOutputTokens"`
}
type Config struct {
	Epoch, Authority    string
	Now                 func() time.Time
	Authorize           func(Admission) error
	ValidateRequest     func(Admission, []byte) error
	Handler             http.Handler
	SubscriptionHandler http.Handler
}
type Gate struct {
	config      Config
	mu          sync.Mutex
	pending     map[string]Admission
	tokens, ids map[string]bool
}

type Acknowledgement struct {
	Type          string `json:"type"`
	Schema        string `json:"schema"`
	Epoch         string `json:"epoch"`
	ID            string `json:"id"`
	ReservationID string `json:"reservationId"`
	ControlHash   string `json:"controlHash"`
	Accepted      bool   `json:"accepted"`
}

// GrantFrame is called only from the inherited owner pipe, never from HTTP.
// The acknowledgement identifies the exact bytes, including their original order;
// no token or scoped upstream key is echoed or persisted here.
func (g *Gate) GrantFrame(raw []byte) (Acknowledgement, error) {
	var cmd struct {
		Type      string     `json:"type"`
		Admission *Admission `json:"admission"`
	}
	if len(raw) > 16384 {
		return Acknowledgement{}, denied
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&cmd) != nil || cmd.Type != "grant" || cmd.Admission == nil {
		return Acknowledgement{}, denied
	}
	var tail any
	if d.Decode(&tail) != io.EOF || !ref.MatchString(cmd.Admission.ID) || !ref.MatchString(cmd.Admission.ReservationID) {
		return Acknowledgement{}, denied
	}
	sum := sha256.Sum256(raw)
	return Acknowledgement{Type: "admission", Schema: "dream-maker.magpie-admission-ack.v2", Epoch: g.config.Epoch, ID: cmd.Admission.ID, ReservationID: cmd.Admission.ReservationID, ControlHash: hex.EncodeToString(sum[:]), Accepted: g.Grant(*cmd.Admission) == nil}, nil
}

const codexSubscriptionPath = "/backend-api/codex/responses"

func codexSubscription(a Admission) bool {
	return a.Provider == "openai" && a.Runtime == "codex" && a.Authentication == "oauth" && a.Protocol == "openai-responses"
}

func admissionPath(a Admission) string {
	if codexSubscription(a) {
		return codexSubscriptionPath
	}
	return protocolPath(a.Protocol)
}

func route(method, path string) bool {
	return method == "POST" && (path == "/v1/chat/completions" || path == "/v1/responses" || path == "/v1/messages" || path == codexSubscriptionPath)
}
func protocolPath(protocol string) string {
	switch protocol {
	case "chat-completions":
		return "/v1/chat/completions"
	case "openai-responses":
		return "/v1/responses"
	case "anthropic-messages":
		return "/v1/messages"
	default:
		return ""
	}
}
func concreteRef(value string) bool {
	return ref.MatchString(value) && !strings.EqualFold(value, "UNKNOWN") && !strings.EqualFold(value, "NOT_VERIFIED")
}
func canonicalAccount(provider, value string) bool {
	pid, account, ok := strings.Cut(value, "/")
	return ok && len(value) <= 300 && pid == provider && accountID.MatchString(account) && !strings.EqualFold(account, "UNKNOWN") && !strings.EqualFold(account, "NOT_VERIFIED")
}

// AdmissionRouteHash binds a concrete, already resolved route. It is not account proof.
// Its canonical ASCII JSON matches the original controller hash, without storing an account name.
func AdmissionRouteHash(a Admission) (string, error) {
	for _, value := range []string{a.Runtime, a.Provider, a.AuthRef, a.AccountRef} {
		if !concreteRef(value) {
			return "", denied
		}
	}
	if protocolPath(a.Protocol) == "" || (a.Authentication != "api_key" && a.Authentication != "oauth") || !modelRef.MatchString(a.Model) || strings.Contains(a.Model, "://") || !canonicalAccount(a.Provider, a.UpstreamAccountRef) {
		return "", denied
	}
	account := sha256.Sum256([]byte(a.UpstreamAccountRef))
	encoded, err := json.Marshal(map[string]string{"runtime": a.Runtime, "provider": a.Provider, "protocol": a.Protocol, "model": a.Model, "authentication": a.Authentication, "authRef": a.AuthRef, "accountRef": a.AccountRef, "upstreamAccountHash": hex.EncodeToString(account[:])})
	if err != nil {
		return "", denied
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// AccountScopeMatches compares the real limited key scope to the resolved upstream
// account, never to the user's DM alias. Empty, wildcard or multiple scopes are refused.
func AccountScopeMatches(a Admission, accounts []string) bool {
	return canonicalAccount(a.Provider, a.UpstreamAccountRef) && len(accounts) == 1 && accounts[0] == a.UpstreamAccountRef
}
func New(c Config) (*Gate, error) {
	host, port, e := net.SplitHostPort(c.Authority)
	number, pe := strconv.Atoi(port)
	if e != nil || pe != nil || host != "127.0.0.1" || number < 1 || number > 65535 || !ref.MatchString(c.Epoch) || c.Authorize == nil || c.ValidateRequest == nil || c.Handler == nil {
		return nil, denied
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return &Gate{config: c, pending: map[string]Admission{}, tokens: map[string]bool{}, ids: map[string]bool{}}, nil
}

// The trusted parent supplies a previously reserved, immutable, concrete request.
// Reaching this method is not a substitute for the original Engine reservation.
func (g *Gate) Grant(a Admission) error {
	if a.MaxInputTokens < 1 || a.MaxInputTokens > 9007199254740991 || a.MaxOutputTokens < 1 || a.MaxOutputTokens > 9007199254740991 {
		return denied
	}
	if a.Epoch != g.config.Epoch || !digest.MatchString(a.Token) || !digest.MatchString(a.ConfigurationHash) || !digest.MatchString(a.BindingHash) || !digest.MatchString(a.RouteHash) || !digest.MatchString(a.BodyHash) || !route(a.Method, a.Path) {
		return denied
	}
	if codexSubscription(a) {
		if g.config.SubscriptionHandler == nil || !digest.MatchString(a.SubscriptionRequestHash) {
			return denied
		}
	} else if a.SubscriptionRequestHash != "" {
		return denied
	}
	routeHash, routeError := AdmissionRouteHash(a)
	if routeError != nil || routeHash != a.RouteHash || a.Path != admissionPath(a) || (codexSubscription(a) && a.Role != "planner2") {
		return denied
	}
	for _, v := range []string{a.ID, a.ProjectID, a.FlowID, a.RoleID, a.ReservationID, a.Provider, a.AccountRef, a.AuthRef, a.UpstreamKeyID} {
		if !ref.MatchString(v) {
			return denied
		}
	}
	if a.Role == "planner2" || a.Role == "reviewer" {
		if a.RoleID != a.Role {
			return denied
		}
	} else if a.Role != "executor" || a.RoleID == "planner2" || a.RoleID == "reviewer" {
		return denied
	}
	if !modelRef.MatchString(a.Model) || strings.Contains(a.Model, "://") || a.UpstreamKey == "" || len(a.UpstreamKey) > 512 || strings.ContainsAny(a.UpstreamKey, "\r\n") {
		return denied
	}
	remaining := a.ExpiresAtMs - g.config.Now().UnixMilli()
	if remaining <= 0 || remaining > 120000 {
		return denied
	}
	if g.config.Authorize(a) != nil {
		return denied
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for token, old := range g.pending {
		if old.ExpiresAtMs <= g.config.Now().UnixMilli() {
			delete(g.pending, token)
		}
	}
	if len(g.pending) >= 128 || len(g.tokens) >= 4096 || g.tokens[a.Token] || g.ids[a.ID] {
		return denied
	}
	g.tokens[a.Token] = true
	g.ids[a.ID] = true
	g.pending[a.Token] = a
	return nil
}
func (g *Gate) take(token, method, path string) (Admission, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	a, ok := g.pending[token]
	if !ok {
		return Admission{}, denied
	}
	delete(g.pending, token) // no replay, including malformed bodies or lost replies
	if a.ExpiresAtMs <= g.config.Now().UnixMilli() || a.Method != method || a.Path != path {
		return Admission{}, denied
	}
	return a, nil
}
func reject(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = io.WriteString(w, `{"error":"DM_MAGPIE_ADMISSION_DENIED"}`)
}

// RequestFields is shared by ingress and final physical-send checks. A duplicated
// or differently cased budget field must never be interpreted by a second parser.
func RequestFields(body []byte) (map[string]json.RawMessage, error) {
	if len(body) > bodyLimit {
		return nil, denied
	}
	d := json.NewDecoder(bytes.NewReader(body))
	token, e := d.Token()
	if e != nil || token != json.Delim('{') {
		return nil, denied
	}
	fields := map[string]json.RawMessage{}
	for d.More() {
		token, e = d.Token()
		key, ok := token.(string)
		if e != nil || !ok || fields[key] != nil {
			return nil, denied
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, denied
		}
		fields[key] = value
	}
	if _, e = d.Token(); e != nil {
		return nil, denied
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return nil, denied
	}
	return fields, nil
}
func bodyModel(body []byte) (string, error) {
	fields, err := RequestFields(body)
	if err != nil {
		return "", err
	}
	var model string
	if json.Unmarshal(fields["model"], &model) != nil {
		return "", denied
	}
	return model, nil
}
func (g *Gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	if e != nil || ip == nil || !ip.IsLoopback() || r.Host != g.config.Authority || r.URL.RawQuery != "" || r.URL.RawPath != "" || !route(r.Method, r.URL.Path) {
		reject(w)
		return
	}
	for _, name := range []string{"Origin", "Referer", "Sec-Fetch-Site", "Upgrade", "X-Api-Key"} {
		if len(r.Header.Values(name)) > 0 {
			reject(w)
			return
		}
	}
	auth := r.Header.Values("Authorization")
	if len(auth) != 1 || !strings.HasPrefix(auth[0], "Bearer ") {
		reject(w)
		return
	}
	token := strings.TrimPrefix(auth[0], "Bearer ")
	if r.URL.Path == codexSubscriptionPath {
		grant := r.Header.Values("X-DM-Gateway")
		if len(grant) != 1 || CodexCredentialBinding(r.Header) == "" {
			reject(w)
			return
		}
		token = grant[0]
	}
	if !digest.MatchString(token) {
		reject(w)
		return
	}
	media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || media != "application/json" || r.ContentLength > bodyLimit {
		reject(w)
		return
	}
	a, e := g.take(token, r.Method, r.URL.Path)
	if e != nil {
		reject(w)
		return
	}
	body, e := io.ReadAll(io.LimitReader(r.Body, bodyLimit+1))
	if e != nil || len(body) > bodyLimit {
		reject(w)
		return
	}
	sum := sha256.Sum256(body)
	model, e := bodyModel(body)
	expectedModel := a.Provider + "/" + a.Model
	if codexSubscription(a) {
		expectedModel = a.Model
		if !codexSubscriptionAccept(r.Header) || CodexCredentialBinding(r.Header) != a.SubscriptionRequestHash {
			reject(w)
			return
		}
	}
	if e != nil || hex.EncodeToString(sum[:]) != a.BodyHash || model != expectedModel || a.ExpiresAtMs <= g.config.Now().UnixMilli() || g.config.Authorize(a) != nil || g.config.ValidateRequest(a, body) != nil {
		reject(w)
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), time.UnixMilli(a.ExpiresAtMs))
	defer cancel()
	if ctx.Err() != nil {
		reject(w)
		return
	}
	forwarded := r.Clone(withPhysicalAttempt(ctx, a, g.config.Now))
	forwarded.Header = make(http.Header)
	forwarded.Header.Set("Authorization", "Bearer "+a.UpstreamKey)
	forwarded.Header.Set("Content-Type", "application/json")
	forwarded.Header.Set("Accept", "text/event-stream, application/json")
	forwarded.Header.Set("User-Agent", "DreamMaker-Dedicated-Magpie")
	forwarded.Body = io.NopCloser(bytes.NewReader(body))
	forwarded.ContentLength = int64(len(body))
	forwarded.TransferEncoding = nil
	forwarded.GetBody = nil
	if codexSubscription(a) {
		forwarded.Header.Set("Authorization", auth[0])
		forwarded.Header.Set("Accept", "text/event-stream")
		if id := r.Header.Get("ChatGPT-Account-ID"); id != "" {
			forwarded.Header.Set("ChatGPT-Account-ID", id)
		}
		g.config.SubscriptionHandler.ServeHTTP(w, forwarded)
		return
	}
	g.config.Handler.ServeHTTP(w, forwarded)
}
