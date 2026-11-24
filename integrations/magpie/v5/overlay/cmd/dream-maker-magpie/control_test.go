package main

// Synthetic accounts through real provider/access APIs, never model or OAuth calls.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/dmbridge"
	"github.com/yetone/magpie/internal/gwbudget"
)

const controlCanaryKey = "SYNTHETIC_DM_CONTROL_ACCOUNT_0123456789"

func controlChild(t *testing.T) bool {
	t.Helper()
	if os.Getenv("DM_CONTROL_TEST_CHILD") == "1" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+t.Name()+"$", "-test.timeout=25s")
	cmd.Env = append(os.Environ(), "DM_CONTROL_TEST_CHILD=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("isolated synthetic control check failed: %v\n%s", err, out)
	}
	return false
}
func bootBytes() []byte {
	return []byte(`{"schema":"dream-maker.magpie-control.v2","epoch":"epoch_control","accounts":[{"provider":"deepseek-official","authRef":"auth_one","accountRef":"account_one","key":"` + controlCanaryKey + `"}]}`)
}
func controlFixture(t *testing.T, empty bool) (*credentialControl, string, []byte) {
	t.Helper()
	root := os.Getenv("DM_CONTROL_TEST_ROOT")
	if !strings.HasPrefix(strings.ToLower(filepath.Clean(root)), `f:\dreammakersuite\evidence\m07\`) {
		t.Fatal("F-only test root required")
	}
	folder := filepath.Join(root, t.Name())
	t.Setenv("XDG_CONFIG_HOME", folder)
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	appdir.UseExecutable("")
	rel, err := filepath.Rel(folder, appdir.Config())
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		t.Fatal("configuration escaped fixture")
	}
	if err := os.MkdirAll(appdir.Config(), 0700); err != nil {
		t.Fatal(err)
	}
	old := []byte(`{"providers":[{"id":"old-canary","key":"SYNTHETIC_OLD_CONTROL_ACCOUNT"}]}`)
	path := filepath.Join(appdir.Config(), "providers.json")
	if os.WriteFile(path, old, 0600) != nil {
		t.Fatal("old fixture failed")
	}
	raw := bootBytes()
	if empty {
		raw = []byte(`{"schema":"dream-maker.magpie-control.v1","epoch":"epoch_control"}`)
	}
	boot, err := parseBootstrap(raw)
	if err != nil {
		t.Fatal("valid bootstrap refused")
	}
	c, err := configureCredentials(boot)
	if err != nil {
		t.Fatal("synthetic catalog setup refused")
	}
	return c, path, old
}
func controlDraft(t *testing.T, c *credentialControl) dmbridge.Admission {
	t.Helper()
	accounts := c.Accounts()
	if len(accounts) != 1 {
		t.Fatal("catalog mapping unavailable")
	}
	a := dmbridge.Admission{Token: strings.Repeat("3", 64), ID: "grant_control", Epoch: "epoch_control", ProjectID: "project_control", FlowID: "run_control", ConfigurationHash: strings.Repeat("a", 64), BindingHash: strings.Repeat("b", 64), RoleID: "executor-1", Role: "executor", ReservationID: "reservation_control", Provider: accounts[0].Provider, Runtime: "dsh", Protocol: "chat-completions", Authentication: "api_key", Model: accounts[0].Model, AccountRef: accounts[0].AccountRef, AuthRef: accounts[0].AuthRef, UpstreamAccountRef: accounts[0].UpstreamAccountRef, Method: "POST", Path: "/v1/chat/completions", BodyHash: strings.Repeat("c", 64), ExpiresAtMs: time.Now().Add(30 * time.Second).UnixMilli(), MaxInputTokens: 1048576, MaxOutputTokens: 128}
	var err error
	a.RouteHash, err = dmbridge.AdmissionRouteHash(a)
	if err != nil {
		t.Fatal("route hashing failed")
	}
	return a
}
func issueBytes(t *testing.T, a dmbridge.Admission) []byte {
	t.Helper()
	raw, _ := json.Marshal(a)
	fields, err := dmbridge.RequestFields(raw)
	if err != nil {
		t.Fatal(err)
	}
	delete(fields, "upstreamKeyId")
	delete(fields, "upstreamKey")
	frame, err := json.Marshal(map[string]any{"type": "issue", "request": fields})
	if err != nil {
		t.Fatal(err)
	}
	return frame
}
func TestDMControlBootstrapIsExactAndSupportsOnlyExplicitSources(t *testing.T) {
	for _, raw := range [][]byte{bootBytes(), []byte(`{"schema":"dream-maker.magpie-control.v1","epoch":"epoch_control"}`), []byte(`{"schema":"dream-maker.magpie-control.v2","epoch":"epoch_control","accounts":[]}`)} {
		if _, err := parseBootstrap(raw); err != nil {
			t.Fatal("valid explicit bootstrap refused")
		}
	}
	base := string(bootBytes())
	bad := []string{
		strings.Replace(base, `"schema":`, `"Schema":`, 1), strings.Replace(base, `"epoch":"epoch_control"`, `"epoch":"epoch_control","epoch":"another"`, 1),
		strings.Replace(base, `"authRef":"auth_one"`, `"authRef":"auth_one","authRef":"another"`, 1), strings.Replace(base, `"key":"`+controlCanaryKey+`"`, `"key":"short"`, 1),
		strings.Replace(base, `"provider":"deepseek-official"`, `"provider":"other"`, 1), strings.Replace(base, `"authRef":"auth_one"`, `"authRef":"UNKNOWN"`, 1),
		strings.Replace(base, `"key":`, `"url":"https://example.invalid","key":`, 1), strings.Replace(base, `"accounts":[`, `"accounts":null,"ignored":[`, 1), base + ` {}`,
		strings.Replace(base, `control.v2`, `control.v1`, 1), strings.Repeat(" ", 16385) + base,
	}
	for _, raw := range bad {
		if _, err := parseBootstrap([]byte(raw)); err == nil {
			t.Fatal("malformed or widened bootstrap accepted")
		}
	}
	fields := []string{"authRef", "accountRef", "key"}
	var envelope map[string]json.RawMessage
	_ = json.Unmarshal(bootBytes(), &envelope)
	var accounts []json.RawMessage
	_ = json.Unmarshal(envelope["accounts"], &accounts)
	for _, keep := range fields {
		second := map[string]string{"provider": "deepseek-official", "authRef": "auth_two", "accountRef": "account_two", "key": controlCanaryKey + "_ALT"}
		original := map[string]string{}
		_ = json.Unmarshal(accounts[0], &original)
		second[keep] = original[keep]
		other, _ := json.Marshal(second)
		raw := `{"schema":"dream-maker.magpie-control.v2","epoch":"epoch_control","accounts":[` + string(accounts[0]) + `,` + string(other) + `]}`
		if _, err := parseBootstrap([]byte(raw)); err == nil {
			t.Fatal("duplicate source identity accepted")
		}
	}
}

func v3BootBytes() []byte {
	return []byte(`{"schema":"dream-maker.magpie-control.v3","epoch":"epoch_control","accounts":[` +
		`{"provider":"deepseek-official","model":"deepseek-flash","authentication":"api_key","chat":"https://api.deepseek.com/v1","responses":"","anthropic":"https://api.deepseek.com/anthropic","authRef":"auth_one","accountRef":"account_one","key":"` + controlCanaryKey + `"},` +
		`{"provider":"openai","model":"gpt-6-luna","authentication":"api_key","chat":"","responses":"https://api.openai.com/v1","anthropic":"","authRef":"auth_two","accountRef":"account_two","key":"SYNTHETIC_DM_CONTROL_ACCOUNT_OPENAI_9876543210"}]}`)
}

func TestDMControlV3BootstrapRegistersProviderRoutes(t *testing.T) {
	if !controlChild(t) {
		return
	}
	boot, err := parseBootstrap(v3BootBytes())
	if err != nil {
		t.Fatal("valid v3 bootstrap refused")
	}
	root := os.Getenv("DM_CONTROL_TEST_ROOT")
	folder := filepath.Join(root, t.Name())
	t.Setenv("XDG_CONFIG_HOME", folder)
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	appdir.UseExecutable("")
	if err := os.MkdirAll(appdir.Config(), 0700); err != nil {
		t.Fatal(err)
	}
	c, err := configureCredentials(boot)
	if err != nil {
		t.Fatal("v3 synthetic catalog setup refused")
	}
	if len(c.Accounts()) != 2 {
		t.Fatal("v3 catalog did not register both providers")
	}
	var openai registeredAccount
	for _, account := range c.Accounts() {
		if account.Provider == "openai" {
			openai = account
		}
	}
	if openai.Model != "gpt-6-luna" || openai.Authentication != "api_key" || openai.UpstreamAccountRef == "" {
		t.Fatal("openai registration lost its route identity")
	}
	draft := func(providerID, model, protocol, path string, account registeredAccount) dmbridge.Admission {
		a := dmbridge.Admission{Token: strings.Repeat("3", 64), ID: "grant_v3_" + providerID, Epoch: "epoch_control", ProjectID: "project_control", FlowID: "run_control", ConfigurationHash: strings.Repeat("a", 64), BindingHash: strings.Repeat("b", 64), RoleID: "reviewer", Role: "reviewer", ReservationID: "reservation_v3_" + providerID, Provider: providerID, Runtime: "codex", Protocol: protocol, Authentication: "api_key", Model: model, AccountRef: account.AccountRef, AuthRef: account.AuthRef, UpstreamAccountRef: account.UpstreamAccountRef, Method: "POST", Path: path, BodyHash: strings.Repeat("c", 64), ExpiresAtMs: time.Now().Add(30 * time.Second).UnixMilli(), MaxInputTokens: 1048576, MaxOutputTokens: 128}
		var err error
		a.RouteHash, err = dmbridge.AdmissionRouteHash(a)
		if err != nil {
			t.Fatal("route hashing failed")
		}
		return a
	}
	if !c.allowed(draft("openai", "gpt-6-luna", "openai-responses", "/v1/responses", openai)) {
		t.Fatal("v3 openai responses route refused")
	}
	if !c.allowed(draft("deepseek-official", "deepseek-flash", "chat-completions", "/v1/chat/completions", c.Accounts()[0])) {
		t.Fatal("v3 deepseek route refused")
	}
	if c.allowed(draft("openai", "deepseek-flash", "openai-responses", "/v1/responses", openai)) {
		t.Fatal("model from another provider accepted")
	}
}

func TestDMControlV3BootstrapAllowsDeclaredModelSetOnOneCredential(t *testing.T) {
	if !controlChild(t) {
		return
	}
	raw := []byte(`{"schema":"dream-maker.magpie-control.v3","epoch":"epoch_control","accounts":[` +
		`{"provider":"deepseek-official","model":"deepseek-flash","models":["deepseek-chat","deepseek-reasoner"],"authentication":"api_key","chat":"https://api.deepseek.com/v1","responses":"","anthropic":"https://api.deepseek.com/anthropic","authRef":"auth_one","accountRef":"account_one","key":"` + controlCanaryKey + `"}]}`)
	boot, err := parseBootstrap(raw)
	if err != nil {
		t.Fatal("declared model set refused")
	}
	root := os.Getenv("DM_CONTROL_TEST_ROOT")
	folder := filepath.Join(root, t.Name())
	t.Setenv("XDG_CONFIG_HOME", folder)
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	appdir.UseExecutable("")
	if err := os.MkdirAll(appdir.Config(), 0700); err != nil {
		t.Fatal(err)
	}
	c, err := configureCredentials(boot)
	if err != nil {
		t.Fatal("model-set catalog setup refused")
	}
	accounts := c.Accounts()
	if len(accounts) != 1 {
		t.Fatal("model-set catalog did not register exactly one account")
	}
	account := accounts[0]
	admit := func(model string) bool {
		a := dmbridge.Admission{Token: strings.Repeat("4", 64), ID: "grant_models_" + model, Epoch: "epoch_control", ProjectID: "project_control", FlowID: "run_control", ConfigurationHash: strings.Repeat("a", 64), BindingHash: strings.Repeat("b", 64), RoleID: "reviewer", Role: "reviewer", ReservationID: "reservation_models_" + model, Provider: "deepseek-official", Runtime: "independent", Protocol: "chat-completions", Authentication: "api_key", Model: model, AccountRef: account.AccountRef, AuthRef: account.AuthRef, UpstreamAccountRef: account.UpstreamAccountRef, Method: "POST", Path: "/v1/chat/completions", BodyHash: strings.Repeat("c", 64), ExpiresAtMs: time.Now().Add(30 * time.Second).UnixMilli(), MaxInputTokens: 1048576, MaxOutputTokens: 128}
		route, err := dmbridge.AdmissionRouteHash(a)
		if err != nil {
			t.Fatal("route hashing failed")
		}
		a.RouteHash = route
		return c.allowed(a)
	}
	for _, model := range []string{"deepseek-flash", "deepseek-chat", "deepseek-reasoner"} {
		if !admit(model) {
			t.Fatalf("declared model %s refused", model)
		}
	}
	if admit("deepseek-undeclared") {
		t.Fatal("undeclared model accepted")
	}
	for _, bad := range []string{
		strings.Replace(string(raw), `"models":["deepseek-chat","deepseek-reasoner"]`, `"models":["deepseek-chat","deepseek-chat"]`, 1),
		strings.Replace(string(raw), `"models":["deepseek-chat","deepseek-reasoner"]`, `"models":[]`, 1),
		strings.Replace(string(raw), `"models":["deepseek-chat","deepseek-reasoner"]`, `"models":["http://unsafe"]`, 1),
	} {
		if _, err := parseBootstrap([]byte(bad)); err == nil {
			t.Fatal("invalid model set accepted")
		}
	}
}

func TestDMControlV3BootstrapRejectsWidenedOrUnsafeAccounts(t *testing.T) {
	base := string(v3BootBytes())
	bad := []string{
		strings.Replace(base, `"chat":"https://api.deepseek.com/v1"`, `"chat":"http://api.deepseek.com/v1"`, 1),
		strings.Replace(base, `"authentication":"api_key"`, `"authentication":"oauth"`, 1),
		strings.Replace(base, `"model":"gpt-6-luna"`, `"model":""`, 1),
		strings.Replace(base, `"responses":"https://api.openai.com/v1"`, `"responses":"https://user:pass@api.openai.com/v1"`, 1),
		strings.Replace(base, `"responses":"https://api.openai.com/v1"`, `"responses":null`, 1),
		strings.Replace(base, `"responses":"https://api.openai.com/v1"`, `"responses":""`, 1),
		strings.Replace(base, `"provider":"openai"`, `"provider":"UNKNOWN"`, 1),
		strings.Replace(base, `"authRef":"auth_two"`, `"authRef":"auth_one"`, 1),
		strings.Replace(base, `"key":"SYNTHETIC_DM_CONTROL_ACCOUNT_OPENAI_9876543210"`, `"key":"`+controlCanaryKey+`"`, 1),
		strings.Replace(base, `"schema":"dream-maker.magpie-control.v3"`, `"schema":"dream-maker.magpie-control.v4"`, 1),
		strings.Replace(base, `"chat":"","responses"`, `"extra":"x","chat":"","responses"`, 1),
	}
	for _, raw := range bad {
		if _, err := parseBootstrap([]byte(raw)); err == nil {
			t.Fatal("unsafe v3 bootstrap accepted")
		}
	}
}

func TestDMControlCatalogUsesRealResolutionWithoutLeakingOrPersistingKeys(t *testing.T) {
	if !controlChild(t) {
		return
	}
	c, path, old := controlFixture(t, false)
	accounts := c.Accounts()
	if len(accounts) != 1 || accounts[0].Provider != "deepseek-official" || !strings.HasPrefix(accounts[0].UpstreamAccountRef, "deepseek-official/") {
		t.Fatal("actual canonical mapping missing")
	}
	encoded, _ := json.Marshal(accounts)
	if bytes.Contains(encoded, []byte(controlCanaryKey)) {
		t.Fatal("account metadata leaked key")
	}
	accounts[0].AuthRef = "changed"
	if c.Accounts()[0].AuthRef != "auth_one" {
		t.Fatal("caller changed catalog")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, old) {
		t.Fatal("old provider file changed")
	}
}
func TestDMControlIssueBindsActualKeyToTheEntireDraft(t *testing.T) {
	if !controlChild(t) {
		return
	}
	c, path, old := controlFixture(t, false)
	a := controlDraft(t, c)
	frame := issueBytes(t, a)
	ack, err := c.IssueFrame(frame)
	if err != nil || !ack.Accepted || ack.UpstreamKey == "" {
		t.Fatal("actual bounded issuance failed")
	}
	sum := sha256.Sum256(frame)
	if ack.ControlHash != hex.EncodeToString(sum[:]) || ack.ID != a.ID || ack.ReservationID != a.ReservationID {
		t.Fatal("issue reply lost exact frame identity")
	}
	a.UpstreamKeyID = ack.UpstreamKeyID
	a.UpstreamKey = ack.UpstreamKey
	who, err := access.Check(a.UpstreamKey)
	if err != nil || who.Limit == nil || who.Limit.Tokens != a.MaxInputTokens+a.MaxOutputTokens || len(who.Accounts) != 1 || who.Accounts[0] != a.UpstreamAccountRef {
		t.Fatal("actual key scope not established")
	}
	if c.Authorize(a) != nil {
		t.Fatal("matching full draft not authorized")
	}
	for _, change := range []func(*dmbridge.Admission){func(x *dmbridge.Admission) { x.Token = strings.Repeat("4", 64) }, func(x *dmbridge.Admission) { x.ProjectID = "another" }, func(x *dmbridge.Admission) { x.FlowID = "another" }, func(x *dmbridge.Admission) { x.BindingHash = strings.Repeat("d", 64) }, func(x *dmbridge.Admission) { x.RoleID = "executor-2" }, func(x *dmbridge.Admission) { x.MaxOutputTokens++ }, func(x *dmbridge.Admission) { x.AuthRef = "another" }, func(x *dmbridge.Admission) { x.ExpiresAtMs++ }} {
		x := a
		change(&x)
		if c.Authorize(x) == nil {
			t.Fatal("issued key was borrowed by another request")
		}
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, old) {
		t.Fatal("provider file changed")
	}
	if err = filepath.WalkDir(filepath.Dir(path), func(path string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if bytes.Contains(b, []byte(ack.UpstreamKey)) || bytes.Contains(b, []byte(controlCanaryKey)) {
			t.Fatal("new credential reached disk")
		}
		return nil
	}); err != nil {
		t.Fatal("credential file audit incomplete")
	}
}
func TestDMControlDuplicateReservationAndIdentityCannotMintAnotherKey(t *testing.T) {
	if !controlChild(t) {
		return
	}
	c, _, _ := controlFixture(t, false)
	a := controlDraft(t, c)
	if ack, err := c.IssueFrame(issueBytes(t, a)); err != nil || !ack.Accepted {
		t.Fatal("first issue failed")
	}
	for _, edit := range []func(*dmbridge.Admission){func(x *dmbridge.Admission) {}, func(x *dmbridge.Admission) { x.ID = "different_id" }, func(x *dmbridge.Admission) { x.ReservationID = "different_reservation" }} {
		x := a
		edit(&x)
		ack, err := c.IssueFrame(issueBytes(t, x))
		if err != nil || ack.Accepted || ack.UpstreamKey != "" {
			t.Fatal("duplicate issue minted another credential")
		}
	}
	keys, err := access.List()
	if err != nil || len(keys) != 1 {
		t.Fatal("duplicate attempt changed credential count")
	}
}
func TestDMControlIssueRejectsUnknownRouteLimitsAndMalformedFrames(t *testing.T) {
	if !controlChild(t) {
		return
	}
	c, _, _ := controlFixture(t, false)
	a := controlDraft(t, c)
	for _, edit := range []func(*dmbridge.Admission){func(x *dmbridge.Admission) { x.Provider = "other" }, func(x *dmbridge.Admission) { x.Model = "other" }, func(x *dmbridge.Admission) { x.AccountRef = "another" }, func(x *dmbridge.Admission) { x.AuthRef = "another" }, func(x *dmbridge.Admission) { x.UpstreamAccountRef = "deepseek-official/0000000000" }, func(x *dmbridge.Admission) { x.MaxInputTokens = 10 }, func(x *dmbridge.Admission) { x.MaxOutputTokens = 2097152 }, func(x *dmbridge.Admission) { x.ExpiresAtMs = time.Now().Add(5 * time.Minute).UnixMilli() }} {
		x := a
		edit(&x)
		ack, err := c.IssueFrame(issueBytes(t, x))
		if err != nil || ack.Accepted || ack.UpstreamKey != "" {
			t.Fatal("widened request acquired a key")
		}
	}
	frame := string(issueBytes(t, a))
	for _, raw := range []string{strings.Replace(frame, `"type":"issue"`, `"type":"issue","type":"issue"`, 1), strings.Replace(frame, `"authRef":"auth_one"`, `"authRef":"auth_one","authRef":"another"`, 1), strings.Replace(frame, `"request":{`, `"request":{"verified":true,`, 1), strings.Replace(frame, `"maxOutputTokens":128`, `"maxOutputTokens":128.5`, 1), frame + ` {}`} {
		if _, err := c.IssueFrame([]byte(raw)); err == nil {
			t.Fatal("malformed issue frame accepted")
		}
	}
	keys, err := access.List()
	if err != nil || len(keys) != 0 {
		t.Fatal("refused issue created a credential")
	}
}
func TestDMControlLegacyEmptyBootstrapCannotBorrowDiskCredentials(t *testing.T) {
	if !controlChild(t) {
		return
	}
	c, path, old := controlFixture(t, true)
	if len(c.Accounts()) != 0 {
		t.Fatal("empty bootstrap borrowed an account")
	}
	a := dmbridge.Admission{ID: "id_control", ReservationID: "reservation_control", Epoch: "epoch_control"}
	ack, err := c.IssueFrame(issueBytes(t, a))
	if err != nil || ack.Accepted || ack.UpstreamKey != "" {
		t.Fatal("empty bootstrap issued a key")
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, old) {
		t.Fatal("empty setup changed old data")
	}
}

func TestDMControlNestedGrantRejectsDuplicateAliasesAndNull(t *testing.T) {
	if !controlChild(t) {
		return
	}
	c, _, _ := controlFixture(t, false)
	handled := 0
	gate, err := dmbridge.New(dmbridge.Config{Epoch: "epoch_control", Authority: "127.0.0.1:12345", Authorize: c.Authorize, ValidateRequest: func(dmbridge.Admission, []byte) error { return nil }, Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { handled++ })})
	if err != nil {
		t.Fatal("control gate setup failed")
	}
	for i, edit := range []func(string) string{
		func(raw string) string {
			return strings.Replace(raw, `"projectId":"project_control"`, `"projectId":"project_control","projectId":null`, 1)
		},
		func(raw string) string { return strings.Replace(raw, `"projectId":`, `"ProjectId":`, 1) },
		func(raw string) string {
			return strings.Replace(raw, `"maxOutputTokens":128`, `"maxOutputTokens":128,"maxOutputTokens":null`, 1)
		},
		func(raw string) string { return strings.Replace(raw, `"upstreamKey":`, `"UpstreamKey":`, 1) },
	} {
		a := controlDraft(t, c)
		a.ID += "_" + strconv.Itoa(i)
		a.ReservationID += "_" + strconv.Itoa(i)
		sum := sha256.Sum256([]byte(a.ID))
		a.Token = hex.EncodeToString(sum[:])
		issued, err := c.IssueFrame(issueBytes(t, a))
		if err != nil || !issued.Accepted {
			t.Fatal("synthetic issue setup failed")
		}
		a.UpstreamKeyID, a.UpstreamKey = issued.UpstreamKeyID, issued.UpstreamKey
		raw, _ := json.Marshal(map[string]any{"type": "grant", "admission": a})
		changed := edit(string(raw))
		if kind, err := controlCommand([]byte(changed)); err == nil && kind == "grant" {
			ack, err := gate.GrantFrame([]byte(changed))
			if err == nil && ack.Accepted {
				t.Error("ambiguous nested grant reached an accepted authorization")
			}
		}
	}
	if handled != 0 {
		t.Fatal("control test invoked a protocol handler")
	}
}

func TestDMControlDedicatedGatewayAlwaysServesKeyLimits(t *testing.T) {
	if !controlChild(t) {
		return
	}
	c, _, _ := controlFixture(t, false)
	a := controlDraft(t, c)
	ack, err := c.IssueFrame(issueBytes(t, a))
	if err != nil || !ack.Accepted || ack.UpstreamKey == "" {
		t.Fatal("bounded synthetic key was not issued")
	}
	who, err := access.Check(ack.UpstreamKey)
	if err != nil || !who.Limited() {
		t.Fatal("issued identity is not limited")
	}
	stop := installDedicatedKeyLimits()
	defer stop()
	limiter, err := gwbudget.Limiting(who)
	if err != nil || limiter == nil {
		t.Fatalf("dedicated gateway does not serve its key limit: %v", err)
	}
	release, refused := limiter.Reserve(who, 8, a.Provider+"/"+a.Model, time.Now())
	if refused != nil || release == nil {
		t.Fatalf("valid bounded reservation refused: %v", refused)
	}
	release()
}

func TestDMCodexOwnerSubscriptionIssue(t *testing.T) {
	sub := subscriptionScope{ProjectID: "project1", FlowID: "run1", ConfigurationHash: strings.Repeat("b", 64), AccountFingerprint: strings.Repeat("d", 64), AuthRef: "auth1", AccountRef: "account1"}
	frame, _ := json.Marshal(map[string]any{"schema": "dream-maker.magpie-control.v4", "epoch": "epoch_control", "accounts": []any{}, "subscription": sub})
	boot, err := parseBootstrap(frame)
	if err != nil {
		t.Fatal(err)
	}
	c := &credentialControl{epoch: boot.Epoch, subscription: boot.Subscription, issued: map[string]dmbridge.Admission{}, ids: map[string]bool{}, reservations: map[string]bool{}, accounts: []registeredAccount{{Provider: "openai", Authentication: "oauth", Model: "gpt-6-luna", AuthRef: sub.AuthRef, AccountRef: sub.AccountRef, UpstreamAccountRef: "openai/" + sub.AccountFingerprint}}}
	a := dmbridge.Admission{ID: "grant1", ReservationID: "res1", Epoch: c.epoch, Token: strings.Repeat("1", 64), BindingHash: strings.Repeat("2", 64), BodyHash: strings.Repeat("3", 64), Method: "POST", ExpiresAtMs: time.Now().Add(time.Minute).UnixMilli(), MaxInputTokens: 1048576, MaxOutputTokens: 300, UpstreamAccountRef: c.Accounts()[0].UpstreamAccountRef}
	a.ProjectID, a.FlowID, a.ConfigurationHash = sub.ProjectID, sub.FlowID, sub.ConfigurationHash
	a.Role, a.RoleID, a.Runtime, a.Authentication, a.Provider, a.Protocol, a.Model, a.Path = "planner2", "planner2", "codex", "oauth", "openai", "openai-responses", "gpt-6-luna", "/backend-api/codex/responses"
	a.AuthRef, a.AccountRef = sub.AuthRef, sub.AccountRef
	a.SubscriptionRequestHash = strings.Repeat("e", 64)
	a.RouteHash, err = dmbridge.AdmissionRouteHash(a)
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*dmbridge.Admission){func(x *dmbridge.Admission) { x.FlowID = "another" }, func(x *dmbridge.Admission) { x.ConfigurationHash = x.BodyHash }, func(x *dmbridge.Admission) { x.Role = "reviewer" }, func(x *dmbridge.Admission) { x.SubscriptionRequestHash = "" }, func(x *dmbridge.Admission) { x.Path = "/v1/responses" }, func(x *dmbridge.Admission) { x.UpstreamAccountRef = "openai/other" }} {
		b := a
		mutate(&b)
		b.RouteHash, _ = dmbridge.AdmissionRouteHash(b)
		reply, _ := c.IssueFrame(issueBytes(t, b))
		if reply.Accepted {
			t.Fatal("foreign request issued")
		}
	}
	reply, err := c.IssueFrame(issueBytes(t, a))
	if err != nil || !reply.Accepted {
		t.Fatal("owner issue refused", err)
	}
	a.UpstreamKeyID, a.UpstreamKey = reply.UpstreamKeyID, reply.UpstreamKey
	if c.Authorize(a) != nil {
		t.Fatal("bound grant rejected")
	}
	raw, _ := json.Marshal(map[string]any{"type": "grant", "admission": a})
	if _, err := controlCommand(raw); err != nil {
		t.Fatal("grant frame refused")
	}
	if repeated, _ := c.IssueFrame(issueBytes(t, a)); repeated.Accepted {
		t.Fatal("duplicate issue")
	}
	a.SubscriptionRequestHash = strings.Repeat("f", 64)
	if c.Authorize(a) == nil {
		t.Fatal("changed grant accepted")
	}
}
