// DM-only volatile issued-key store. The original Engine owns dispatch and money.
package access

import (
	"errors"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

var dmKeyDenied = errors.New("DM_ISSUED_KEY_STORE_DENIED")
var dmIssuedID = regexp.MustCompile(`^[a-f0-9]{24}$`)
var dmIssuedSecret = regexp.MustCompile(`^sk-magpie-key-[a-f0-9]{48}$`)
var dmIssuedAccount = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}/[a-f0-9]{10}$`)
var dmKeys struct {
	sync.Mutex
	active, legacyUsed bool
	keys               []Key
}

// Explicit and one-shot. This neither discovers accounts nor authenticates them.
func ConfigureDreamMakerKeyStore() error {
	if os.Getenv("MAGPIE_NO_ACCOUNTS") != "1" {
		return dmKeyDenied
	}
	dmKeys.Lock()
	defer dmKeys.Unlock()
	if dmKeys.active || dmKeys.legacyUsed {
		return dmKeyDenied
	}
	dmKeys.active = true
	return nil
}

func dmCloneKeys(keys []Key) []Key {
	copy := slices.Clone(keys)
	for i := range copy {
		copy[i].Models = slices.Clone(copy[i].Models)
		copy[i].Accounts = slices.Clone(copy[i].Accounts)
		copy[i].More = slices.Clone(copy[i].More)
		if copy[i].Limit != nil {
			limit := *copy[i].Limit
			copy[i].Limit = &limit
		}
	}
	return copy
}

func dreamMakerKeyStoreEnabled() bool {
	dmKeys.Lock()
	defer dmKeys.Unlock()
	if !dmKeys.active {
		dmKeys.legacyUsed = true
	}
	return dmKeys.active
}

func dmPruneExpiredKeysLocked(now time.Time) {
	dmKeys.keys = slices.DeleteFunc(dmKeys.keys, func(k Key) bool { return k.expired(now) })
}

// Called before credential-content I/O, including ownSecrets' filesystem cache.
// Upstream's non-secret lock file remains in the dedicated portable directory.
func dreamMakerKeySnapshot() ([]Key, bool) {
	dmKeys.Lock()
	defer dmKeys.Unlock()
	if !dmKeys.active {
		dmKeys.legacyUsed = true
		return nil, false
	}
	dmPruneExpiredKeysLocked(Now())
	return dmCloneKeys(dmKeys.keys), true
}

func dreamMakerSaveKeys(keys []Key) (bool, error) {
	dmKeys.Lock()
	defer dmKeys.Unlock()
	if !dmKeys.active {
		dmKeys.legacyUsed = true
		return false, nil
	}
	// At most one newly issued key may accompany the previous 64 entries.
	if len(keys) > 65 {
		return true, dmKeyDenied
	}
	now := Now()
	dmPruneExpiredKeysLocked(now)
	copy := slices.DeleteFunc(dmCloneKeys(keys), func(k Key) bool { return k.expired(now) })
	if len(copy) > 64 {
		return true, dmKeyDenied
	}
	previous := map[string]Key{}
	for _, k := range dmKeys.keys {
		previous[k.ID] = k
	}
	ids, secrets := map[string]bool{}, map[string]bool{}
	for _, k := range copy {
		if !dmIssuedID.MatchString(k.ID) || !dmIssuedSecret.MatchString(k.Secret) || ids[k.ID] || secrets[k.Secret] ||
			k.Off || k.LAN || k.Issues || k.Quotas || k.ReadOnly || k.Issuer != "" ||
			len(k.Models) != 1 || len(k.Accounts) != 1 ||
			!provider.DMModelRegistered(k.Accounts[0], k.Models[0]) || !dmIssuedAccount.MatchString(k.Accounts[0]) ||
			k.Expires.IsZero() || k.Expires.After(Now().Add(2*time.Minute)) ||
			k.Limit == nil || k.Limit.Tokens < 1 || k.Limit.Tokens > 2097152 || k.Limit.Cost != 0 ||
			k.Limit.Period != "hours" || k.Limit.Hours != 1 || k.Limit.Days != 0 || len(k.More) != 0 {
			return true, dmKeyDenied
		}
		if k.Limit.Since.IsZero() || k.Limit.Since.After(now) || k.Limit.Since.Add(time.Hour).Before(k.Expires) {
			return true, dmKeyDenied
		}
		if was, found := previous[k.ID]; found && !reflect.DeepEqual(was, k) {
			return true, dmKeyDenied
		}
		providerID, keyID, _ := strings.Cut(k.Accounts[0], "/")
		_, _, explicit := provider.DMExplicitRoute(k.Accounts[0], "", "")
		if !explicit && providerID != "string" && providerID != "deepseek-official" {
			return true, dmKeyDenied
		}
		if !explicit && providerID == "string" && (k.Models[0] != "string/claude-sonnet-5" || provider.DreamMakerMessagesTarget(k.Accounts[0], "claude-sonnet-5") == "") {
			return true, dmKeyDenied
		}
		canonical, err := provider.ResolveAccount(providerID, keyID)
		if err != nil || canonical != k.Accounts[0] {
			return true, dmKeyDenied
		}
		ids[k.ID], secrets[k.Secret] = true, true
	}
	dmKeys.keys = copy
	return true, nil
}
