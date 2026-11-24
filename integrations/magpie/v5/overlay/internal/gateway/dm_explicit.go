package gateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/budget"
	"github.com/yetone/magpie/internal/dmbridge"
	"github.com/yetone/magpie/internal/gwbudget"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/usage"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const explicitBodyLimit = 2 << 20
const explicitReplyLimit = 4 << 20

func dmExplicitBody(a dmbridge.Admission, raw []byte, model string) error {
	if !dmbridge.ExplicitRouteAllowed(a) || len(raw) > explicitBodyLimit || int64(len(raw)) > a.MaxInputTokens || !utf8.Valid(raw) {
		return dmTargetDenied
	}
	fields, err := dmbridge.RequestFields(raw)
	var actual string
	if err != nil || json.Unmarshal(fields["model"], &actual) != nil || actual != model {
		return dmTargetDenied
	}
	switch a.Protocol {
	case "openai-responses":
		if len(raw) > 262144 {
			return dmTargetDenied
		}
		return dmCodexTextBody(a, raw, model)
	case "anthropic-messages":
		if a.Runtime == "claude" {
			return dmClaudeBody(a, raw, model)
		}
	}
	return dmFinalBudget(a, fields)
}
func dmExplicitHeaders(protocol, key string) http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")
	h.Set("Accept", "application/json, text/event-stream")
	if protocol == "openai-responses" {
		h.Set("Accept", "text/event-stream")
	}
	if protocol == "anthropic-messages" {
		h.Set("Anthropic-Version", "2023-06-01")
		h.Set("X-Api-Key", key)
	} else {
		h.Set("Authorization", "Bearer "+key)
	}
	return h
}
func dmExplicitPhysical(a dmbridge.Admission, r *http.Request, endpoint, key string) error {
	if endpoint == "" || key == "" || r == nil || r.URL == nil || r.Body == nil || r.Method != "POST" || r.RequestURI != "" || r.URL.String() != endpoint || r.Host != "" && r.Host != r.URL.Host {
		return dmTargetDenied
	}
	expected := dmExplicitHeaders(a.Protocol, key)
	if len(r.Header) != len(expected) {
		return dmTargetDenied
	}
	for k, v := range r.Header {
		if len(v) != 1 || expected[k] == nil || v[0] != expected[k][0] {
			return dmTargetDenied
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, explicitBodyLimit+1))
	r.Body.Close()
	if err != nil || dmExplicitBody(a, body, a.Model) != nil {
		return dmTargetDenied
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.GetBody = nil
	return nil
}

// The generic router groups base URLs by provider. Explicit accounts require
// a physical address selected by account, model and native wire together.
func (s *Server) DreamMakerHandler() http.Handler {
	legacy := s.Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, ok := dmbridge.PhysicalAdmission(r.Context())
		if !ok {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		endpoint, key, explicit := provider.DMExplicitRoute(a.UpstreamAccountRef, a.Model, a.Protocol)
		if !explicit {
			legacy.ServeHTTP(w, r)
			return
		}
		if endpoint == "" || s.dmSendExplicit(w, r, a, endpoint, key) != nil {
			w.WriteHeader(http.StatusBadGateway)
		}
	})
}
func (s *Server) dmSendExplicit(w http.ResponseWriter, r *http.Request, a dmbridge.Admission, endpoint, key string) error {
	who, err := access.Check(a.UpstreamKey)
	if err != nil || who.KeyID != a.UpstreamKeyID || !dmbridge.AccountScopeMatches(a, who.Accounts) || !who.Limited() || len(who.Models) != 1 || who.Models[0] != a.Provider+"/"+a.Model {
		return dmTargetDenied
	}
	limiter, err := gwbudget.Limiting(who)
	if err != nil || limiter == nil {
		return dmTargetDenied
	}
	release, refused := limiter.Reserve(who, r.ContentLength, who.Models[0], time.Now())
	if refused != nil {
		return dmTargetDenied
	}
	defer release()
	raw, err := io.ReadAll(io.LimitReader(r.Body, explicitBodyLimit+1))
	if err != nil || dmExplicitBody(a, raw, who.Models[0]) != nil {
		return dmTargetDenied
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != a.BodyHash {
		return dmTargetDenied
	}
	fields, _ := dmbridge.RequestFields(raw)
	fields["model"], _ = json.Marshal(a.Model)
	body, err := json.Marshal(fields)
	if err != nil {
		return dmTargetDenied
	}
	up, err := http.NewRequestWithContext(r.Context(), "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return dmTargetDenied
	}
	up.Header = dmExplicitHeaders(a.Protocol, key)
	up.GetBody = nil
	attempt := usage.Record{Time: time.Now(), Agent: a.Runtime, Provider: a.Provider, ProviderKeyID: provider.KeyID(key), CallerKeyID: who.KeyID, Model: a.Model, Requested: who.Models[0], Endpoint: a.Path, Status: http.StatusBadGateway, CacheUnknown: true}
	if who.Issuer != nil {
		attempt.CallerIssuerID = who.Issuer.KeyID
	}
	defer func() { attempt.Millis = time.Since(attempt.Time).Milliseconds(); budget.Append(attempt) }()
	response, err := s.client.Do(up)
	if err != nil {
		return dmTargetDenied
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return dmTargetDenied
	}
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	expected := "application/json"
	if string(fields["stream"]) == "true" {
		expected = "text/event-stream"
	}
	if err != nil || media != expected {
		return dmTargetDenied
	}
	reply, err := io.ReadAll(io.LimitReader(response.Body, explicitReplyLimit+1))
	if err != nil || len(reply) == 0 || len(reply) > explicitReplyLimit || !utf8.Valid(reply) || dmReplyContainsSecret(reply, media, key, a.UpstreamKey) {
		return dmTargetDenied
	}
	protocol := map[string]provider.Protocol{"chat-completions": provider.Chat, "anthropic-messages": provider.Anthropic, "openai-responses": provider.Responses}[a.Protocol]
	sniffer := newSniffer(protocol, media)
	sniffer.write(reply)
	sniffer.settleWhole()
	u := sniffer.usage().billed()
	if sniffer.failed != "" || u.Served != a.Model || !dmResponseID.MatchString(u.ResponseID) || media == "text/event-stream" && !sniffer.whole() {
		return dmTargetDenied
	}
	attempt.Served = u.Served
	attempt.Input = u.Input
	attempt.Output = u.Output
	attempt.CacheRead = u.CacheRead
	attempt.CacheWrite = u.CacheWrite
	attempt.CacheUnknown = u.cacheNotCounted()
	attempt.Reasoning = u.Reasoning
	maxField := "max_tokens"
	if a.Protocol == "openai-responses" {
		maxField = "max_output_tokens"
	}
	var maximum int64
	if json.Unmarshal(fields[maxField], &maximum) != nil || u.Input < 0 || u.CacheRead < 0 || u.CacheWrite < 0 || u.Output < 0 || int64(u.Input) > a.MaxInputTokens || int64(u.CacheRead) > a.MaxInputTokens-int64(u.Input) || int64(u.CacheWrite) > a.MaxInputTokens-int64(u.Input)-int64(u.CacheRead) || int64(u.Output) > maximum {
		return dmTargetDenied
	}
	if a.Protocol == "openai-responses" {
		reply, err = dmResponsesTranscript(reply, a, maximum)
		if err != nil {
			return err
		}
	}
	if r.Context().Err() != nil {
		return dmTargetDenied
	}
	attempt.Status = http.StatusOK
	w.Header().Set("Content-Type", media)
	w.Header().Set("Cache-Control", "no-store")
	_, err = w.Write(reply)
	return err
}
func dmReplyContainsSecret(reply []byte, media string, secrets ...string) bool {
	for _, s := range secrets {
		if bytes.Contains(reply, []byte(s)) {
			return true
		}
	}
	check := func(data []byte) bool {
		return !dmReplyJSON(data, secrets)
	}
	if media == "application/json" {
		return check(reply)
	}
	for _, line := range bytes.Split(reply, []byte("\n")) {
		if data, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			data = bytes.TrimSpace(data)
			if !bytes.Equal(data, []byte("[DONE]")) && check(data) {
				return true
			}
		}
	}
	return false
}

// Inspect every JSON string after decoding escapes. Reject duplicate members even
// inside nested usage, output and content objects before typed decoding.
func dmReplyJSON(data []byte, secrets []string) bool {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) bool
	clean := func(text string) bool {
		for _, s := range secrets {
			if strings.Contains(text, s) {
				return false
			}
		}
		return true
	}
	value = func(depth int) bool {
		if depth > 64 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		switch v := token.(type) {
		case string:
			return clean(v)
		case json.Delim:
			switch v {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					key, e := d.Token()
					name, ok := key.(string)
					if e != nil || !ok || seen[strings.ToLower(name)] || !clean(name) {
						return false
					}
					seen[strings.ToLower(name)] = true
					if !value(depth + 1) {
						return false
					}
				}
				end, e := d.Token()
				return e == nil && end == json.Delim('}')
			case '[':
				for d.More() {
					if !value(depth + 1) {
						return false
					}
				}
				end, e := d.Token()
				return e == nil && end == json.Delim(']')
			default:
				return false
			}
		}
		return true
	}
	if !value(0) {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}
