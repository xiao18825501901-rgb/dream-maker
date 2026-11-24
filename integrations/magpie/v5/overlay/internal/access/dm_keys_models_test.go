package access

// Guard: the DM issuer must accept any model registered by the one-shot
// account catalog, not only the legacy deepseek-flash default.
import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/provider"
)

const dmModelsAccount = "SYNTHETIC_DM_MODELS_ACCOUNT_0123456789"

func dmModelsChild(t *testing.T) bool {
	t.Helper()
	if os.Getenv("DM_ISSUER_CHILD") == "1" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+t.Name()+"$", "-test.timeout=25s")
	cmd.Env = append(os.Environ(), "DM_ISSUER_CHILD=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("isolated synthetic issuer check failed: %v\n%s", err, out)
	}
	return false
}

func dmModelsFixture(t *testing.T, models []string) {
	t.Helper()
	root := os.Getenv("DM_ISSUER_TEST_ROOT")
	clean := strings.ToLower(filepath.Clean(root))
	if !strings.HasPrefix(clean, `f:\dreammakersuite\evidence\m07\`) && !strings.HasPrefix(clean, `e:\dreammakersuite\custom-mvp\evidence\go-issuer-tests\`) {
		t.Fatal("isolated issuer fixture root required")
	}
	folder := filepath.Join(root, t.Name())
	t.Setenv("XDG_CONFIG_HOME", folder)
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	appdir.UseExecutable("")
	target := Path()
	rel, err := filepath.Rel(folder, target)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		t.Fatal("fixture escaped its root")
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	old, err := json.Marshal([]Key{{ID: "old-caller", Name: "Synthetic old key", Secret: dmOldCaller, Models: []string{"deepseek-official/deepseek-flash"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(target, old, 0600); err != nil {
		t.Fatal(err)
	}
	accounts := []provider.DMAccount{{
		Provider:  "deepseek-official",
		Model:     "deepseek-flash",
		Models:    models,
		Chat:      "https://api.deepseek.com/v1",
		Anthropic: "https://api.deepseek.com/anthropic",
		Key:       dmModelsAccount,
	}}
	if err = provider.ConfigureDreamMakerAccounts(accounts); err != nil {
		t.Fatalf("synthetic multi-model setup failed: %v", err)
	}
	if err = ConfigureDreamMakerKeyStore(); err != nil {
		t.Fatalf("synthetic managed key store setup failed: %v", err)
	}
}

func TestDMKeyStoreIssuesAnyRegisteredModel(t *testing.T) {
	if !dmModelsChild(t) {
		return
	}
	dmModelsFixture(t, []string{"deepseek-chat", "deepseek-reasoner"})
	ref, err := provider.ResolveAccount("deepseek-official", provider.KeyID(dmModelsAccount))
	if err != nil {
		t.Fatal("synthetic account resolution failed")
	}
	for _, model := range []string{"deepseek-official/deepseek-flash", "deepseek-official/deepseek-chat", "deepseek-official/deepseek-reasoner"} {
		if _, err = IssueKey(Issue{Name: "DM model scope", TTL: time.Minute, Models: []string{model}, Accounts: []string{ref}, Tokens: 1049600}); err != nil {
			t.Fatalf("registered model %q was refused: %v", model, err)
		}
	}
	if _, err = IssueKey(Issue{Name: "DM model scope", TTL: time.Minute, Models: []string{"deepseek-official/not-registered"}, Accounts: []string{ref}, Tokens: 1049600}); err == nil {
		t.Fatal("unregistered model scope was accepted")
	}
}

