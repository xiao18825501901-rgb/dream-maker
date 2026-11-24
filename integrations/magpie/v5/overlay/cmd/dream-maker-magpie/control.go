package main

// The inherited owner pipe is the only account/issuer entry; this owns no work
// scheduling, plan approval, model qualification or financial authority.
import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/dmbridge"
	"github.com/yetone/magpie/internal/provider"
)

var controlDenied = errors.New("DM_CREDENTIAL_CONTROL_DENIED")
var controlRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
var controlDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type bootstrapAccount struct {
	Capabilities   []provider.DMCapability `json:"capabilities,omitempty"`
	Provider       string                  `json:"provider"`
	Model          string                  `json:"model,omitempty"`
	Models         []string                `json:"models,omitempty"`
	Authentication string                  `json:"authentication,omitempty"`
	Chat           string                  `json:"chat,omitempty"`
	Responses      string                  `json:"responses,omitempty"`
	Anthropic      string                  `json:"anthropic,omitempty"`
	AuthRef        string                  `json:"authRef"`
	AccountRef     string                  `json:"accountRef"`
	Key            string                  `json:"key"`
}

// subscriptionScope contains only owner-observed references, never CLI credentials.
type subscriptionScope struct {
	ProjectID          string `json:"projectId"`
	FlowID             string `json:"flowId"`
	ConfigurationHash  string `json:"configurationHash"`
	AccountFingerprint string `json:"accountFingerprint"`
	AuthRef            string `json:"authRef"`
	AccountRef         string `json:"accountRef"`
}
type bootstrap struct {
	Subscription *subscriptionScope `json:"subscription,omitempty"`
	Schema       string             `json:"schema"`
	Epoch        string             `json:"epoch"`
	Accounts     []bootstrapAccount `json:"accounts"`
}
type registeredAccount struct {
	Capabilities       []provider.DMCapability `json:"capabilities,omitempty"`
	Provider           string                  `json:"provider"`
	AuthRef            string                  `json:"authRef"`
	AccountRef         string                  `json:"accountRef"`
	UpstreamAccountRef string                  `json:"upstreamAccountRef"`
	Authentication     string                  `json:"authentication"`
	Model              string                  `json:"model"`
	Models             []string                `json:"models,omitempty"`
}
type issuanceReply struct {
	Type          string `json:"type"`
	Schema        string `json:"schema"`
	Epoch         string `json:"epoch"`
	ID            string `json:"id"`
	ReservationID string `json:"reservationId"`
	ControlHash   string `json:"controlHash"`
	Accepted      bool   `json:"accepted"`
	UpstreamKeyID string `json:"upstreamKeyId,omitempty"`
	UpstreamKey   string `json:"upstreamKey,omitempty"`
	ExpiresAtMs   int64  `json:"expiresAtMs,omitempty"`
}
type credentialControl struct {
	subscription      *subscriptionScope
	mu                sync.Mutex
	epoch             string
	accounts          []registeredAccount
	issued            map[string]dmbridge.Admission
	ids, reservations map[string]bool
}

func controlObject(raw []byte, keys ...string) (map[string]json.RawMessage, error) {
	return controlObjectBound(raw, 16384, keys...)
}
func controlObjectBound(raw []byte, limit int, keys ...string) (map[string]json.RawMessage, error) {
	if len(raw) > limit || !utf8.Valid(raw) {
		return nil, controlDenied
	}
	fields, err := dmbridge.RequestFields(raw)
	if err != nil || len(fields) != len(keys) {
		return nil, controlDenied
	}
	for _, key := range keys {
		value, ok := fields[key]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, controlDenied
		}
	}
	return fields, nil
}
func nonemptyControlRef(value string) bool {
	return controlRef.MatchString(value) && !strings.EqualFold(value, "UNKNOWN") && !strings.EqualFold(value, "NOT_VERIFIED")
}

var v3AccountFields = []string{"provider", "model", "authentication", "chat", "responses", "anthropic", "authRef", "accountRef", "key"}
var v3AccountFieldsWithModels = []string{"provider", "model", "models", "authentication", "chat", "responses", "anthropic", "authRef", "accountRef", "key"}

// parseBootstrapAccountV3 keeps every v3 key explicit: the controller names the
// provider, model, wire endpoints and auth mode, and the provider package applies
// the same validation used by direct registration.
func parseBootstrapAccountV3(raw json.RawMessage) (bootstrapAccount, error) {
	fields, err := dmbridge.RequestFields(raw)
	if err != nil || len(raw) > 16384 || !utf8.Valid(raw) {
		return bootstrapAccount{}, controlDenied
	}
	if len(fields) == len(v3AccountFieldsWithModels) {
		if _, err := controlObject(raw, v3AccountFieldsWithModels...); err != nil {
			return bootstrapAccount{}, controlDenied
		}
	} else if _, err := controlObject(raw, v3AccountFields...); err != nil {
		return bootstrapAccount{}, controlDenied
	}
	var a bootstrapAccount
	if json.Unmarshal(raw, &a) != nil || a.Authentication != "api_key" || !nonemptyControlRef(a.AuthRef) || !nonemptyControlRef(a.AccountRef) {
		return bootstrapAccount{}, controlDenied
	}
	if len(fields) == len(v3AccountFieldsWithModels) && len(a.Models) == 0 {
		// A declared model set must say something; an empty list is not the
		// same request as omitting the key.
		return bootstrapAccount{}, controlDenied
	}
	if provider.ValidateDMAccount(provider.DMAccount{Provider: a.Provider, Model: a.Model, Models: a.Models, Chat: a.Chat, Responses: a.Responses, Anthropic: a.Anthropic, Key: a.Key}) != nil {
		return bootstrapAccount{}, controlDenied
	}
	return a, nil
}

const controlV5 = "dream-maker.magpie-control.v5"
const bootstrapLimit = 512 * 1024

func parseV5Account(raw json.RawMessage) (bootstrapAccount, error) {
	fields, e := dmbridge.RequestFields(raw)
	if e != nil {
		return bootstrapAccount{}, controlDenied
	}
	if _, ok := fields["capabilities"]; !ok {
		return parseBootstrapAccountV3(raw)
	}
	if _, e = controlObjectBound(raw, bootstrapLimit, "provider", "authentication", "authRef", "accountRef", "key", "capabilities"); e != nil {
		return bootstrapAccount{}, controlDenied
	}
	var a bootstrapAccount
	var caps []json.RawMessage
	if json.Unmarshal(raw, &a) != nil || a.Authentication != "api_key" || !nonemptyControlRef(a.AuthRef) || !nonemptyControlRef(a.AccountRef) || json.Unmarshal(fields["capabilities"], &caps) != nil || len(caps) < 1 || len(caps) > 64 {
		return bootstrapAccount{}, controlDenied
	}
	for _, c := range caps {
		if _, e = controlObject(c, "model", "protocol", "endpoint"); e != nil {
			return bootstrapAccount{}, controlDenied
		}
	}
	if provider.ValidateDMAccount(provider.DMAccount{Provider: a.Provider, Key: a.Key, Capabilities: a.Capabilities}) != nil {
		return bootstrapAccount{}, controlDenied
	}
	return a, nil
}
func parseBootstrap(raw []byte) (bootstrap, error) {
	fields, err := dmbridge.RequestFields(raw)
	if len(raw) > bootstrapLimit || !utf8.Valid(raw) || err != nil {
		return bootstrap{}, controlDenied
	}
	var schema string
	if json.Unmarshal(fields["schema"], &schema) != nil {
		return bootstrap{}, controlDenied
	}
	limit := 16384
	keys := []string{"schema", "epoch"}
	switch schema {
	case controlV5:
		limit = bootstrapLimit
		keys = append(keys, "accounts")
		if _, ok := fields["subscription"]; ok {
			keys = append(keys, "subscription")
		}
	case "dream-maker.magpie-control.v4":
		keys = append(keys, "accounts", "subscription")
	case "dream-maker.magpie-control.v1":
	case "dream-maker.magpie-control.v2", "dream-maker.magpie-control.v3":
		keys = append(keys, "accounts")
	default:
		return bootstrap{}, controlDenied
	}
	if _, err = controlObjectBound(raw, limit, keys...); err != nil {
		return bootstrap{}, controlDenied
	}
	var b bootstrap
	if json.Unmarshal(raw, &b) != nil || !nonemptyControlRef(b.Epoch) {
		return bootstrap{}, controlDenied
	}
	if schema == "dream-maker.magpie-control.v4" || schema == controlV5 && fields["subscription"] != nil {
		if _, err := controlObject(fields["subscription"], "projectId", "flowId", "configurationHash", "accountFingerprint", "authRef", "accountRef"); err != nil {
			return bootstrap{}, controlDenied
		}
		sub := b.Subscription
		if sub == nil || !nonemptyControlRef(sub.ProjectID) || !nonemptyControlRef(sub.FlowID) || !nonemptyControlRef(sub.AuthRef) || !nonemptyControlRef(sub.AccountRef) || !controlDigest.MatchString(sub.ConfigurationHash) || !controlDigest.MatchString(sub.AccountFingerprint) {
			return bootstrap{}, controlDenied
		}
	}
	if schema == "dream-maker.magpie-control.v1" {
		return b, nil
	}
	var accounts []json.RawMessage
	if json.Unmarshal(fields["accounts"], &accounts) != nil || accounts == nil || len(accounts) > 8 {
		return bootstrap{}, controlDenied
	}
	b.Accounts = make([]bootstrapAccount, 0, len(accounts))
	refs, aliases, keysSeen, ids := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	if sub := b.Subscription; sub != nil {
		refs[sub.AuthRef], aliases[sub.AccountRef] = true, true
	}
	for _, rawAccount := range accounts {
		var a bootstrapAccount
		if schema == controlV5 {
			a, err = parseV5Account(rawAccount)
			if err != nil {
				return bootstrap{}, controlDenied
			}
		} else if schema == "dream-maker.magpie-control.v3" || schema == "dream-maker.magpie-control.v4" {
			a, err = parseBootstrapAccountV3(rawAccount)
			if err != nil {
				return bootstrap{}, controlDenied
			}
		} else {
			if _, err = controlObject(rawAccount, "provider", "authRef", "accountRef", "key"); err != nil {
				return bootstrap{}, controlDenied
			}
			if json.Unmarshal(rawAccount, &a) != nil || a.Provider != "deepseek-official" || !nonemptyControlRef(a.AuthRef) || !nonemptyControlRef(a.AccountRef) || len(a.Key) < 8 || len(a.Key) > 512 {
				return bootstrap{}, controlDenied
			}
			a.Model, a.Authentication, a.Chat, a.Anthropic = "deepseek-flash", "api_key", "https://api.deepseek.com/v1", "https://api.deepseek.com/anthropic"
		}
		for _, ch := range []byte(a.Key) {
			if ch < 0x21 || ch > 0x7e {
				return bootstrap{}, controlDenied
			}
		}
		id := provider.KeyID(a.Key)
		if refs[a.AuthRef] || aliases[a.AccountRef] || keysSeen[a.Key] || ids[id] {
			return bootstrap{}, controlDenied
		}
		refs[a.AuthRef], aliases[a.AccountRef], keysSeen[a.Key], ids[id] = true, true, true, true
		b.Accounts = append(b.Accounts, a)
	}
	return b, nil
}
func configureCredentials(b bootstrap) (*credentialControl, error) {
	accounts := make([]provider.DMAccount, len(b.Accounts))
	for i, a := range b.Accounts {
		accounts[i] = provider.DMAccount{Capabilities: a.Capabilities, Provider: a.Provider, Model: a.Model, Models: a.Models, Chat: a.Chat, Responses: a.Responses, Anthropic: a.Anthropic, Key: a.Key}
	}
	defer func() {
		for i := range accounts {
			accounts[i].Key = ""
		}
	}()
	if provider.ConfigureDreamMakerAccounts(accounts) != nil || access.ConfigureDreamMakerKeyStore() != nil {
		return nil, controlDenied
	}
	c := &credentialControl{subscription: b.Subscription, epoch: b.Epoch, accounts: make([]registeredAccount, 0, len(b.Accounts)), issued: map[string]dmbridge.Admission{}, ids: map[string]bool{}, reservations: map[string]bool{}}
	for _, a := range b.Accounts {
		canonical, err := provider.ResolveAccount(a.Provider, provider.KeyID(a.Key))
		if err != nil {
			return nil, controlDenied
		}
		if len(a.Capabilities) > 0 {
			a.Model = a.Capabilities[0].Model
		}
		c.accounts = append(c.accounts, registeredAccount{Capabilities: a.Capabilities, Provider: a.Provider, AuthRef: a.AuthRef, AccountRef: a.AccountRef, UpstreamAccountRef: canonical, Authentication: a.Authentication, Model: a.Model, Models: a.Models})
	}
	if sub := b.Subscription; sub != nil {
		c.accounts = append(c.accounts, registeredAccount{Provider: "openai", Authentication: "oauth", Model: "gpt-6-luna", AuthRef: sub.AuthRef, AccountRef: sub.AccountRef, UpstreamAccountRef: "openai/" + sub.AccountFingerprint})
	}
	return c, nil
}
func (c *credentialControl) Accounts() []registeredAccount {
	out := make([]registeredAccount, len(c.accounts))
	copy(out, c.accounts)
	return out
}

func controlCommand(raw []byte) (string, error) {
	if len(raw) > 16384 || !utf8.Valid(raw) {
		return "", controlDenied
	}
	fields, err := dmbridge.RequestFields(raw)
	if err != nil {
		return "", controlDenied
	}
	var kind string
	if json.Unmarshal(fields["type"], &kind) != nil {
		return "", controlDenied
	}
	keys := []string{"type"}
	switch kind {
	case "issue":
		keys = append(keys, "request")
	case "grant":
		keys = append(keys, "admission")
	case "stop":
	default:
		return "", controlDenied
	}
	if _, err = controlObject(raw, keys...); err != nil {
		return "", controlDenied
	}
	if kind == "grant" {
		grantFields := append([]string{"upstreamKeyId", "upstreamKey"}, issueFields...)
		if _, err = admissionObject(fields["admission"], grantFields); err != nil {
			return "", controlDenied
		}
	}
	return kind, nil
}

var issueFields = []string{"token", "id", "epoch", "projectId", "flowId", "configurationHash", "bindingHash", "routeHash", "roleId", "role", "reservationId", "runtime", "provider", "protocol", "model", "authentication", "accountRef", "authRef", "upstreamAccountRef", "method", "path", "bodyHash", "expiresAtMs", "maxInputTokens", "maxOutputTokens"}

func admissionObject(raw json.RawMessage, keys []string) (map[string]json.RawMessage, error) {
	fields, err := dmbridge.RequestFields(raw)
	if err != nil {
		return nil, controlDenied
	}
	if _, ok := fields["subscriptionRequestHash"]; ok {
		keys = append(append([]string{}, keys...), "subscriptionRequestHash")
	}
	return controlObject(raw, keys...)
}

func issueDraft(raw []byte) (dmbridge.Admission, error) {
	if kind, err := controlCommand(raw); err != nil || kind != "issue" {
		return dmbridge.Admission{}, controlDenied
	}
	fields, _ := dmbridge.RequestFields(raw)
	if _, err := admissionObject(fields["request"], issueFields); err != nil {
		return dmbridge.Admission{}, controlDenied
	}
	var a dmbridge.Admission
	if json.Unmarshal(fields["request"], &a) != nil || !nonemptyControlRef(a.ID) || !nonemptyControlRef(a.ReservationID) {
		return dmbridge.Admission{}, controlDenied
	}
	return a, nil
}
func (c *credentialControl) allowed(a dmbridge.Admission) bool {
	subscription := a.Path == "/backend-api/codex/responses"
	if subscription {
		sub := c.subscription
		if sub == nil || a.ProjectID != sub.ProjectID || a.FlowID != sub.FlowID || a.ConfigurationHash != sub.ConfigurationHash || a.AccountRef != sub.AccountRef || a.AuthRef != sub.AuthRef || a.UpstreamAccountRef != "openai/"+sub.AccountFingerprint || a.Runtime != "codex" || a.Role != "planner2" || a.Provider != "openai" || a.Authentication != "oauth" || a.Model != "gpt-6-luna" || a.Protocol != "openai-responses" || !controlDigest.MatchString(a.SubscriptionRequestHash) {
			return false
		}
	} else if a.SubscriptionRequestHash != "" || a.Authentication != "api_key" {
		return false
	}
	if a.Epoch != c.epoch || a.Method != "POST" || !(subscription || a.Protocol == "chat-completions" && a.Path == "/v1/chat/completions" || a.Protocol == "anthropic-messages" && a.Path == "/v1/messages" || a.Protocol == "openai-responses" && a.Path == "/v1/responses") {
		return false
	}
	for _, value := range []string{a.Token, a.ConfigurationHash, a.BindingHash, a.RouteHash, a.BodyHash} {
		if !controlDigest.MatchString(value) {
			return false
		}
	}
	for _, value := range []string{a.ID, a.ProjectID, a.FlowID, a.RoleID, a.ReservationID, a.Runtime, a.AccountRef, a.AuthRef} {
		if !nonemptyControlRef(value) {
			return false
		}
	}
	if a.Role == "planner2" || a.Role == "reviewer" {
		if a.RoleID != a.Role {
			return false
		}
	} else if a.Role != "executor" || a.RoleID == "planner2" || a.RoleID == "reviewer" {
		return false
	}
	remaining := a.ExpiresAtMs - time.Now().UnixMilli()
	if remaining <= 0 || remaining > 120000 || a.MaxInputTokens < 1048576 || a.MaxInputTokens >= 2097152 || a.MaxOutputTokens < 1 || a.MaxOutputTokens > 2097152-a.MaxInputTokens {
		return false
	}
	route, err := dmbridge.AdmissionRouteHash(a)
	if err != nil || route != a.RouteHash {
		return false
	}
	for _, account := range c.accounts {
		if a.Provider == account.Provider && accountAllowsRoute(account, a) && a.Authentication == account.Authentication && a.AuthRef == account.AuthRef && a.AccountRef == account.AccountRef && a.UpstreamAccountRef == account.UpstreamAccountRef {
			return true
		}
	}
	return false
}

// accountAllowsModel keeps the single-model wire shape working while letting one
// provider credential serve the distinct models the owner rule needs.
func accountAllowsRoute(account registeredAccount, a dmbridge.Admission) bool {
	if len(account.Capabilities) == 0 {
		return accountAllowsModel(account, a.Model)
	}
	if !dmbridge.ExplicitRouteAllowed(a) {
		return false
	}
	for _, c := range account.Capabilities {
		if c.Model == a.Model && c.Protocol == a.Protocol {
			return true
		}
	}
	return false
}
func accountAllowsModel(account registeredAccount, model string) bool {
	if account.Model == model {
		return true
	}
	for _, allowed := range account.Models {
		if allowed == model {
			return true
		}
	}
	return false
}
func (c *credentialControl) IssueFrame(raw []byte) (issuanceReply, error) {
	a, err := issueDraft(raw)
	if err != nil {
		return issuanceReply{}, controlDenied
	}
	sum := sha256.Sum256(raw)
	reply := issuanceReply{Type: "issued", Schema: "dream-maker.magpie-issued-key.v1", Epoch: c.epoch, ID: a.ID, ReservationID: a.ReservationID, ControlHash: hex.EncodeToString(sum[:])}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.allowed(a) || c.ids[a.ID] || c.reservations[a.ReservationID] || len(c.ids) >= 4096 {
		return reply, nil
	}
	c.ids[a.ID], c.reservations[a.ReservationID] = true, true
	for id, prior := range c.issued {
		if prior.ExpiresAtMs <= time.Now().UnixMilli() {
			if prior.SubscriptionRequestHash == "" {
				_ = access.RevokeIssued(id, "")
			}
			delete(c.issued, id)
		}
	}
	if a.SubscriptionRequestHash != "" {
		// Local capability lives only in the owner process and cannot authenticate to OpenAI.
		var nonce [32]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return reply, nil
		}
		publicID := sha256.Sum256(nonce[:])
		a.UpstreamKeyID = "subscription_" + hex.EncodeToString(publicID[:16])
		a.UpstreamKey = hex.EncodeToString(nonce[:])
		c.issued[a.UpstreamKeyID] = a
		reply.Accepted, reply.UpstreamKeyID, reply.UpstreamKey, reply.ExpiresAtMs = true, a.UpstreamKeyID, a.UpstreamKey, a.ExpiresAtMs
		return reply, nil
	}
	name := a.ID
	if len(name) > 64 {
		name = name[:64]
	}
	key, err := access.IssueKey(access.Issue{Name: "Dream Maker " + name, TTL: 2 * time.Minute, Models: []string{a.Provider + "/" + a.Model}, Accounts: []string{a.UpstreamAccountRef}, Tokens: a.MaxInputTokens + a.MaxOutputTokens})
	if err != nil {
		return reply, nil
	}
	a.UpstreamKeyID, a.UpstreamKey = key.ID, key.Key
	if key.Expires.UnixMilli() < a.ExpiresAtMs || authorize(a) != nil {
		_ = access.RevokeIssued(key.ID, "")
		return reply, nil
	}
	c.issued[key.ID] = a
	reply.Accepted = true
	reply.UpstreamKeyID = key.ID
	reply.UpstreamKey = key.Key
	reply.ExpiresAtMs = key.Expires.UnixMilli()
	return reply, nil
}
func (c *credentialControl) Authorize(a dmbridge.Admission) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	prior, ok := c.issued[a.UpstreamKeyID]
	if !ok || prior != a {
		return controlDenied
	}
	if a.SubscriptionRequestHash != "" {
		if !c.allowed(a) {
			return controlDenied
		}
		return nil
	}
	return authorize(a)
}
