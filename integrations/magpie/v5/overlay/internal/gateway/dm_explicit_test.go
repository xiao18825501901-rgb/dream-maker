package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/budget"
	"github.com/yetone/magpie/internal/dmbridge"
	"github.com/yetone/magpie/internal/gwbudget"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/usage"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const dmNativeFixture = `event: response.created
data: {"type":"response.created","response":{"object":"response","id":"resp_test","model":"native-only","status":"in_progress","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_test","status":"in_progress","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","item_id":"msg_test","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_test","output_index":0,"content_index":0,"delta":"héllo "}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_test","output_index":0,"content_index":0,"delta":"世界"}

event: response.output_text.done
data: {"type":"response.output_text.done","item_id":"msg_test","output_index":0,"content_index":0,"text":"héllo 世界"}

event: response.content_part.done
data: {"type":"response.content_part.done","item_id":"msg_test","output_index":0,"content_index":0,"part":{"type":"output_text","text":"héllo 世界","annotations":[]}}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_test","status":"completed","content":[{"type":"output_text","text":"héllo 世界","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","response":{"object":"response","id":"resp_test","model":"native-only","status":"completed","output":[{"type":"message","role":"assistant","id":"msg_test","status":"completed","content":[{"type":"output_text","text":"héllo 世界","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13,"input_tokens_details":{"cached_tokens":2}}}}

`

func TestDMNativeTranscriptMatchesEveryEvent(t *testing.T) {
	a := dmbridge.Admission{Provider: "custom", Model: "native-only", MaxInputTokens: 20}
	raw := []byte(dmNativeFixture)
	out, e := dmResponsesTranscript(raw, a, 4)
	if e != nil || bytes.Count(out, []byte("custom/native-only")) != 2 || bytes.Count(out, []byte("event: ")) != 9 {
		t.Fatalf("native SSE failed: %v", e)
	}
	for _, pair := range [][2]string{{"héllo 世界", "forged"}, {"native-only", "custom/native-only"}, {"resp_test", "other"}, {"msg_test", "other"}, {"output_text.delta", "function_call_arguments.delta"}, {"output_item.added", "content_part.added"}, {"\"output_tokens\":4", "\"output_tokens\":5"}, {"\"cached_tokens\":2", "\"cached_tokens\":10"}, {"\"total_tokens\":13", "\"total_tokens\":14"}, {"\"input_tokens\":9", "\"input_tokens\":21"}} {
		bad := strings.Replace(dmNativeFixture, pair[0], pair[1], 1)
		if _, e := dmResponsesTranscript([]byte(bad), a, 4); e == nil {
			t.Errorf("mutation accepted: %s", pair[0])
		}
	}
	for _, bad := range []string{strings.TrimSuffix(dmNativeFixture, "\n"), strings.Split(dmNativeFixture, "event: response.completed")[0], dmNativeFixture + dmNativeFixture} {
		if _, e := dmResponsesTranscript([]byte(bad), a, 4); e == nil {
			t.Error("truncated or additional events accepted")
		}
	}
}

func TestDMExplicitThroughOwnedGate(t *testing.T) {
	if os.Getenv("DM_NATIVE_GATE_CHILD") != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+t.Name()+"$")
		cmd.Env = append(os.Environ(), "DM_NATIVE_GATE_CHILD=1")
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("%v %s", e, out)
		}
		return
	}
	root := os.Getenv("DM_CONTROL_TEST_ROOT")
	if !strings.HasPrefix(strings.ToLower(filepath.Clean(root)), `f:\dreammakersuite\evidence\m07\`) {
		t.Fatal("test root")
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, t.Name()))
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	appdir.UseExecutable("")
	if e := os.MkdirAll(appdir.Config(), 0700); e != nil {
		t.Fatal(e)
	}
	const key = "SYNTHETIC_NATIVE_ONLY_KEY_789012"
	const otherKey = "SYNTHETIC_OTHER_WIRE_KEY_12345"
	const endpoint = "https://one.example/v1/responses"
	accounts := []provider.DMAccount{{Provider: "custom", Key: key, Capabilities: []provider.DMCapability{{Model: "native-only", Protocol: "openai-responses", Endpoint: endpoint}}}, {Provider: "custom", Key: otherKey, Capabilities: []provider.DMCapability{{Model: "native-only", Protocol: "chat-completions", Endpoint: "https://two.example/v1/chat/completions"}, {Model: "native-only", Protocol: "anthropic-messages", Endpoint: "https://three.example/v1/messages"}}}}
	if e := provider.ConfigureDreamMakerAccounts(accounts); e != nil {
		t.Fatal(e)
	}
	if e := access.ConfigureDreamMakerKeyStore(); e != nil {
		t.Fatal(e)
	}
	remove := gwbudget.Limit(budget.Limiter{})
	defer remove()
	for n, cap := range []provider.DMCapability{accounts[0].Capabilities[0], accounts[1].Capabilities[0], accounts[1].Capabilities[1], accounts[1].Capabilities[0], accounts[1].Capabilities[1], accounts[1].Capabilities[0]} {
		accountKey := key
		runtime := "codex"
		path := "/v1/responses"
		body := `{"model":"custom/native-only","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}],"stream":true,"store":false,"max_output_tokens":4}`
		media := "text/event-stream"
		reply := dmNativeFixture
		if n > 0 {
			accountKey = otherKey
			path = "/v1/chat/completions"
			runtime = "codex"
			if cap.Protocol == "anthropic-messages" {
				path = "/v1/messages"
				runtime = "dsh"
			}
			body = `{"model":"custom/native-only","messages":[{"role":"user","content":"hello"}],"stream":false,"max_tokens":4}`
			media = "application/json"
			reply = `{"object":"chat.completion","model":"native-only","id":"offline_fixture","choices":[{"index":0,"message":{"role":"assistant","content":"fixture"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}`
			if cap.Protocol == "anthropic-messages" {
				reply = `{"type":"message","role":"assistant","id":"offline_fixture","model":"native-only","content":[{"type":"text","text":"fixture"}],"usage":{"input_tokens":9,"output_tokens":4},"stop_reason":"end_turn"}`
			}
		}
		if n == 3 || n == 4 {
			body = strings.Replace(body, "false", "true", 1)
			media = "text/event-stream"
			reply = "data: {\"id\":\"offline_fixture\",\"object\":\"chat.completion.chunk\",\"model\":\"native-only\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"fixture\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"offline_fixture\",\"object\":\"chat.completion.chunk\",\"model\":\"native-only\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"total_tokens\":13}}\n\ndata: [DONE]\n\n"
			if n == 4 {
				reply = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"offline_fixture\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"native-only\",\"content\":[],\"usage\":{\"input_tokens\":9,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"fixture\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
			}
		}
		if n == 5 {
			reply = strings.Replace(reply, "native-only", "unexpected", 1)
		}
		ref := "custom/" + provider.KeyID(accountKey)
		issued, e := access.IssueKey(access.Issue{Name: "test", TTL: 2 * time.Minute, Models: []string{"custom/native-only"}, Accounts: []string{ref}, Tokens: 1048580})
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256([]byte(body))
		a := dmbridge.Admission{Token: strings.Repeat("3", 64), ID: fmt.Sprintf("grant_%d", n), Epoch: "fixture", ProjectID: "project", FlowID: "flow", ConfigurationHash: strings.Repeat("a", 64), BindingHash: strings.Repeat("b", 64), RoleID: "reviewer", Role: "reviewer", ReservationID: "reserved", Provider: "custom", Runtime: runtime, Protocol: cap.Protocol, Authentication: "api_key", Model: "native-only", AccountRef: "account", AuthRef: "auth", UpstreamAccountRef: ref, UpstreamKeyID: issued.ID, UpstreamKey: issued.Key, Method: "POST", Path: path, BodyHash: hex.EncodeToString(sum[:]), ExpiresAtMs: time.Now().Add(50 * time.Second).UnixMilli(), MaxInputTokens: 1048576, MaxOutputTokens: 4}
		a.RouteHash, _ = dmbridge.AdmissionRouteHash(a)
		var calls atomic.Int32
		upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if "https://"+r.Host+r.URL.RequestURI() != cap.Endpoint || r.Method != "POST" || r.Header.Get("ChatGPT-Account-ID") != "" || r.Header.Get("X-DM-Gateway") != "" {
				t.Error("unbound physical request")
			}
			for name, values := range dmExplicitHeaders(cap.Protocol, accountKey) {
				if r.Header.Get(name) != values[0] {
					t.Error("physical header", name)
				}
			}
			raw, err := io.ReadAll(r.Body)
			var actual, expected map[string]any
			if err != nil || json.Unmarshal(raw, &actual) != nil || json.Unmarshal([]byte(body), &expected) != nil {
				t.Error("invalid physical body")
			}
			expected["model"] = a.Model
			if !reflect.DeepEqual(actual, expected) {
				t.Error("physical body differs")
			}
			w.Header().Set("Content-Type", media)
			io.WriteString(w, reply)
		}))
		defer upstream.Close()
		transport := upstream.Client().Transport.(*http.Transport).Clone()
		defer transport.CloseIdleConnections()
		transport.TLSClientConfig.ServerName = "example.com"
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			var dial net.Dialer
			return dial.DialContext(ctx, network, upstream.Listener.Addr().String())
		}
		s := NewDreamMakerServer()
		s.client = newDreamMakerClient(transport)
		local := httptest.NewUnstartedServer(nil)
		defer local.Close()
		gate, e := dmbridge.New(dmbridge.Config{Epoch: a.Epoch, Authority: local.Listener.Addr().String(), Authorize: func(v dmbridge.Admission) error {
			if v != a {
				return dmTargetDenied
			}
			return nil
		}, ValidateRequest: CheckDreamMakerIngress, Handler: s.DreamMakerHandler()})
		if e != nil || gate.Grant(a) != nil {
			t.Fatal("gate setup")
		}
		local.Config.Handler = gate
		local.Start()
		send := func() (int, string, []byte) {
			r, err := http.NewRequest("POST", local.URL+a.Path, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+a.Token)
			r.Header.Set("ChatGPT-Account-ID", "must-not-propagate")
			resp, err := local.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			raw, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			return resp.StatusCode, resp.Header.Get("Content-Type"), raw
		}
		status, contentType, raw := send()
		wantStatus := 200
		if n == 5 {
			wantStatus = 502
			media = ""
		}
		if status != wantStatus || calls.Load() != 1 || contentType != media {
			t.Fatalf("wire %s status %d sends %d", cap.Protocol, status, calls.Load())
		}
		if n == 3 || n == 4 {
			if string(raw) != reply {
				t.Fatal("stream changed")
			}
		}
		if n == 0 {
			assertDMProjectedEvents(t, dmNativeFixture, raw)
		}
		if replay, _, _ := send(); replay != http.StatusForbidden || calls.Load() != 1 {
			t.Fatal("replay")
		}
		receipts := 0
		for _, record := range usage.Load(time.Time{}) {
			if record.CallerKeyID != issued.ID {
				continue
			}
			receipts++
			if n == 5 {
				if record.Status != 502 || record.Served != "" {
					t.Fatal("failed physical receipt")
				}
				continue
			}
			if record.Status != 200 || record.ProviderKeyID != provider.KeyID(accountKey) || record.Requested != "custom/native-only" || record.Served != a.Model || record.Endpoint != path || record.Output != 4 || record.Input+record.CacheRead != 9 || n == 0 && record.CacheRead != 2 {
				t.Fatal("incorrect physical usage record")
			}
		}
		if receipts != 1 {
			t.Fatal("usage receipt count", receipts)
		}
	}
}
func assertDMProjectedEvents(t *testing.T, upstream string, reply []byte) {
	t.Helper()
	before := strings.Split(strings.TrimSuffix(upstream, "\n\n"), "\n\n")
	after := strings.Split(strings.TrimSuffix(string(reply), "\n\n"), "\n\n")
	if len(before) != len(after) {
		t.Fatal("event count")
	}
	for i, original := range before {
		ename, data, _ := strings.Cut(original, "\ndata: ")
		actual, projected, _ := strings.Cut(after[i], "\ndata: ")
		var old, new map[string]any
		if ename != actual || json.Unmarshal([]byte(data), &old) != nil || json.Unmarshal([]byte(projected), &new) != nil {
			t.Fatal("frame order or encoding", i)
		}
		if envelope, ok := old["response"].(map[string]any); ok {
			envelope["model"] = "custom/native-only"
		}
		if !reflect.DeepEqual(old, new) {
			t.Fatal("frame data changed", i)
		}
	}
}
