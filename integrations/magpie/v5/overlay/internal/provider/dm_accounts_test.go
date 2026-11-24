package provider

// Real provider methods with synthetic keys and an F-only child configuration.
// Separate children keep this one-shot registry out of the upstream test process.
import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/appdir"
)

const dmSyntheticA = "SYNTHETIC_DM_ACCOUNT_KEY_A_0123456789"
const dmSyntheticB = "SYNTHETIC_DM_ACCOUNT_KEY_B_9876543210"

func dmAccountChild(t *testing.T) bool {
	t.Helper()
	if os.Getenv("DM_PROVIDER_TEST_CHILD") == "1" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+t.Name()+"$", "-test.timeout=25s")
	cmd.Env = append(os.Environ(), "DM_PROVIDER_TEST_CHILD=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("isolated synthetic account check failed: %v\n%s", err, out)
	}
	return false
}
func dmAccountFixture(t *testing.T) ([]byte, string) {
	t.Helper()
	root := os.Getenv("DM_ACCOUNT_TEST_ROOT")
	if !strings.HasPrefix(strings.ToLower(filepath.Clean(root)), `f:\dreammakersuite\evidence\m07\`) {
		t.Fatal("F-only test root required")
	}
	folder := filepath.Join(root, t.Name())
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", folder)
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	appdir.UseExecutable("")
	target := Path()
	relative, err := filepath.Rel(folder, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		t.Fatal("test configuration escaped its explicit directory")
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	old := []byte(`{"providers":[{"id":"old-canary","name":"Old canary","key":"SYNTHETIC_OLD_ACCOUNT_MUST_NOT_BE_BORROWED","chat":"https://api.deepseek.com/v1","models":["deepseek-flash"]}]}`)
	if err = os.WriteFile(target, old, 0600); err != nil {
		t.Fatal(err)
	}
	return old, target
}
func dmAssertOldFileAndNoNewKeys(t *testing.T, old []byte, target string) {
	t.Helper()
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, old) {
		t.Fatal("pre-existing configuration changed")
	}
	err = filepath.WalkDir(filepath.Dir(target), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		b, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		if bytes.Contains(b, []byte(dmSyntheticA)) || bytes.Contains(b, []byte(dmSyntheticB)) {
			t.Fatal("new controller key persisted")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDMControllerAccountsUseRealResolutionWithoutPersistence(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	old, target := dmAccountFixture(t)
	keys := []string{dmSyntheticA, dmSyntheticB}
	if err := ConfigureDreamMakerAPIKeys(keys); err != nil {
		t.Fatal("valid synthetic setup refused")
	}
	keys[0] = "CALLER_CHANGED"
	all := All()
	if len(all) != 1 || all[0].ID != "deepseek-official" || all[0].Key != dmSyntheticA || len(all[0].Keys) != 1 || all[0].Keys[0].Key != dmSyntheticB {
		t.Fatal("unexpected volatile catalog")
	}
	for _, key := range []string{dmSyntheticA, dmSyntheticB} {
		id, err := ResolveAccount("deepseek-official", KeyID(key))
		if err != nil || id != "deepseek-official/"+KeyID(key) {
			t.Fatal("real canonical account resolution failed")
		}
	}
	if _, err := Find("old-canary"); err == nil {
		t.Fatal("pre-existing account was imported")
	}
	if err := Save(all[0]); err == nil {
		t.Fatal("managed provider Save accepted persistence")
	}
	changed := all[0]
	changed.Key = "SYNTHETIC_EDIT_MUST_NOT_REPLACE_ACTIVE_KEY"
	if err := Save(changed); err == nil {
		t.Fatal("managed provider replacement accepted")
	}
	if err := store(file{Providers: all}); err == nil {
		t.Fatal("managed direct store accepted persistence")
	}
	dmAssertOldFileAndNoNewKeys(t, old, target)
}
func TestDMControllerCatalogCannotBeMutatedThroughReturnedSlices(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	dmAccountFixture(t)
	if err := ConfigureDreamMakerAPIKeys([]string{dmSyntheticA, dmSyntheticB}); err != nil {
		t.Fatal(err)
	}
	all := All()
	all[0].Key = "CHANGED"
	all[0].Models[0] = "other-model"
	all[0].Keys[0].Key = "CHANGED"
	p, err := Find("deepseek-official")
	if err != nil || p.Key != dmSyntheticA || p.Models[0] != "deepseek-flash" || p.Keys[0].Key != dmSyntheticB {
		t.Fatal("caller mutated active catalog")
	}
	f, err := read()
	if err != nil {
		t.Fatal(err)
	}
	f.Providers[0].Key = "CHANGED"
	if All()[0].Key != dmSyntheticA {
		t.Fatal("read exposed mutable catalog state")
	}
}
func TestDMControllerEmptyCatalogDoesNotBorrowOrRewriteOldAccounts(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	old, target := dmAccountFixture(t)
	if err := ConfigureDreamMakerAPIKeys(nil); err != nil {
		t.Fatal(err)
	}
	if len(All()) != 0 || len(storedFile().Providers) != 0 {
		t.Fatal("empty managed catalog borrowed accounts")
	}
	if readElsewhere() != "" {
		t.Fatal("managed missing-account error points at daily profiles")
	}
	if err := store(file{}); err == nil {
		t.Fatal("empty managed catalog wrote the old file")
	}
	dmAssertOldFileAndNoNewKeys(t, old, target)
}
func TestDMControllerSetupIsExplicitValidatedAndOneShot(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	dmAccountFixture(t)
	for _, keys := range [][]string{{""}, {"tiny"}, {"has space key"}, {"line\nbreak key"}, {strings.Repeat("x", 513)}, {dmSyntheticA, dmSyntheticA}, make([]string, 9)} {
		err := ConfigureDreamMakerAPIKeys(keys)
		if err == nil {
			t.Fatal("malformed or duplicated account source accepted")
		}
		for _, key := range keys {
			if key != "" && strings.Contains(err.Error(), key) {
				t.Fatal("error disclosed a credential")
			}
		}
	}
	t.Setenv("MAGPIE_NO_ACCOUNTS", "0")
	if ConfigureDreamMakerAPIKeys([]string{dmSyntheticA}) == nil {
		t.Fatal("missing no-discovery requirement accepted")
	}
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	if ConfigureDreamMakerAPIKeys([]string{dmSyntheticA}) != nil {
		t.Fatal("valid final setup refused")
	}
	if ConfigureDreamMakerAPIKeys([]string{dmSyntheticB}) == nil || All()[0].Key != dmSyntheticA {
		t.Fatal("active account set could be replaced")
	}
}
func TestDMControllerHooksPreserveInactiveUpstreamStoreBehavior(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	_, target := dmAccountFixture(t)
	if err := store(file{Providers: []Provider{{ID: "legacy-canary", Name: "Legacy canary", Key: "SYNTHETIC_LEGACY_KEY", Chat: "https://api.deepseek.com/v1"}}}); err != nil {
		t.Fatal("inactive upstream store was changed")
	}
	bytes, err := os.ReadFile(target)
	if err != nil || !strings.Contains(string(bytes), "SYNTHETIC_LEGACY_KEY") {
		t.Fatal("inactive upstream file behavior changed")
	}
}

func TestDMControllerSetupCannotFollowLegacyCatalogIO(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	old, target := dmAccountFixture(t)
	if len(load().Providers) != 1 {
		t.Fatal("legacy fixture read failed")
	}
	if ConfigureDreamMakerAPIKeys([]string{dmSyntheticA}) == nil {
		t.Fatal("late setup could race or hide legacy I/O")
	}
	dmAssertOldFileAndNoNewKeys(t, old, target)
}

func TestDMControllerAccountsAcceptDistinctProviders(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	old, target := dmAccountFixture(t)
	err := ConfigureDreamMakerAccounts([]DMAccount{
		{Provider: "deepseek-official", Model: "deepseek-flash", Chat: "https://api.deepseek.com/v1", Anthropic: "https://api.deepseek.com/anthropic", Key: dmSyntheticA},
		{Provider: "openai", Model: "gpt-6-luna", Responses: "https://api.openai.com/v1", Key: dmSyntheticB},
	})
	if err != nil {
		t.Fatal("valid multi-provider setup refused")
	}
	all := All()
	if len(all) != 2 || all[0].ID != "deepseek-official" || all[1].ID != "openai" {
		t.Fatal("unexpected multi-provider catalog")
	}
	if all[1].Responses != "https://api.openai.com/v1" || all[1].Chat != "" || all[1].Key != dmSyntheticB {
		t.Fatal("second provider endpoints or key changed")
	}
	if len(all[1].Models) != 1 || all[1].Models[0] != "gpt-6-luna" {
		t.Fatal("second provider model missing")
	}
	for _, want := range [][2]string{{"deepseek-official", dmSyntheticA}, {"openai", dmSyntheticB}} {
		id, err := ResolveAccount(want[0], KeyID(want[1]))
		if err != nil || id != want[0]+"/"+KeyID(want[1]) {
			t.Fatal("canonical account resolution failed for a provider")
		}
	}
	f, err := read()
	if err != nil || len(f.Providers) != 2 || f.Providers[1].Key != dmSyntheticB {
		t.Fatal("managed catalog read did not return both providers")
	}
	dmAssertOldFileAndNoNewKeys(t, old, target)
}

func TestDMAccountModelSetIsValidatedAndUnioned(t *testing.T) {
	base := DMAccount{Provider: "deepseek-official", Model: "deepseek-flash", Models: []string{"deepseek-chat", "deepseek-reasoner"}, Chat: "https://api.deepseek.com/v1", Anthropic: "https://api.deepseek.com/anthropic", Key: dmSyntheticA}
	if err := ValidateDMAccount(base); err != nil {
		t.Fatal("declared model set refused")
	}
	if got := accountModelSet(base); len(got) != 3 || got[0] != "deepseek-flash" || got[1] != "deepseek-chat" || got[2] != "deepseek-reasoner" {
		t.Fatalf("model set was not unioned in order: %v", got)
	}
	single := base
	single.Models = nil
	if got := accountModelSet(single); len(got) != 1 || got[0] != "deepseek-flash" {
		t.Fatalf("single-model shorthand changed: %v", got)
	}
	bad := []DMAccount{
		{Provider: "deepseek-official", Model: "deepseek-flash", Models: []string{"deepseek-chat", "deepseek-chat"}, Chat: "https://api.deepseek.com/v1", Key: dmSyntheticA},
		{Provider: "deepseek-official", Model: "deepseek-flash", Models: []string{""}, Chat: "https://api.deepseek.com/v1", Key: dmSyntheticA},
		{Provider: "deepseek-official", Model: "deepseek-flash", Models: []string{"http://unsafe"}, Chat: "https://api.deepseek.com/v1", Key: dmSyntheticA},
		{Provider: "deepseek-official", Model: "deepseek-flash", Models: []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}, Chat: "https://api.deepseek.com/v1", Key: dmSyntheticA},
	}
	for _, account := range bad {
		if ValidateDMAccount(account) == nil {
			t.Fatal("invalid model set accepted")
		}
	}
}

func TestDMControllerAccountsRejectUnsafeEndpoints(t *testing.T) {
	if !dmAccountChild(t) {
		return
	}
	dmAccountFixture(t)
	cases := [][]DMAccount{
		{{Provider: "openai", Model: "gpt-6-luna", Chat: "http://api.openai.com/v1", Key: dmSyntheticA}},
		{{Provider: "openai", Model: "gpt-6-luna", Chat: "https://user:pass@api.openai.com/v1", Key: dmSyntheticA}},
		{{Provider: "openai", Model: "gpt-6-luna", Chat: "https://api.openai.com/v1?x=1", Key: dmSyntheticA}},
		{{Provider: "openai", Model: "bad model", Chat: "https://api.openai.com/v1", Key: dmSyntheticA}},
		{{Provider: "UNKNOWN", Model: "gpt-6-luna", Chat: "https://api.openai.com/v1", Key: dmSyntheticA}},
		{{Provider: "openai", Model: "gpt-6-luna", Key: dmSyntheticA}},
		{
			{Provider: "openai", Model: "gpt-6-luna", Chat: "https://api.openai.com/v1", Key: dmSyntheticA},
			{Provider: "openai", Model: "gpt-6-luna", Chat: "https://api.openai.com/v2", Key: dmSyntheticB},
		},
		{
			{Provider: "deepseek-official", Model: "deepseek-flash", Chat: "https://api.deepseek.com/v1", Key: dmSyntheticA},
			{Provider: "openai", Model: "gpt-6-luna", Chat: "https://api.openai.com/v1", Key: dmSyntheticA},
		},
	}
	for _, accounts := range cases {
		if ConfigureDreamMakerAccounts(accounts) == nil {
			t.Fatal("unsafe account source accepted")
		}
	}
}
