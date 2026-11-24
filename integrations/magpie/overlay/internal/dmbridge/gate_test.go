package dmbridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// This suite exercises the in-process ingress only, with a synthetic backend.
// It is not Magpie/role/provider Live evidence.
const payload = `{"model":"example/model-a","messages":[]}`

func sample() Admission {
	sum := sha256.Sum256([]byte(payload))
	a := Admission{Token: strings.Repeat("a", 64), ID: "req-1", Epoch: "epoch-1", ProjectID: "project-1", FlowID: "flow-1", ConfigurationHash: strings.Repeat("b", 64), BindingHash: strings.Repeat("c", 64), RoleID: "planner2", Role: "planner2", ReservationID: "reserved-1", Provider: "example", Runtime: "dsh", Protocol: "chat-completions", Authentication: "api_key", Model: "model-a", AccountRef: "dm-account-1", UpstreamAccountRef: "example/0123456789", AuthRef: "dm-auth-1", UpstreamKeyID: "key-1", UpstreamKey: "SYNTHETIC_UPSTREAM_KEY", Method: "POST", Path: "/v1/chat/completions", BodyHash: hex.EncodeToString(sum[:]), ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli()}
	a.RouteHash, _ = AdmissionRouteHash(a)
	a.MaxInputTokens = 1048576
	a.MaxOutputTokens = 128
	return a
}

func TestLedgerTokenLimitsMustBePresentAndPositive(t *testing.T) {
	g := fixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("backend reached") }))
	for _, field := range []string{"maxInputTokens", "maxOutputTokens"} {
		for _, value := range []string{"0", "-1", "9007199254740992"} {
			a := sample()
			if json.Unmarshal([]byte(`{"`+field+`":`+value+`}`), &a) != nil {
				t.Fatal("fixture invalid")
			}
			if g.Grant(a) == nil {
				t.Fatalf("invalid %s accepted: %s", field, value)
			}
		}
	}
}

func TestMissingIngressInputPolicyCannotStartAGate(t *testing.T) {
	_, err := New(Config{Epoch: "epoch-1", Authority: "127.0.0.1:43123", Authorize: func(Admission) error { return nil }, Handler: http.NotFoundHandler()})
	if err == nil {
		t.Fatal("gateway without an input policy was allowed to start")
	}
}
func request(a Admission, body string) *http.Request {
	r := httptest.NewRequest(a.Method, "http://127.0.0.1:43123"+a.Path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50000"
	r.Header.Set("Authorization", "Bearer "+a.Token)
	r.Header.Set("Content-Type", "application/json")
	return r
}
func fixture(t *testing.T, handler http.Handler) *Gate {
	t.Helper()
	g, err := New(Config{Epoch: "epoch-1", Authority: "127.0.0.1:43123", Authorize: func(a Admission) error { return nil }, ValidateRequest: allowSyntheticInput, Handler: handler})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// Generic bridge fixtures deliberately use a synthetic policy. The actual main
// binds gateway.CheckDreamMakerIngress; these fixtures never qualify that route.
func allowSyntheticInput(Admission, []byte) error { return nil }
func TestDefaultTokensAndIssuerAreDenied(t *testing.T) {
	var calls int
	g := fixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	for _, path := range []string{"/v1/chat/completions", "/v1/magpie/keys", "/v1/responses", "/v1/magpie/restart", "/v1/models"} {
		for _, token := range []string{"", "magpie", "magpie-codex", strings.Repeat("f", 64)} {
			a := sample()
			a.Path = path
			a.Token = token
			w := httptest.NewRecorder()
			g.ServeHTTP(w, request(a, payload))
			if w.Code < 400 {
				t.Fatalf("unauthorized %s returned %d", path, w.Code)
			}
		}
	}
	if calls != 0 {
		t.Fatal("backend reached")
	}
}
func TestOneAdmissionBindsBodyAndConsumesOnce(t *testing.T) {
	var calls int
	g := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer SYNTHETIC_UPSTREAM_KEY" || r.Header.Get("X-Override-Account") != "" {
			t.Error("caller authority leaked")
		}
		b, _ := io.ReadAll(r.Body)
		if string(b) != payload {
			t.Error("body changed")
		}
		w.WriteHeader(204)
	}))
	a := sample()
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	r := request(a, payload)
	r.Header.Set("X-Override-Account", "other-account")
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	g.ServeHTTP(w, request(a, payload))
	if w.Code < 400 || calls != 1 {
		t.Fatal("replay reached backend")
	}
	if g.Grant(a) == nil {
		t.Fatal("used grant was reissued")
	}
}
func TestChangedBodyAndConflictingModelCannotReachBackend(t *testing.T) {
	for _, body := range []string{payload + " ", `{"model":"example/model-b"}`, `{"model":"example/model-a","model":"example/model-b"}`} {
		g := fixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("backend reached") }))
		a := sample()
		if err := g.Grant(a); err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, request(a, body))
		if w.Code < 400 {
			t.Fatal(w.Code)
		}
	}
}
func TestScopeAndGrantBoundsFailClosed(t *testing.T) {
	edits := []func(*Admission){func(a *Admission) { a.Epoch = "other" }, func(a *Admission) { a.ProjectID = "" }, func(a *Admission) { a.ReservationID = "" }, func(a *Admission) { a.ConfigurationHash = "bad" }, func(a *Admission) { a.RoleID = "planner1" }, func(a *Admission) { a.ExpiresAtMs = time.Now().Add(-time.Second).UnixMilli() }, func(a *Admission) { a.ExpiresAtMs = time.Now().Add(3 * time.Minute).UnixMilli() }, func(a *Admission) { a.Path = "/v1/magpie/keys" }, func(a *Admission) { a.Method = "GET" }, func(a *Admission) { a.UpstreamKey = "" }}
	for _, edit := range edits {
		g := fixture(t, http.NotFoundHandler())
		a := sample()
		edit(&a)
		if g.Grant(a) == nil {
			t.Fatal("invalid admission accepted")
		}
	}
	if _, err := New(Config{Epoch: "epoch-1", Authority: "0.0.0.0:43123", Authorize: func(Admission) error { return nil }, ValidateRequest: allowSyntheticInput, Handler: http.NotFoundHandler()}); err == nil {
		t.Fatal("non-loopback binding accepted")
	}
	if _, err := New(Config{Epoch: "epoch-1", Authority: "127.0.0.1:43123", ValidateRequest: allowSyntheticInput, Handler: http.NotFoundHandler()}); err == nil {
		t.Fatal("no authorization validator accepted")
	}
}
func TestBrowserRemoteEncodedAndDuplicateAuthRequestsAreDenied(t *testing.T) {
	edits := []func(*http.Request){func(r *http.Request) { r.Header.Set("Origin", "http://127.0.0.1") }, func(r *http.Request) { r.RemoteAddr = "192.0.2.1:5" }, func(r *http.Request) { r.Host = "evil.example" }, func(r *http.Request) { r.URL.RawQuery = "model=other" }, func(r *http.Request) { r.URL.RawPath = "/v1/%63hat/completions" }, func(r *http.Request) { r.Header.Add("Authorization", "Bearer second") }, func(r *http.Request) { r.Header.Set("X-Api-Key", "magpie") }, func(r *http.Request) { r.Header.Set("Upgrade", "websocket") }}
	for _, edit := range edits {
		g := fixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("backend reached") }))
		a := sample()
		if err := g.Grant(a); err != nil {
			t.Fatal(err)
		}
		r := request(a, payload)
		edit(r)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code < 400 {
			t.Fatal(w.Code)
		}
	}
}
func TestOversizedBodyAndExpiredAtUseAreDenied(t *testing.T) {
	g := fixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("backend reached") }))
	a := sample()
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	g.ServeHTTP(w, request(a, strings.Repeat("x", 2*1024*1024+1)))
	if w.Code < 400 {
		t.Fatal(w.Code)
	}
	now := time.Now()
	g, err := New(Config{Epoch: "epoch-1", Authority: "127.0.0.1:43123", Now: func() time.Time { return now }, Authorize: func(Admission) error { return nil }, ValidateRequest: allowSyntheticInput, Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("expired backend reached") })})
	if err != nil {
		t.Fatal(err)
	}
	a = sample()
	if err = g.Grant(a); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	w = httptest.NewRecorder()
	g.ServeHTTP(w, request(a, payload))
	if w.Code < 400 {
		t.Fatal(w.Code)
	}
}
func TestConcurrentReplayReachesBackendAtMostOnce(t *testing.T) {
	var calls atomic.Int32
	g := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(204) }))
	a := sample()
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); g.ServeHTTP(httptest.NewRecorder(), request(a, payload)) }()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
}
func TestExecutorIdentityDoesNotRequireAnInventedPrefix(t *testing.T) {
	g := fixture(t, http.NotFoundHandler())
	a := sample()
	a.RoleID = "my-worker-01"
	a.Role = "executor"
	if err := g.Grant(a); err != nil {
		t.Fatal("a valid original Custom executor ID was refused", err)
	}
}
func TestRevocationIsRecheckedBeforeBackendDispatch(t *testing.T) {
	checks := 0
	g, err := New(Config{Epoch: "epoch-1", Authority: "127.0.0.1:43123", ValidateRequest: allowSyntheticInput, Authorize: func(Admission) error {
		checks++
		if checks > 1 {
			return io.ErrClosedPipe
		}
		return nil
	}, Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("revoked backend reached") })})
	if err != nil {
		t.Fatal(err)
	}
	a := sample()
	if err = g.Grant(a); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	g.ServeHTTP(w, request(a, payload))
	if w.Code < 400 || checks != 2 {
		t.Fatal(w.Code, checks)
	}
}
func TestDuplicateModelIsDeniedEvenWhenRawBodyWasBound(t *testing.T) {
	body := `{"model":"example/model-a","model":"example/model-a"}`
	a := sample()
	sum := sha256.Sum256([]byte(body))
	a.BodyHash = hex.EncodeToString(sum[:])
	g := fixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("ambiguous JSON reached backend") }))
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	g.ServeHTTP(w, request(a, body))
	if w.Code < 400 {
		t.Fatal(w.Code)
	}
}

func TestOriginalRequestAndRouteDigestsAreRequired(t *testing.T) {
	for _, field := range []string{"bindingHash", "routeHash"} {
		g := fixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("backend reached") }))
		raw, _ := json.Marshal(sample())
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		fields["bindingHash"] = strings.Repeat("c", 64)
		fields["routeHash"] = strings.Repeat("d", 64)
		fields[field] = "invalid"
		raw, _ = json.Marshal(fields)
		var a Admission
		_ = json.Unmarshal(raw, &a)
		if g.Grant(a) == nil {
			t.Fatal("unbound original request accepted", field)
		}
	}
}

func TestControlAcknowledgementBindsTheExactFrameAndContainsNoKeys(t *testing.T) {
	g := fixture(t, http.NotFoundHandler())
	a := sample()
	raw, _ := json.Marshal(map[string]any{"type": "grant", "admission": a})
	ack, err := g.GrantFrame(raw)
	sum := sha256.Sum256(raw)
	if err != nil || !ack.Accepted || ack.Type != "admission" || ack.Schema != "dream-maker.magpie-admission-ack.v2" || ack.Epoch != a.Epoch || ack.ID != a.ID || ack.ReservationID != a.ReservationID || ack.ControlHash != hex.EncodeToString(sum[:]) {
		t.Fatal("acknowledgement did not identify its exact frame")
	}
	output, _ := json.Marshal(ack)
	if strings.Contains(string(output), a.Token) || strings.Contains(string(output), a.UpstreamKey) {
		t.Fatal("credential echoed")
	}
	second, err := g.GrantFrame(raw)
	if err != nil || second.Accepted || second.ControlHash != ack.ControlHash {
		t.Fatal("replay was not negatively acknowledged")
	}
}

func TestMalformedControlFramesHaveNoAdmission(t *testing.T) {
	g := fixture(t, http.NotFoundHandler())
	a := sample()
	raw, _ := json.Marshal(map[string]any{"type": "grant", "admission": a, "verified": true})
	for _, value := range [][]byte{raw, []byte(`{"type":"grant"}`), []byte(`{"type":"stop"}`), []byte(strings.Repeat(" ", 16385)), []byte(`{"type":"grant","admission":{"id":"invalid/ID"}}`)} {
		if _, err := g.GrantFrame(value); err == nil {
			t.Fatal("malformed control frame accepted")
		}
	}
	if err := g.Grant(a); err != nil {
		t.Fatal("invalid frames consumed a valid grant ID")
	}
}

func TestCanonicalUpstreamAccountIsSeparateFromTheDMLocalAlias(t *testing.T) {
	raw, _ := json.Marshal(sample())
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	fields["runtime"] = "dsh"
	fields["protocol"] = "chat-completions"
	fields["authentication"] = "api_key"
	fields["upstreamAccountRef"] = "example/0123456789"
	account := sha256.Sum256([]byte("example/0123456789"))
	route, _ := json.Marshal(map[string]string{"runtime": "dsh", "provider": "example", "protocol": "chat-completions", "model": "model-a", "authentication": "api_key", "authRef": "dm-auth-1", "accountRef": "dm-account-1", "upstreamAccountHash": hex.EncodeToString(account[:])})
	sum := sha256.Sum256(route)
	fields["routeHash"] = hex.EncodeToString(sum[:])
	raw, _ = json.Marshal(fields)
	var a Admission
	_ = json.Unmarshal(raw, &a)
	g, err := New(Config{Epoch: "epoch-1", Authority: "127.0.0.1:43123", ValidateRequest: allowSyntheticInput, Authorize: func(value Admission) error {
		encoded, _ := json.Marshal(value)
		var actual map[string]any
		_ = json.Unmarshal(encoded, &actual)
		if actual["accountRef"] != "dm-account-1" || actual["upstreamAccountRef"] != "example/0123456789" {
			return io.ErrClosedPipe
		}
		return nil
	}, Handler: http.NotFoundHandler()})
	if err != nil || g.Grant(a) != nil {
		t.Fatal("canonical upstream account cannot be bound while retaining the DM alias")
	}
}

func TestMappedAccountDigestMatchesIndependentVector(t *testing.T) {
	actual, err := AdmissionRouteHash(sample())
	if err != nil || actual != "9a20f15bf3c78e5646e40203925ad9c7101dd36cb6ac94c4c64b318cb87efeb3" {
		t.Fatal("route digest does not match the independent JSON/SHA256 vector")
	}
}

func TestLimitedUpstreamAccountScopeCannotBeTheLocalAliasOrAnotherAccount(t *testing.T) {
	a := sample()
	if !AccountScopeMatches(a, []string{"example/0123456789"}) {
		t.Fatal("canonical account rejected")
	}
	for _, accounts := range [][]string{nil, {}, {"dm-account-1"}, {"other/0123456789"}, {"example/another"}, {"example/0123456789", "example/another"}} {
		if AccountScopeMatches(a, accounts) {
			t.Fatal("an unbounded or different upstream account was accepted")
		}
	}
}

func TestConcreteRouteChangesCannotBorrowAnEarlierGrantHash(t *testing.T) {
	edits := []func(*Admission){func(a *Admission) { a.UpstreamAccountRef = "example/another" }, func(a *Admission) { a.UpstreamAccountRef = "other/0123456789" }, func(a *Admission) { a.UpstreamAccountRef = "dm-account-1" }, func(a *Admission) { a.Protocol = "openai-responses"; a.Path = "/v1/responses" }, func(a *Admission) { a.Runtime = "copilot-sdk" }, func(a *Admission) { a.Authentication = "oauth" }, func(a *Admission) { a.AccountRef = "other-alias" }, func(a *Admission) { a.AuthRef = "other-auth" }, func(a *Admission) { a.Path = "/v1/messages" }}
	for _, edit := range edits {
		checks := 0
		g, err := New(Config{Epoch: "epoch-1", Authority: "127.0.0.1:43123", ValidateRequest: allowSyntheticInput, Authorize: func(Admission) error { checks++; return nil }, Handler: http.NotFoundHandler()})
		if err != nil {
			t.Fatal(err)
		}
		a := sample()
		edit(&a)
		if g.Grant(a) == nil || checks != 0 {
			t.Fatal("changed concrete route reached key lookup or was accepted")
		}
	}
}

func TestCodexSubscriptionPathBoundToPlannerGrant(t *testing.T) {
	a := sample()
	a.Runtime, a.Provider, a.UpstreamAccountRef, a.Authentication, a.Protocol = "codex", "openai", "openai/test", "oauth", "openai-responses"
	a.RouteHash, _ = AdmissionRouteHash(a)
	for _, tc := range []struct {
		role, path string
		ok         bool
	}{
		{"planner2", "/backend-api/codex/responses", true},
		{"reviewer", "/backend-api/codex/responses", false},
		{"planner2", "/v1/responses", false},
	} {
		a.SubscriptionRequestHash = strings.Repeat("b", 64)
		a.Role, a.RoleID, a.Path = tc.role, tc.role, tc.path
		g := fixture(t, http.NotFoundHandler())
		g.config.SubscriptionHandler = http.NotFoundHandler()
		if err := g.Grant(a); (err == nil) != tc.ok {
			t.Fatalf("role=%s path=%s err=%v", tc.role, tc.path, err)
		}
	}
}
