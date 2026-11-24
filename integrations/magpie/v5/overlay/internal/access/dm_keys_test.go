package access

// Real access/provider APIs; every key and old file is synthetic and F-scoped.
import (
	"bytes"
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
	"github.com/yetone/magpie/internal/settings"
)

const dmIssuerAccount = "SYNTHETIC_DM_ISSUER_ACCOUNT_0123456789"
const dmOldCaller = "SYNTHETIC_OLD_GATEWAY_KEY_MUST_NOT_BE_BORROWED"

func dmIssuerChild(t *testing.T) bool {
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
func dmIssuerFixture(t *testing.T, managed bool) (string, []byte) {
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
	if managed {
		if provider.ConfigureDreamMakerAPIKeys([]string{dmIssuerAccount}) != nil || ConfigureDreamMakerKeyStore() != nil {
			t.Fatal("explicit synthetic setup failed")
		}
	}
	return target, old
}
func dmIssue(t *testing.T) Issued {
	t.Helper()
	ref, err := provider.ResolveAccount("deepseek-official", provider.KeyID(dmIssuerAccount))
	if err != nil {
		t.Fatal("synthetic account resolution failed")
	}
	issued, err := IssueKey(Issue{Name: "DM synthetic request", TTL: time.Minute, Models: []string{"deepseek-official/deepseek-flash"}, Accounts: []string{ref}, Tokens: 1049600})
	if err != nil {
		t.Fatal("bounded key issuance failed")
	}
	return issued
}
func dmIssuerDiskUnchanged(t *testing.T, target string, old []byte, secret string) {
	t.Helper()
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(old, got) {
		t.Fatal("old caller file changed")
	}
	err = filepath.WalkDir(filepath.Dir(target), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if secret != "" && bytes.Contains(b, []byte(secret)) || bytes.Contains(b, []byte(dmIssuerAccount)) {
			t.Fatal("controller secret reached disk")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestDMKeyStoreRealIssueCheckRevokeWithoutDiskSecrets(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	target, old := dmIssuerFixture(t, true)
	if _, err := Check(dmOldCaller); err == nil || Named(dmOldCaller) {
		t.Fatal("old gateway key was borrowed")
	}
	issued := dmIssue(t)
	who, err := Check(issued.Key)
	if err != nil || who.KeyID != issued.ID || who.Default || who.Issues || who.Issuer != nil || who.AccountModels || len(who.Accounts) != 1 || len(who.Models) != 1 {
		t.Fatal("real issued scope was lost")
	}
	if err = RevokeIssued(issued.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = Check(issued.Key); err == nil {
		t.Fatal("revoked key remained usable")
	}
	dmIssuerDiskUnchanged(t, target, old, issued.Key)
}
func TestDMKeyStoreCopiesOnLoadSaveAndIdentity(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	dmIssuerFixture(t, true)
	issued := dmIssue(t)
	keys, err := load()
	if err != nil || len(keys) != 1 {
		t.Fatal("memory load failed")
	}
	if err = save(keys); err != nil {
		t.Fatal("safe same-scope memory save failed")
	}
	keys[0].Secret = "CHANGED"
	keys[0].Models[0] = "other/model"
	keys[0].Accounts[0] = "other/account"
	keys[0].Limit.Tokens = 0
	who, err := Check(issued.Key)
	if err != nil || who.Models[0] != "deepseek-official/deepseek-flash" || who.Limit.Tokens != 1049600 {
		t.Fatal("caller mutated memory store")
	}
	who.Models[0] = "other/model"
	who.Accounts[0] = "other/account"
	who.Limit.Tokens = 0
	next, err := Check(issued.Key)
	if err != nil || next.Models[0] != "deepseek-official/deepseek-flash" || next.Limit.Tokens != 1049600 {
		t.Fatal("identity exposed mutable memory state")
	}
}
func TestDMKeyStoreRefusesBroadOrUnboundedIssuedKeys(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	target, old := dmIssuerFixture(t, true)
	issued := dmIssue(t)
	for _, change := range []func(*Key){
		func(k *Key) { k.Models = nil }, func(k *Key) { k.Models = []string{"deepseek-official/*"} }, func(k *Key) { k.Models = []string{"group/wide"} },
		func(k *Key) { k.Accounts = nil }, func(k *Key) { k.Accounts = []string{"deepseek-official/missing"} }, func(k *Key) { k.Issues = true },
		func(k *Key) { k.LAN = true }, func(k *Key) { k.Quotas = true }, func(k *Key) { k.Issuer = "another" },
		func(k *Key) { k.Expires = time.Time{} }, func(k *Key) { k.Expires = time.Now().Add(3 * time.Minute) },
		func(k *Key) { k.Limit = nil }, func(k *Key) { k.Limit.Tokens = 0 }, func(k *Key) { k.Limit.Tokens = 2097153 },
		func(k *Key) { k.More = []Limit{{Period: "hours", Hours: 1, Tokens: 1}} },
	} {
		keys, err := load()
		if err != nil || len(keys) != 1 {
			t.Fatal("memory load failed")
		}
		change(&keys[0])
		if save(keys) == nil {
			t.Fatal("broadened key store replacement accepted")
		}
		if _, err = Check(issued.Key); err != nil {
			t.Fatal("failed replacement damaged the current key")
		}
	}
	for _, in := range []Issue{{TTL: time.Minute}, {TTL: time.Minute, Models: []string{"deepseek-official/*"}, Tokens: 1}, {TTL: 3 * time.Minute, Models: []string{"deepseek-official/deepseek-flash"}, Accounts: []string{"deepseek-official/" + provider.KeyID(dmIssuerAccount)}, Tokens: 1}} {
		if _, err := IssueKey(in); err == nil {
			t.Fatal("unapproved issued key accepted")
		}
	}
	dmIssuerDiskUnchanged(t, target, old, issued.Key)
}
func TestDMKeyStoreSetupRequiresDiscoveryOffAndIsOneShot(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	dmIssuerFixture(t, false)
	t.Setenv("MAGPIE_NO_ACCOUNTS", "0")
	if ConfigureDreamMakerKeyStore() == nil {
		t.Fatal("discovery guard absent")
	}
	t.Setenv("MAGPIE_NO_ACCOUNTS", "1")
	if ConfigureDreamMakerKeyStore() != nil {
		t.Fatal("valid setup refused")
	}
	if ConfigureDreamMakerKeyStore() == nil {
		t.Fatal("memory store could be reset")
	}
}
func TestDMKeyStoreInactiveUpstreamBehaviorRemains(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	target, _ := dmIssuerFixture(t, false)
	if save([]Key{{ID: "legacy-test", Secret: "SYNTHETIC_LEGACY_GATEWAY_KEY"}}) != nil {
		t.Fatal("inactive upstream write changed")
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Contains(got, []byte("SYNTHETIC_LEGACY_GATEWAY_KEY")) {
		t.Fatal("inactive storage did not preserve its behavior")
	}
}
func TestDMKeyStoreCannotEnableAfterLegacyContentIO(t *testing.T) {
	for _, kind := range []string{"load", "ownSecrets"} {
		t.Run(kind, func(t *testing.T) {
			if !dmIssuerChild(t) {
				return
			}
			dmIssuerFixture(t, false)
			if kind == "load" {
				if keys, err := load(); err != nil || len(keys) != 1 {
					t.Fatal("legacy fixture load failed")
				}
			} else {
				if _, ok := ownSecrets()[dmOldCaller]; !ok {
					t.Fatal("legacy own-secret fixture failed")
				}
			}
			if ConfigureDreamMakerKeyStore() == nil {
				t.Fatal("late activation accepted")
			}
		})
	}
}

func TestDMKeyStoreBudgetAnchorsCannotBeMoved(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	dmIssuerFixture(t, true)
	issued := dmIssue(t)
	original, err := load()
	if err != nil || len(original) != 1 {
		t.Fatal("memory load failed")
	}
	future := dmCloneKeys(original)
	future[0].Limit.Since = Now().Add(time.Hour)
	if save(future) == nil {
		t.Error("future budget anchor accepted")
	}
	if save(original) != nil {
		t.Fatal("original key could not be retained")
	}
	clock := Now
	defer func() { Now = clock }()
	now := clock().Add(time.Second)
	Now = func() time.Time { return now }
	reset := dmCloneKeys(original)
	reset[0].Limit.Since = now
	if save(reset) == nil {
		t.Error("existing budget anchor could be reset")
	}
	who, err := Check(issued.Key)
	if err != nil || !who.Limit.Since.Equal(original[0].Limit.Since) {
		t.Error("original budget anchor changed")
	}
}

func TestDMKeyStoreLegacyLANMetadataCannotMirrorManagedSecrets(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	target, old := dmIssuerFixture(t, true)
	issued := dmIssue(t)
	config := settings.Load()
	config.LAN = false
	config.LANKeyID = issued.ID
	if settings.Save(config) != nil {
		t.Fatal("synthetic metadata setup failed")
	}
	who, err := Check(issued.Key)
	if err != nil || who.Default {
		t.Error("legacy LAN id reclassified a managed key")
	}
	if Default(issued.Key) {
		t.Error("legacy default lookup reclassified a managed key")
	}
	if _, err = Update("on-key", Change{Key: issued.ID}); err == nil {
		t.Error("legacy update accepted a managed key")
	}
	bytes, err := os.ReadFile(settings.Path())
	if err != nil || strings.Contains(string(bytes), issued.Key) {
		t.Error("failed legacy update persisted a managed secret")
	}
	dmIssuerDiskUnchanged(t, target, old, issued.Key)
}

func TestDMKeyStoreExpiredKeysDoNotExhaustIssuanceCapacity(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	dmIssuerFixture(t, true)
	clock := Now
	defer func() { Now = clock }()
	now := clock().Round(0)
	Now = func() time.Time { return now }
	first := ""
	for i := 0; i < 64; i++ {
		issued := dmIssue(t)
		if i == 0 {
			first = issued.Key
		}
	}
	now = now.Add(2 * time.Minute)
	if _, err := Check(first); err == nil {
		t.Fatal("expired key remained valid")
	}
	issued := dmIssue(t)
	if _, err := Check(issued.Key); err != nil {
		t.Fatal("fresh key unusable after expiry reclamation")
	}
	if keys, err := load(); err != nil || len(keys) != 1 {
		t.Fatal("expired entries remained in the active capacity")
	}
}

func TestDMKeyStoreSnapshotsCannotRenameOrReviveCredentials(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	dmIssuerFixture(t, true)
	issued := dmIssue(t)
	snapshot, err := load()
	if err != nil || len(snapshot) != 1 {
		t.Fatal("snapshot unavailable")
	}
	if Restore(snapshot) == nil {
		t.Error("managed credential snapshot restore accepted")
	}
	renamed := dmCloneKeys(snapshot)
	renamed[0].ID = strings.Repeat("f", 24)
	if renamed[0].ID == issued.ID {
		renamed[0].ID = strings.Repeat("e", 24)
	}
	if Restore(renamed) == nil {
		t.Error("same secret could change its budget identity")
	}
	if who, err := Check(issued.Key); err != nil || who.KeyID != issued.ID {
		t.Error("credential identity changed")
	}
	if save(snapshot) != nil {
		t.Fatal("test could not retain original state")
	}
	if RevokeIssued(issued.ID, "") != nil {
		t.Fatal("revocation failed")
	}
	if Restore(snapshot) == nil {
		t.Error("revoked credential could be restored")
	}
	if _, err := Check(issued.Key); err == nil {
		t.Error("revoked credential became valid again")
	}
}

func TestDMKeyStoreEnabledPredicateIgnoresLegacyLANSecret(t *testing.T) {
	if !dmIssuerChild(t) {
		return
	}
	dmIssuerFixture(t, true)
	secret := "SYNTHETIC_OLD_LAN_METADATA_KEY"
	config := settings.Load()
	config.LAN = true
	config.LANKey = secret
	config.LANKeyID = ""
	if settings.Save(config) != nil {
		t.Fatal("synthetic LAN metadata setup failed")
	}
	if On(legacyLANKey(secret).ID) {
		t.Error("unknown managed identity enabled by legacy LAN metadata")
	}
	if _, err := Check(secret); err == nil {
		t.Error("legacy LAN credential authenticated")
	}
	if Default(secret) || LANSecret() != "" {
		t.Error("managed mode borrowed legacy LAN credential")
	}
}
