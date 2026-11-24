package main

import (
	"encoding/json"
	"fmt"
	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/dmbridge"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func v5Boot(n int) map[string]any {
	caps := make([]map[string]string, n)
	for i := range caps {
		caps[i] = map[string]string{"model": fmt.Sprintf("model-%d", i), "protocol": "openai-responses", "endpoint": "https://custom.example/v1/responses"}
	}
	return map[string]any{"schema": controlV5, "epoch": "epoch_control", "accounts": []map[string]any{{"provider": "custom", "authentication": "api_key", "authRef": "auth_one", "accountRef": "account_one", "key": controlCanaryKey, "capabilities": caps}}}
}
func TestDMV5CapabilityFrames(t *testing.T) {
	for _, tc := range []struct {
		n  int
		ok bool
	}{{0, false}, {1, true}, {17, true}, {64, true}, {65, false}} {
		v := v5Boot(tc.n)
		raw, _ := json.Marshal(v)
		_, err := parseBootstrap(raw)
		if (err == nil) != tc.ok {
			t.Fatalf("pairs %d: %v", tc.n, err)
		}
	}
	v := v5Boot(64)
	for _, c := range v["accounts"].([]map[string]any)[0]["capabilities"].([]map[string]string) {
		c["endpoint"] = "https://custom.example/" + strings.Repeat("a", 300) + "/responses"
	}
	raw, _ := json.Marshal(v)
	if len(raw) <= 16384 {
		t.Fatal("fixture too small")
	}
	if _, err := parseBootstrap(raw); err != nil {
		t.Fatal("v5 extended frame refused")
	}
	if _, err := parseBootstrap(append(raw, []byte(strings.Repeat(" ", bootstrapLimit))...)); err == nil {
		t.Fatal("oversized v5 allowed")
	}
	if _, err := parseBootstrap(append(bootBytes(), []byte(strings.Repeat(" ", 16384))...)); err == nil {
		t.Fatal("oversized legacy allowed")
	}
	for _, endpoint := range []string{"http://custom.example/v1/responses", "https://one:canary@custom.example/v1/responses", "https://127.0.0.1/v1/responses", "https://custom.example/v1/responses?key=canary", "https://custom.example/v1/messages", "https://custom.example/private/../responses"} {
		v := v5Boot(1)
		v["accounts"].([]map[string]any)[0]["capabilities"].([]map[string]string)[0]["endpoint"] = endpoint
		raw, _ := json.Marshal(v)
		if _, e := parseBootstrap(raw); e == nil {
			t.Error("malformed endpoint accepted")
		}
	}
}
func TestDMV5NativeOnlyIssueAndDenials(t *testing.T) {
	if !controlChild(t) {
		return
	}
	root := os.Getenv("DM_CONTROL_TEST_ROOT")
	if !strings.HasPrefix(strings.ToLower(filepath.Clean(root)), `f:\dreammakersuite\evidence\m07\`) {
		t.Fatal("fixture root")
	}
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, t.Name()))
	appdir.UseExecutable("")
	if err := os.MkdirAll(appdir.Config(), 0700); err != nil {
		t.Fatal(err)
	}
	v := v5Boot(17)
	raw, _ := json.Marshal(v)
	boot, e := parseBootstrap(raw)
	if e != nil {
		t.Fatal(e)
	}
	c, e := configureCredentials(boot)
	if e != nil {
		t.Fatal(e)
	}
	r := c.Accounts()[0]
	if r.Model != "model-0" || len(r.Capabilities) != 17 || r.Capabilities[16].Model != "model-16" {
		t.Fatal("ready rows")
	}
	a := controlDraft(t, c)
	a.Provider = "custom"
	a.Model = "model-16"
	a.Protocol = "openai-responses"
	a.Role = "reviewer"
	a.RoleID = a.Role
	a.Runtime = "codex"
	a.Path = "/v1/responses"
	a.RouteHash, _ = dmbridge.AdmissionRouteHash(a)
	for _, mutate := range []func(*dmbridge.Admission){func(x *dmbridge.Admission) { x.AccountRef = "other" }, func(x *dmbridge.Admission) { x.AuthRef = "other" }, func(x *dmbridge.Admission) { x.UpstreamAccountRef = "custom/aaaaaaaaaa" }, func(x *dmbridge.Admission) { x.Model = "absent" }, func(x *dmbridge.Admission) { x.Path = "/v1/chat/completions"; x.Protocol = "chat-completions" }, func(x *dmbridge.Admission) { x.Method = "GET" }, func(x *dmbridge.Admission) { x.MaxOutputTokens = 0 }, func(x *dmbridge.Admission) { x.Path = "/backend-api/codex/responses" }, func(x *dmbridge.Admission) { x.Runtime = "dsh" }} {
		x := a
		mutate(&x)
		x.RouteHash, _ = dmbridge.AdmissionRouteHash(x)
		ack, _ := c.IssueFrame(issueBytes(t, x))
		if ack.Accepted {
			t.Fatal("altered issue accepted")
		}
	}
	ack, e := c.IssueFrame(issueBytes(t, a))
	if e != nil || !ack.Accepted {
		t.Fatal("explicit key issue", e)
	}
	a.UpstreamKeyID = ack.UpstreamKeyID
	a.UpstreamKey = ack.UpstreamKey
	if c.Authorize(a) != nil {
		t.Fatal("matching receipt denied")
	}
	a.ReservationID = "other"
	if c.Authorize(a) == nil {
		t.Fatal("reservation substitution allowed")
	}
}
