package gateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	"github.com/yetone/magpie/internal/dmbridge"
	"github.com/yetone/magpie/internal/provider"
)

// Synthetic keys/transports; no provider, account, OAuth or model call.
func dmBudgetAdmission(a dmbridge.Admission) dmbridge.Admission {
	if err := json.Unmarshal([]byte(`{"maxInputTokens":1048576,"maxOutputTokens":128}`), &a); err != nil {
		panic(err)
	}
	return a
}

type dmFakeTransport func(*http.Request) (*http.Response, error)

func (f dmFakeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDMDedicatedConstructorReplacesReplayAndRedirectPaths(t *testing.T) {
	s := NewDreamMakerServer()
	guard, ok := s.client.Transport.(*dmbridge.SinglePhysicalTransport)
	if !ok {
		t.Fatal("physical guard not installed on actual Server.client")
	}
	transport, ok := guard.Next.(*http.Transport)
	if !ok || transport.Proxy == nil || !transport.DisableKeepAlives || transport.ForceAttemptHTTP2 {
		t.Fatal("dedicated transport must retain the controlled environment proxy")
	}
	if s.client.Timeout != 130*time.Second || s.client.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("unbounded request or redirect enabled")
	}
}
func TestDMDedicatedTransportUsesOnlyTheMatchingLoopbackProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:7890/")
	t.Setenv("https_proxy", "http://127.0.0.1:7890/")
	t.Setenv("ALL_PROXY", "http://127.0.0.1:7890/")
	t.Setenv("all_proxy", "http://127.0.0.1:7890/")
	transport := newDreamMakerTransport()
	request, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader("{}"))
	proxy, err := transport.Proxy(request)
	if err != nil || proxy == nil || proxy.String() != "http://127.0.0.1:7890/" {
		t.Fatalf("controlled CFW proxy not selected: %v %v", proxy, err)
	}
}

func TestDMDedicatedTransportFailsClosedOnAmbiguousOrNonLoopbackProxySettings(t *testing.T) {
	for _, settings := range [][]string{
		{"http://127.0.0.1:7890/", "http://127.0.0.1:7891/"},
		{"https://127.0.0.1:7890/"},
		{"http://192.0.2.1:7890/"},
		{"http://127.0.0.1:7890/?credential=1"},
	} {
		if proxy, err := dmProxyURL(settings); err == nil || proxy != nil {
			t.Fatalf("unsafe proxy settings did not fail closed: %v %v", proxy, err)
		}
	}
}

func TestDMDedicatedTargetChecksHostModelAndCanonicalAccount(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	a := dmBudgetAdmission(dmbridge.Admission{Provider: "deepseek-official", Runtime: "dsh", Role: "executor", Protocol: "chat-completions", Path: "/v1/chat/completions", Model: "deepseek-flash", Authentication: "api_key", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5])})
	makeRequest := func() *http.Request {
		r, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{"model":"deepseek-flash","messages":[],"max_tokens":128}`))
		r.Header.Set("Authorization", "Bearer "+key)
		return r
	}
	if dmPhysicalTarget(a, makeRequest()) != nil {
		t.Fatal("correct synthetic target refused")
	}
	for _, change := range []func(*http.Request){func(r *http.Request) { r.URL.Host = "unexpected.invalid" }, func(r *http.Request) { r.URL.RawQuery = "override=1" }, func(r *http.Request) { r.Header.Set("Authorization", "Bearer WRONG_KEY") }, func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(`{"model":"other"}`)) }, func(r *http.Request) { r.URL.Scheme = "http" }} {
		r := makeRequest()
		change(r)
		if dmPhysicalTarget(a, r) == nil {
			t.Fatal("incorrect target accepted")
		}
	}
}
func TestDMDedicatedActualClientGetsOneGateOwnedPhysicalRequest(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	keySum := sha256.Sum256([]byte(key))
	body := `{"model":"deepseek-official/deepseek-flash","messages":[],"max_tokens":128}`
	bodySum := sha256.Sum256([]byte(body))
	calls := 0
	client := newDreamMakerClient(dmFakeTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 503, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("SYNTHETIC_UNCERTAIN")), Request: r}, nil
	}))
	a := dmbridge.Admission{Token: strings.Repeat("a", 64), ID: "req-1", Epoch: "epoch-1", ProjectID: "project-1", FlowID: "flow-1", ConfigurationHash: strings.Repeat("b", 64), BindingHash: strings.Repeat("c", 64), RoleID: "planner2", Role: "planner2", ReservationID: "reserved-1", Provider: "deepseek-official", Runtime: "dsh", Protocol: "chat-completions", Authentication: "api_key", Model: "deepseek-flash", AccountRef: "account-1", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(keySum[:5]), AuthRef: "auth-1", UpstreamKeyID: "limited-1", UpstreamKey: "SYNTHETIC_LIMITED_KEY", Method: "POST", Path: "/v1/chat/completions", BodyHash: hex.EncodeToString(bodySum[:]), ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli()}
	a = dmBudgetAdmission(a)
	a.RouteHash, _ = dmbridge.AdmissionRouteHash(a)
	g, err := dmbridge.New(dmbridge.Config{Epoch: a.Epoch, Authority: "127.0.0.1:43123", Authorize: func(dmbridge.Admission) error { return nil }, ValidateRequest: CheckDreamMakerIngress, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 2; i++ {
			out, _ := http.NewRequestWithContext(r.Context(), "POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{"model":"deepseek-flash","messages":[],"max_tokens":128}`))
			out.Header.Set("Authorization", "Bearer "+key)
			response, e := client.Do(out)
			if i == 0 && e != nil {
				t.Error("first synthetic send refused")
			}
			if i == 1 && e == nil {
				t.Error("retry reached transport")
			}
			if response != nil {
				response.Body.Close()
			}
		}
		w.WriteHeader(502)
	})})
	if err != nil {
		t.Fatal(err)
	}
	if err = g.Grant(a); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1:43123/v1/chat/completions", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50000"
	r.Header.Set("Authorization", "Bearer "+a.Token)
	r.Header.Set("Content-Type", "application/json")
	g.ServeHTTP(httptest.NewRecorder(), r)
	if calls != 1 {
		t.Fatalf("physical calls=%d", calls)
	}
}

func TestDMDedicatedFinalBodyCannotEnlargeOriginalHold(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	a := dmBudgetAdmission(dmbridge.Admission{Provider: "deepseek-official", Runtime: "dsh", Role: "executor", Protocol: "anthropic-messages", Path: "/v1/messages", Model: "deepseek-flash", Authentication: "api_key", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5])})
	for _, body := range []string{
		`{"model":"deepseek-flash","messages":[],"max_tokens":129}`,
		`{"model":"deepseek-flash","messages":[]}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":0}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":1.5}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":"128"}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":128,"max_completion_tokens":99999}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":128,"max_output_tokens":99999}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":128,"n":2}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":128,"best_of":20}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":99999,"max_tokens":128}`,
		`{"model":"deepseek-flash","messages":[],"MAX_TOKENS":99999,"max_tokens":128}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":128,"modalities":["audio"]}`,
		`{"model":"deepseek-flash","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://unapproved.invalid/picture"}}]}],"max_tokens":128}`,
		`{"model":"deepseek-flash","messages":[],"tools":[{"type":"web_search"}],"max_tokens":128}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":128} {"n":2}`,
	} {
		r, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+key)
		if dmPhysicalTarget(a, r) == nil {
			t.Errorf("unbudgeted final body accepted: %s", body)
		}
	}
	insufficient := a
	if json.Unmarshal([]byte(`{"maxInputTokens":1048575}`), &insufficient) != nil {
		t.Fatal("fixture invalid")
	}
	r, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{"model":"deepseek-flash","messages":[],"max_tokens":128}`))
	r.Header.Set("Authorization", "Bearer "+key)
	if dmPhysicalTarget(insufficient, r) == nil {
		t.Fatal("less than the original full-context input reservation accepted")
	}
}

func TestDMDedicatedNestedDiscriminatorsCannotHideMedia(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	a := dmBudgetAdmission(dmbridge.Admission{Provider: "deepseek-official", Runtime: "dsh", Role: "executor", Protocol: "chat-completions", Path: "/v1/chat/completions", Model: "deepseek-flash", Authentication: "api_key", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5])})
	for _, body := range []string{
		`{"model":"deepseek-flash","messages":[{"role":"user","content":[{"type":"image_url","Type":"text","image_url":{"url":"https://unapproved.invalid/i"}}]}],"max_tokens":1}`,
		`{"model":"deepseek-flash","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://unapproved.invalid/i"}}],"Content":"safe"}],"max_tokens":1}`,
		`{"model":"deepseek-flash","messages":[],"max_tokens":1,"tools":[{"type":"web_search","Type":"function"}]}`,
		`{"model":"deepseek-flash","messages":[{"role":"user","content":[{"type":"image_url","type":"text","text":"safe"}]}],"max_tokens":1}`,
	} {
		r, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+key)
		if dmPhysicalTarget(a, r) == nil {
			t.Errorf("ambiguous nested input accepted: %s", body)
		}
	}
}

func TestDMDedicatedActualRequestTargetCannotOverrideApprovedURL(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	a := dmBudgetAdmission(dmbridge.Admission{Provider: "deepseek-official", Runtime: "dsh", Role: "executor", Protocol: "chat-completions", Path: "/v1/chat/completions", Model: "deepseek-flash", Authentication: "api_key", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5])})
	for _, edit := range []func(*http.Request){
		func(r *http.Request) { r.URL.Opaque = "/unapproved" },
		func(r *http.Request) { r.Host = "unexpected.invalid" },
		func(r *http.Request) { r.URL.ForceQuery = true },
		func(r *http.Request) { r.Header["authorization"] = []string{"Bearer DIFFERENT_SYNTHETIC_KEY"} },
		func(r *http.Request) {
			r.Header["Authorization"] = []string{"Bearer DIFFERENT_SYNTHETIC_KEY", "Bearer ANOTHER_SYNTHETIC_KEY"}
			r.Header.Set("X-Api-Key", key)
		},
		func(r *http.Request) {
			r.Header.Set("Authorization", "Basic DIFFERENT_SYNTHETIC_KEY")
			r.Header.Set("X-Api-Key", key)
		},
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer "); r.Header.Set("X-Api-Key", key) },
	} {
		r, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{"model":"deepseek-flash","messages":[],"max_tokens":128}`))
		r.Header.Set("Authorization", "Bearer "+key)
		edit(r)
		if dmPhysicalTarget(a, r) == nil {
			t.Error("alternate request target or authorization accepted")
		}
	}
}

func TestDMDedicatedAnthropicSameKeyMayUseBothAuthHeaders(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	a := dmBudgetAdmission(dmbridge.Admission{Provider: "deepseek-official", Runtime: "dsh", Role: "executor", Protocol: "anthropic-messages", Path: "/v1/messages", Model: "deepseek-flash", Authentication: "api_key", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5])})
	makeRequest := func() *http.Request {
		r, _ := http.NewRequest("POST", "https://api.deepseek.com/anthropic/v1/messages", strings.NewReader(`{"model":"deepseek-flash","messages":[],"max_tokens":128}`))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("X-Api-Key", key)
		return r
	}
	if dmPhysicalTarget(a, makeRequest()) != nil {
		t.Fatal("the same upstream key in both Anthropic headers was refused")
	}
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("X-Api-Key", "DIFFERENT_SYNTHETIC_KEY") },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer DIFFERENT_SYNTHETIC_KEY") },
		func(r *http.Request) { r.Header.Add("X-Api-Key", key) },
		func(r *http.Request) { r.Header.Add("Authorization", "Bearer "+key) },
		func(r *http.Request) { r.Header.Set("Authorization", key) },
		func(r *http.Request) { r.Header.Set("X-Api-Key", "") },
	} {
		r := makeRequest()
		change(r)
		if dmPhysicalTarget(a, r) == nil {
			t.Error("mismatched or repeated Anthropic authorization accepted")
		}
	}
}

func TestDMDedicatedCanonicalTextAndToolContinuationsRemainWithinBudget(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	a := dmBudgetAdmission(dmbridge.Admission{Provider: "deepseek-official", Runtime: "dsh", Role: "executor", Protocol: "chat-completions", Path: "/v1/chat/completions", Model: "deepseek-flash", Authentication: "api_key", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5])})
	for _, body := range []string{
		`{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}],"max_tokens":128,"n":1,"tools":[{"type":"function","function":{"name":"sum","parameters":{"type":"object"}}}]}`,
		`{"model":"deepseek-flash","messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"sum","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_1","content":"1"}],"max_tokens":128}`,
		`{"model":"deepseek-flash","system":[{"type":"text","text":"只做本地任务"}],"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"sum","input":{"a":1}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"1"}]}]}],"max_tokens":128,"tools":[{"name":"sum","input_schema":{"type":"object"}}]}`,
	} {
		r, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(body))
		for _, header := range []string{"Authorization", "X-Api-Key"} {
			r, _ = http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(body))
			if header == "Authorization" {
				r.Header.Set(header, "Bearer "+key)
			} else {
				r.Header.Set(header, key)
			}
			if dmPhysicalTarget(a, r) != nil {
				t.Error("canonical text/tool continuation refused")
			}
		}
	}
}

func TestDMDedicatedIngressRejectsInputBeforeAnyProtocolHandler(t *testing.T) {
	for _, item := range []struct {
		body    string
		allowed bool
	}{
		{`{"model":"deepseek-official/deepseek-flash","messages":[{"role":"user","content":"你好"}],"max_tokens":128}`, true},
		{`{"model":"deepseek-official/deepseek-flash","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://unapproved.invalid/i"}}]}],"max_tokens":128}`, false},
		{`{"model":"deepseek-official/deepseek-flash","messages":[],"max_tokens":129}`, false},
		{`{"model":"deepseek-official/deepseek-flash","messages":[],"max_tokens":128,"extra_body":{"url":"https://unapproved.invalid/i"}}`, false},
		{`{"model":"deepseek-official/deepseek-flash","messages":[],"max_tokens":128,"tools":[{"type":"web_search"}]}`, false},
	} {
		bodyHash := sha256.Sum256([]byte(item.body))
		a := dmBudgetAdmission(dmbridge.Admission{Token: strings.Repeat("a", 64), ID: "req-1", Epoch: "epoch-1", ProjectID: "project-1", FlowID: "flow-1", ConfigurationHash: strings.Repeat("b", 64), BindingHash: strings.Repeat("c", 64), RoleID: "planner2", Role: "planner2", ReservationID: "reserved-1", Provider: "deepseek-official", Runtime: "dsh", Protocol: "chat-completions", Authentication: "api_key", Model: "deepseek-flash", AccountRef: "account-1", UpstreamAccountRef: "deepseek-official/0123456789", AuthRef: "auth-1", UpstreamKeyID: "limited-1", UpstreamKey: "SYNTHETIC_LIMITED_KEY", Method: "POST", Path: "/v1/chat/completions", BodyHash: hex.EncodeToString(bodyHash[:]), ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli()})
		a.RouteHash, _ = dmbridge.AdmissionRouteHash(a)
		calls := 0
		g, err := dmbridge.New(dmbridge.Config{Epoch: a.Epoch, Authority: "127.0.0.1:43123", Authorize: func(dmbridge.Admission) error { return nil }, ValidateRequest: CheckDreamMakerIngress, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(204) })})
		if err != nil || g.Grant(a) != nil {
			t.Fatal("synthetic admission setup failed")
		}
		r := httptest.NewRequest("POST", "http://127.0.0.1:43123/v1/chat/completions", strings.NewReader(item.body))
		r.RemoteAddr = "127.0.0.1:50000"
		r.Header.Set("Authorization", "Bearer "+a.Token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if item.allowed {
			if w.Code != 204 || calls != 1 {
				t.Fatal("approved text did not reach the handler")
			}
		} else if w.Code != 403 || calls != 0 {
			t.Fatal("unapproved input reached upstream preprocessing")
		}
	}
}

func TestDMIndependentReviewerDeepSeekProIsAdmitted(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	body := `{"model":"deepseek-official/deepseek-v4-pro","messages":[{"role":"user","content":"review"}],"max_tokens":128}`
	bodyHash := sha256.Sum256([]byte(body))
	a := dmBudgetAdmission(dmbridge.Admission{
		Token: strings.Repeat("a", 64), ID: "req-v4-pro", Epoch: "epoch-v4-pro",
		ProjectID: "project-v4-pro", FlowID: "flow-v4-pro",
		ConfigurationHash: strings.Repeat("b", 64), BindingHash: strings.Repeat("c", 64),
		RoleID: "reviewer", Role: "reviewer", ReservationID: "reserved-v4-pro",
		Provider: "deepseek-official", Runtime: "independent", Protocol: "chat-completions",
		Authentication: "api_key", Model: "deepseek-v4-pro",
		AccountRef: "account-v4-pro", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5]),
		AuthRef: "auth-v4-pro", UpstreamKeyID: "limited-v4-pro", UpstreamKey: "SYNTHETIC_LIMITED_KEY",
		Method: "POST", Path: "/v1/chat/completions", BodyHash: hex.EncodeToString(bodyHash[:]),
		ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli(),
	})
	if err := CheckDreamMakerIngress(a, []byte(body)); err != nil {
		t.Fatalf("independent reviewer V4 Pro ingress refused: %v", err)
	}
	r, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"review"}],"max_tokens":128}`))
	r.Header.Set("Authorization", "Bearer "+key)
	if err := dmPhysicalTarget(a, r); err != nil {
		t.Fatalf("independent reviewer V4 Pro physical target refused: %v", err)
	}
	for _, mutate := range []func(*dmbridge.Admission){
		func(x *dmbridge.Admission) { x.Runtime = "dsh" },
		func(x *dmbridge.Admission) { x.Role = "executor" },
		func(x *dmbridge.Admission) { x.Protocol = "anthropic-messages"; x.Path = "/v1/messages" },
	} {
		changed := a
		mutate(&changed)
		if CheckDreamMakerIngress(changed, []byte(body)) == nil {
			t.Fatal("V4 Pro escaped the independent reviewer route")
		}
	}
}

func TestDMCliReviewerPro(t *testing.T) {
	key := "SYNTHETIC_PROVIDER_KEY"
	sum := sha256.Sum256([]byte(key))
	for _, runtime := range []string{"opencode", "cline"} {
		t.Run(runtime, func(t *testing.T) {
			a := dmBudgetAdmission(dmbridge.Admission{Provider: "deepseek-official", Model: "deepseek-v4-pro", Runtime: runtime, RoleID: "reviewer", Role: "reviewer", Path: "/v1/chat/completions", Protocol: "chat-completions", Authentication: "api_key", UpstreamAccountRef: "deepseek-official/" + hex.EncodeToString(sum[:5])})
			body := `{"model":"deepseek-official/deepseek-v4-pro","messages":[{"role":"user","content":"review"}],"max_tokens":128}`
			check := func(ad dmbridge.Admission, payload, target, credential string) (bool, bool) {
				r, _ := http.NewRequest("POST", "https://api.deepseek.com"+target, strings.NewReader(strings.Replace(payload, "deepseek-official/deepseek-v4-pro", "deepseek-v4-pro", 1)))
				r.Header.Set("Authorization", "Bearer "+credential)
				return CheckDreamMakerIngress(ad, []byte(payload)) == nil, dmPhysicalTarget(ad, r) == nil
			}
			if i, o := check(a, body, "/chat/completions", key); !i || !o {
				t.Fatal("expected admitted Reviewer chat")
			}
			for _, bad := range []string{strings.Replace(body, "128}", `128,"tools":[]}`, 1), strings.Replace(body, "128}", `128,"tool_choice":"auto"}`, 1), strings.Replace(body, `"user"`, `"tool"`, 1), strings.Replace(body, `"review"`, `[{"type":"tool_use"}]`, 1), strings.Replace(body, "128}", "99999999}", 1)} {
				if i, o := check(a, bad, "/chat/completions", key); i || o {
					t.Fatal("admitted forbidden body")
				}
			}
			for _, mutate := range []func(*dmbridge.Admission){func(b *dmbridge.Admission) { b.Role = "planner2" }, func(b *dmbridge.Admission) { b.RoleID = "executor" }, func(b *dmbridge.Admission) { b.Protocol = "anthropic-messages" }, func(b *dmbridge.Admission) { b.Path = "/v1/messages" }, func(b *dmbridge.Admission) { b.Authentication = "oauth" }} {
				b := a
				mutate(&b)
				if i, o := check(b, body, "/chat/completions", key); i || o {
					t.Fatal("admitted mismatched route")
				}
			}
			if _, o := check(a, body, "/anthropic/v1/messages", key); o {
				t.Fatal("wrong physical protocol")
			}
			if _, o := check(a, body, "/chat/completions", "OTHER_SYNTHETIC"); o {
				t.Fatal("wrong physical account")
			}
		})
	}
}

// The catalog is intentionally write-once. Give this test its own process.
func TestDMStringReviewerRegisteredTarget(t *testing.T) {
	if os.Getenv("DM_TEST_STRING_CHILD") != "1" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(exe, "-test.run=^TestDMStringReviewerRegisteredTarget$")
		cmd.Env = append(os.Environ(), "DM_TEST_STRING_CHILD=1", "MAGPIE_NO_ACCOUNTS=1")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return
	}
	const key = "DM_SYNTHETIC_STRING_TEST"
	const url = "https://string.example.test/claude"
	const model = "claude-sonnet-5"
	const data = `{"model":"claude-sonnet-5","stream":true,"max_tokens":128,"thinking":{"type":"disabled"},"output_config":{"effort":"high"},"tools":[],"messages":[{"role":"user","content":[{"type":"text","text":"synthetic review"}]}]}`
	if err := provider.ConfigureDreamMakerAccounts([]provider.DMAccount{{Provider: "string", Model: model, Anthropic: url, Key: key}, {Provider: "string", Model: "another", Anthropic: url, Key: key + "2"}}); err != nil {
		t.Fatal(err)
	}
	a := dmBudgetAdmission(dmbridge.Admission{Provider: "string", Runtime: "claude", Role: "reviewer", Protocol: "anthropic-messages", Authentication: "api_key", Model: model, Path: "/v1/messages", UpstreamAccountRef: "string/" + provider.KeyID(key)})
	ingress := func(a dmbridge.Admission, body string) error {
		return CheckDreamMakerIngress(a, []byte(strings.Replace(body, `"model":"claude-`, `"model":"string/claude-`, 1)))
	}
	if err := ingress(a, data); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{strings.Replace(data, `"max_tokens":128`, `"max_tokens":129`, 1), strings.Replace(data, `"tools":[]`, `"tools":[{}]`, 1), strings.Replace(data, `"text":"synthetic review"`, `"text":null`, 1), strings.Replace(data, `"tools":[]`, `"metadata":{},"tools":[]`, 1)} {
		if ingress(a, bad) == nil {
			t.Fatal("invalid body admitted")
		}
	}
	other := a
	other.UpstreamAccountRef = "string/" + provider.KeyID(key+"2")
	if ingress(other, data) == nil {
		t.Fatal("other account admitted")
	}
	request := func(target, credential string) *http.Request {
		r, e := http.NewRequest("POST", target, strings.NewReader(data))
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("X-Api-Key", credential)
		return r
	}
	good := request(url+"/v1/messages", key)
	if err := dmPhysicalTarget(a, good); err != nil {
		t.Fatal(err)
	}
	read, err := io.ReadAll(good.Body)
	if err != nil || string(read) != data || good.GetBody != nil {
		t.Fatal("body/replay mismatch")
	}
	for _, r := range []*http.Request{request(url+"/v1/messages", key+"2"), request(url+"/v1/chat/completions", key), request("https://other.example.test/claude/v1/messages", key)} {
		if dmPhysicalTarget(a, r) == nil {
			t.Fatal("physical mismatch admitted")
		}
	}
	// Drive the original ingress and one-use transport together. The fake is
	// confined to the final network hop; an ambiguous first response cannot replay.
	body := strings.Replace(data, `"model":"claude-`, `"model":"string/claude-`, 1)
	sum := sha256.Sum256([]byte(body))
	a.Token = strings.Repeat("a", 64)
	a.ID = "req"
	a.Epoch = "epoch"
	a.ProjectID = "project"
	a.FlowID = "flow"
	a.ConfigurationHash = strings.Repeat("b", 64)
	a.BindingHash = strings.Repeat("c", 64)
	a.RoleID = a.Role
	a.ReservationID = "reserved"
	a.AccountRef = "account"
	a.AuthRef = "auth"
	a.UpstreamKeyID = "limited"
	a.UpstreamKey = "DM_SYNTHETIC_LIMITED"
	a.Method = "POST"
	a.BodyHash = hex.EncodeToString(sum[:])
	a.ExpiresAtMs = time.Now().Add(time.Minute).UnixMilli()
	a.RouteHash, err = dmbridge.AdmissionRouteHash(a)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := newDreamMakerClient(dmFakeTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 503, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
	}))
	gate, err := dmbridge.New(dmbridge.Config{Epoch: a.Epoch, Authority: "127.0.0.1:43123", Authorize: func(dmbridge.Admission) error { return nil }, ValidateRequest: CheckDreamMakerIngress, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 2; i++ {
			resp, e := client.Do(request(url+"/v1/messages", key).WithContext(r.Context()))
			if (i == 0) != (e == nil) {
				t.Error("unexpected send outcome", i, e)
			}
			if resp != nil {
				resp.Body.Close()
			}
		}
	})})
	if err != nil {
		t.Fatal(err)
	}
	if err = gate.Grant(a); err != nil {
		t.Fatal(err)
	}
	incoming := httptest.NewRequest("POST", "http://127.0.0.1:43123/v1/messages", strings.NewReader(body))
	incoming.RemoteAddr = "127.0.0.1:49000"
	incoming.Header.Set("Authorization", "Bearer "+a.Token)
	incoming.Header.Set("Content-Type", "application/json")
	gate.ServeHTTP(httptest.NewRecorder(), incoming)
	if calls != 1 {
		t.Fatalf("unexpected send count %d", calls)
	}

}

func TestDMCodexPlannerNativePayload(t *testing.T) {
	a := dmBudgetAdmission(dmbridge.Admission{Method: "POST", Path: "/backend-api/codex/responses", Role: "planner2", RoleID: "planner2", Runtime: "codex", Provider: "openai", Model: "gpt-6-luna", Protocol: "openai-responses", Authentication: "oauth"})
	body := `{"model":"gpt-6-luna","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"synthetic"}]}],"max_output_tokens":100,"store":false,"stream":true}`
	for _, tc := range []struct {
		body string
		ok   bool
	}{{body, true}, {strings.Replace(body, "100", "200", 1), false}, {strings.Replace(body, "input_text", "input_image", 1), false}, {strings.Replace(body, `"store":false`, `"store":true`, 1), false}, {strings.Replace(body, `"store":false`, `"tools":[],"store":false`, 1), false}} {
		sum := sha256.Sum256([]byte(tc.body))
		a.BodyHash = hex.EncodeToString(sum[:])
		if got := CheckDreamMakerIngress(a, []byte(tc.body)); (got == nil) != tc.ok {
			t.Fatalf("accepted=%v error=%v", tc.ok, got)
		}
	}
	a.BodyHash = strings.Repeat("0", 64)
	if CheckDreamMakerIngress(a, []byte(body)) == nil {
		t.Fatal("changed body admitted")
	}
}

func TestDMCodexPlannerUsesSinglePhysicalSubscriptionRequest(t *testing.T) {
	body := `{"model":"gpt-6-luna","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"synthetic"}]}],"max_output_tokens":100,"store":false,"stream":true}`
	sum := sha256.Sum256([]byte(body))
	headers := http.Header{}
	headers.Set("Authorization", "Bearer offline-example")
	headers.Set("ChatGPT-Account-ID", "synthetic-workspace")
	headers.Set("Accept", "text/event-stream")
	a := dmBudgetAdmission(dmbridge.Admission{ID: "id1", ReservationID: "res1", Token: strings.Repeat("a", 64), Epoch: "epoch1", ProjectID: "p1", FlowID: "f1", ConfigurationHash: strings.Repeat("b", 64), BindingHash: strings.Repeat("c", 64), Model: "gpt-6-luna", Runtime: "codex", Provider: "openai", Authentication: "oauth", Protocol: "openai-responses", Role: "planner2", RoleID: "planner2", AccountRef: "account1", AuthRef: "auth1", UpstreamAccountRef: "openai/offline", UpstreamKeyID: "key1", UpstreamKey: "scoped-offline-key", Method: "POST", Path: "/backend-api/codex/responses", BodyHash: hex.EncodeToString(sum[:]), ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli(), SubscriptionRequestHash: dmbridge.CodexCredentialBinding(headers)})
	a.RouteHash, _ = dmbridge.AdmissionRouteHash(a)
	for _, change := range []string{"none", "account", "bearer", "accept", "missing-accept", "missing-grant", "body"} {
		t.Run(change, func(t *testing.T) {
			sends := 0
			engine := NewDreamMakerServer()
			engine.client = newDreamMakerClient(dmFakeTransport(func(req *http.Request) (*http.Response, error) {
				sends++
				sent, err := io.ReadAll(req.Body)
				req.Body.Close()
				if err != nil || string(sent) != body || req.URL.String() != codexResponsesURL || req.Header.Get("Authorization") != headers.Get("Authorization") || req.Header.Get("ChatGPT-Account-ID") != "synthetic-workspace" || len(req.Header.Values("Accept")) != 1 || req.Header.Get("Accept") != "text/event-stream" || req.Header.Get("X-DM-Gateway") != "" || req.Header.Get("Cookie") != "" {
					t.Fatal("physical request mismatch")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: synthetic\n\n"))}, nil
			}))
			gate, err := dmbridge.New(dmbridge.Config{Epoch: a.Epoch, Authority: "127.0.0.1:43210", Authorize: func(dmbridge.Admission) error { return nil }, ValidateRequest: CheckDreamMakerIngress, Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("generic handler reached") }), SubscriptionHandler: http.HandlerFunc(engine.CodexPlannerResponses)})
			if err != nil || gate.Grant(a) != nil {
				t.Fatal("fixture grant failed")
			}
			send := func() int {
				text := body
				if change == "body" {
					text += " "
				}
				r := httptest.NewRequest("POST", "http://127.0.0.1:43210"+a.Path, strings.NewReader(text))
				r.RemoteAddr = "127.0.0.1:50001"
				r.Header = headers.Clone()
				r.Header.Set("X-DM-Gateway", a.Token)
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Cookie", "offline=strip")
				switch change {
				case "account":
					r.Header.Del("ChatGPT-Account-ID")
				case "bearer":
					r.Header.Set("Authorization", "Bearer other")
				case "accept":
					r.Header.Set("Accept", "application/json")
				case "missing-accept":
					r.Header.Del("Accept")
				case "missing-grant":
					r.Header.Del("X-DM-Gateway")
				}
				w := httptest.NewRecorder()
				gate.ServeHTTP(w, r)
				return w.Code
			}
			code := send()
			if change == "none" {
				if code != 200 || sends != 1 || send() < 400 || sends != 1 {
					t.Fatalf("single send failed %d %d", code, sends)
				}
			} else if code < 400 || sends != 0 {
				t.Fatalf("unexpected send %d %d", code, sends)
			}
		})
	}
}

func TestDMCodexPlannerNormalizesOnlyPlainTextSSE(t *testing.T) {
	for _, tc := range []struct {
		name        string
		contentType string
		body        string
		oneByte     bool
		want        string
	}{
		{
			name:        "sse-with-plain-content-type",
			contentType: "text/plain; charset=utf-8",
			body:        "data: {\"type\":\"response.completed\"}\n\n",
			want:        "text/event-stream",
		},
		{
			name:        "plain-error-stays-plain",
			contentType: "text/plain; charset=utf-8",
			body:        "upstream error\n",
			want:        "text/plain; charset=utf-8",
		},
		{
			name:        "sse-after-safe-preamble",
			contentType: "text/plain; charset=utf-8",
			body:        "status: streaming\n\ndata: {\"type\":\"response.completed\"}\n\n",
			want:        "text/event-stream",
		},
		{
			name:        "sse-after-safe-preamble-one-byte-reads",
			contentType: "text/plain; charset=utf-8",
			body:        "status: streaming\n\ndata: {\"type\":\"response.completed\"}\n\n",
			oneByte:     true,
			want:        "text/event-stream",
		},
		{
			name:        "sse-after-long-safe-preamble",
			contentType: "text/plain; charset=utf-8",
			body:        strings.Repeat("status: streaming\n", 300) + "\ndata: {\"type\":\"response.completed\"}\n\n",
			want:        "text/event-stream",
		},
		{
			name:        "sse-without-upstream-content-type",
			contentType: "",
			body:        "data: {\"type\":\"response.completed\"}\n\n",
			want:        "text/event-stream",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine := NewDreamMakerServer()
			engine.client = &http.Client{Transport: dmFakeTransport(func(*http.Request) (*http.Response, error) {
				var body io.Reader = strings.NewReader(tc.body)
				if tc.oneByte {
					body = iotest.OneByteReader(body)
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": {tc.contentType}},
					Body:       io.NopCloser(body),
				}, nil
			})}
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:43210/backend-api/codex/responses", strings.NewReader(`{"stream":true}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Accept", "text/event-stream")
			response := httptest.NewRecorder()

			engine.CodexPlannerResponses(response, request)

			if got := response.Header().Get("Content-Type"); got != tc.want {
				t.Fatalf("content type=%q want %q", got, tc.want)
			}
			if got := response.Body.String(); got != tc.body {
				t.Fatalf("response body changed: %q", got)
			}
		})
	}
}
