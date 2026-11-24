// DM-specific volatile catalog. Never used by the user's installed Magpie.
package provider

import (
	"crypto/sha256"
	"errors"
	"net"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
)

var dmAccountDenied = errors.New("DM_ACCOUNT_CONFIGURATION_DENIED")

// DMAccount is one controller-supplied upstream account. The controller is the
// only writer; nothing here is discovered from a user profile.
type DMAccount struct {
	Capabilities []DMCapability
	Provider     string
	Model        string
	Models       []string
	Chat         string
	Responses    string
	Anthropic    string
	Key          string
}

type dmMessagesAccount struct {
	targets map[string]string
	keyHash [sha256.Size]byte
}

var dmCatalog struct {
	sync.Mutex
	active         bool
	legacyUsed     bool
	providers      []Provider
	explicit       map[string]DMAccount
	accountModels  map[string][]string
	messagesRoutes map[string]dmMessagesAccount
}

const dmDeepSeekProvider = "deepseek-official"

func dmRefOK(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for i, char := range []byte(value) {
		if char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			continue
		}
		if i == 0 || (char != '_' && char != '.' && char != ':' && char != '-') {
			return false
		}
	}
	switch strings.ToUpper(value) {
	case "UNKNOWN", "NOT_VERIFIED":
		return false
	}
	return true
}

func dmModelOK(value string) bool {
	if len(value) < 1 || len(value) > 128 || strings.Contains(value, "://") {
		return false
	}
	for i, char := range []byte(value) {
		if char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			continue
		}
		if i == 0 || (char != '_' && char != '.' && char != ':' && char != '/' && char != '-') {
			return false
		}
	}
	return true
}

// dmURLOK accepts an empty URL (a provider may serve only some wires) or an
// absolute HTTPS endpoint without userinfo, query or fragment.
func dmURLOK(value string) bool {
	if value == "" {
		return true
	}
	if strings.ContainsAny(value, " \t\r\n") {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	return true
}

// ValidateDMAccount checks one account without touching the catalog, so a caller
// can reject a malformed frame before registration begins.
func ValidateDMAccount(account DMAccount) error {
	if len(account.Capabilities) > 0 {
		return validateExplicit(account)
	}
	if !dmRefOK(account.Provider) || !dmModelOK(account.Model) || !dmURLOK(account.Chat) || !dmURLOK(account.Responses) || !dmURLOK(account.Anthropic) {
		return dmAccountDenied
	}
	// An account may serve several models of one provider. The legacy single
	// model stays the default, so an account without Models is validated exactly
	// as before.
	if len(account.Models) > 8 {
		return dmAccountDenied
	}
	seenModel := map[string]bool{}
	for _, model := range account.Models {
		if !dmModelOK(model) || seenModel[model] {
			return dmAccountDenied
		}
		seenModel[model] = true
	}
	if account.Model == "" && len(account.Models) == 0 {
		return dmAccountDenied
	}
	if account.Chat == "" && account.Responses == "" && account.Anthropic == "" {
		return dmAccountDenied
	}
	if len(account.Key) < 8 || len(account.Key) > 512 {
		return dmAccountDenied
	}
	for _, char := range []byte(account.Key) {
		if char < 0x21 || char > 0x7e {
			return dmAccountDenied
		}
	}
	return nil
}

// accountModelSet returns the exact set of models this account may serve.
// Model stays the single-model shorthand used by v2 callers.
func accountModelSet(account DMAccount) []string {
	set := make([]string, 0, len(account.Models)+1)
	seen := map[string]bool{}
	all := append([]string{account.Model}, account.Models...)
	for _, c := range account.Capabilities {
		all = append(all, c.Model)
	}
	for _, model := range all {
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		set = append(set, model)
	}
	return set
}

// DMModelRegistered reports whether the one-shot volatile catalog registered
// model for the canonical account. It is a catalog check, not an account or
// authentication proof; the caller still validates the key scope separately.
func DMModelRegistered(account, model string) bool {
	providerID, modelID, ok := strings.Cut(model, "/")
	if !ok || modelID == "" || !strings.HasPrefix(account, providerID+"/") {
		return false
	}
	dmCatalog.Lock()
	defer dmCatalog.Unlock()
	if !dmCatalog.active {
		return false
	}
	return slices.Contains(dmCatalog.accountModels[account], modelID)
}

// ConfigureDreamMakerAccounts must precede all provider reads/writes and server
// startup. Registration is not an authentication, model, budget or runtime proof.
// Accounts are grouped by provider; every account of one provider must name the
// same endpoint set.
func ConfigureDreamMakerAccounts(accounts []DMAccount) error {
	if os.Getenv("MAGPIE_NO_ACCOUNTS") != "1" || len(accounts) > 8 {
		return dmAccountDenied
	}
	seenKey := map[string]bool{}
	exact := map[string]DMAccount{}
	registered := map[string][]string{}
	legacy := map[string]bool{}
	var order []string
	grouped := map[string]*Provider{}
	models := map[string][]string{}
	messagesRoutes := map[string]dmMessagesAccount{}
	for _, account := range accounts {
		if ValidateDMAccount(account) != nil {
			return dmAccountDenied
		}
		fingerprint := KeyID(account.Key)
		if seenKey[fingerprint] {
			return dmAccountDenied
		}
		seenKey[fingerprint] = true
		canonical := account.Provider + "/" + fingerprint
		registered[canonical] = accountModelSet(account)
		if len(account.Capabilities) > 0 {
			account.Capabilities = slices.Clone(account.Capabilities)
			exact[canonical] = account
		}
		if account.Provider == "string" && account.Anthropic != "" {
			targets := map[string]string{}
			for _, model := range accountModelSet(account) {
				targets[model] = strings.TrimRight(account.Anthropic, "/") + "/v1/messages"
			}
			messagesRoutes[account.Provider+"/"+fingerprint] = dmMessagesAccount{targets: targets, keyHash: sha256.Sum256([]byte(account.Key))}
		}
		provider := grouped[account.Provider]
		if provider == nil {
			name := "Dream Maker " + account.Provider
			if account.Provider == dmDeepSeekProvider {
				name = "Dream Maker DeepSeek"
			}
			provider = &Provider{ID: account.Provider, Name: name, Chat: account.Chat, Responses: account.Responses, Anthropic: account.Anthropic}
			grouped[account.Provider] = provider
			order = append(order, account.Provider)
		}
		if len(account.Capabilities) == 0 {
			if legacy[account.Provider] && (provider.Chat != account.Chat || provider.Responses != account.Responses || provider.Anthropic != account.Anthropic) {
				return dmAccountDenied
			}
			provider.Chat, provider.Responses, provider.Anthropic = account.Chat, account.Responses, account.Anthropic
			legacy[account.Provider] = true
		}
		if len(models[account.Provider]) == 0 {
			provider.Key = account.Key
		} else {
			provider.Keys = append(provider.Keys, KeyAccount{Key: account.Key})
		}
		for _, model := range accountModelSet(account) {
			known := false
			for _, current := range models[account.Provider] {
				known = known || current == model
			}
			if !known {
				models[account.Provider] = append(models[account.Provider], model)
			}
		}
	}
	var providers []Provider
	for _, id := range order {
		provider := grouped[id]
		provider.Models = models[id]
		providers = append(providers, *provider)
	}
	dmCatalog.Lock()
	defer dmCatalog.Unlock()
	if dmCatalog.active || dmCatalog.legacyUsed {
		return dmAccountDenied
	}
	dmCatalog.explicit = exact
	dmCatalog.accountModels = registered
	dmCatalog.providers = providers
	dmCatalog.messagesRoutes = messagesRoutes
	dmCatalog.active = true
	return nil
}

// ConfigureDreamMakerAPIKeys keeps the original DeepSeek-only call shape.
func ConfigureDreamMakerAPIKeys(keys []string) error {
	accounts := make([]DMAccount, len(keys))
	for i, key := range keys {
		accounts[i] = DMAccount{Provider: dmDeepSeekProvider, Model: "deepseek-flash", Chat: "https://api.deepseek.com/v1", Anthropic: "https://api.deepseek.com/anthropic", Key: key}
	}
	return ConfigureDreamMakerAccounts(accounts)
}

// Every legacy I/O path registers use before doing I/O, so concurrent or late
// setup cannot turn an already-used disk-backed catalog into a managed one.
func dreamMakerProviderFile() (file, bool) {
	dmCatalog.Lock()
	defer dmCatalog.Unlock()
	if !dmCatalog.active {
		dmCatalog.legacyUsed = true
		return file{}, false
	}
	result := file{NoAutoGroups: true}
	for _, p := range dmCatalog.providers {
		result.Providers = append(result.Providers, p.clone())
	}
	return result, true
}

// DreamMakerMessagesTarget exposes only the destination for the exact registered
// account/model pair. Providers may aggregate models across multiple accounts.
func DreamMakerMessagesTarget(account, model string) string {
	dmCatalog.Lock()
	defer dmCatalog.Unlock()
	return dmCatalog.messagesRoutes[account].targets[model]
}

// Confirm the full outgoing credential in addition to the short account identifier.
func DreamMakerMessagesKeyMatches(account, key string) bool {
	dmCatalog.Lock()
	defer dmCatalog.Unlock()
	entry, ok := dmCatalog.messagesRoutes[account]
	return ok && entry.keyHash == sha256.Sum256([]byte(key))
}

type DMCapability struct {
	Model    string `json:"model"`
	Protocol string `json:"protocol"`
	Endpoint string `json:"endpoint"`
}

var explicitProvider = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
var publicName = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
var endpointPath = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+)+$`)

func validateExplicit(a DMAccount) error {
	if !explicitProvider.MatchString(a.Provider) || a.Provider == "unknown" || a.Model != "" || len(a.Models) != 0 || a.Chat != "" || a.Responses != "" || a.Anthropic != "" || len(a.Key) < 8 || len(a.Key) > 512 || len(a.Capabilities) > 64 {
		return dmAccountDenied
	}
	for _, b := range []byte(a.Key) {
		if b < 33 || b > 126 {
			return dmAccountDenied
		}
	}
	seen := map[[2]string]bool{}
	for _, c := range a.Capabilities {
		pair := [2]string{c.Model, c.Protocol}
		if seen[pair] || !dmModelOK(c.Model) || len(c.Endpoint) > 512 {
			return dmAccountDenied
		}
		seen[pair] = true
		u, e := url.Parse(c.Endpoint)
		if e != nil || u.Scheme != "https" || u.User != nil || u.Host != u.Hostname() || len(u.Host) > 253 || net.ParseIP(u.Host) != nil || !publicName.MatchString(u.Host) || strings.HasSuffix(u.Host, ".localhost") || strings.HasSuffix(u.Host, ".local") || strings.HasSuffix(u.Host, ".internal") || !endpointPath.MatchString(u.Path) || c.Endpoint != "https://"+u.Host+u.Path {
			return dmAccountDenied
		}
		for _, s := range strings.Split(u.Path, "/") {
			if s == "." || s == ".." {
				return dmAccountDenied
			}
		}
		suffix := map[string]string{"chat-completions": "/chat/completions", "openai-responses": "/responses", "anthropic-messages": "/messages"}[c.Protocol]
		if suffix == "" || !strings.HasSuffix(u.Path, suffix) {
			return dmAccountDenied
		}
		if a.Provider == dmDeepSeekProvider && !(c.Protocol == "chat-completions" && c.Endpoint == "https://api.deepseek.com/v1/chat/completions" || c.Protocol == "anthropic-messages" && c.Endpoint == "https://api.deepseek.com/anthropic/v1/messages") {
			return dmAccountDenied
		}
	}
	return nil
}

// Resolve only the particular account and native wire supplied by the private controller.
func DMExplicitRoute(account, model, protocol string) (endpoint, key string, explicit bool) {
	dmCatalog.Lock()
	defer dmCatalog.Unlock()
	a, ok := dmCatalog.explicit[account]
	if !ok {
		return "", "", false
	}
	for _, c := range a.Capabilities {
		if c.Model == model && c.Protocol == protocol {
			return c.Endpoint, a.Key, true
		}
	}
	return "", "", true
}
