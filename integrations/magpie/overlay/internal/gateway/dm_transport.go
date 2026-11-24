// DM-only additive transport. No changes to the user's installed Magpie or its clients.
package gateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/dmbridge"
	"github.com/yetone/magpie/internal/provider"
)

var dmTargetDenied = errors.New("DM_MAGPIE_UPSTREAM_TARGET_NOT_APPROVED")
var dmProxySettingsDenied = errors.New("DM_MAGPIE_PROXY_CONFIGURATION_DENIED")

func dmDeepSeekFlashRoute(a dmbridge.Admission) bool {
	return a.Authentication == "api_key" && a.Provider == "deepseek-official" && a.Model == "deepseek-flash" &&
		(a.Protocol == "chat-completions" && a.Path == "/v1/chat/completions" ||
			a.Protocol == "anthropic-messages" && a.Path == "/v1/messages")
}

// V4 Pro uses the approved Reviewer chat path. CLI Reviewers additionally require
// text-only no-tool bodies at both ingress and the final physical target.
func dmDeepSeekReviewerPro(a dmbridge.Admission) bool {
	return a.Authentication == "api_key" && a.Provider == "deepseek-official" &&
		(a.Runtime == "independent" || dmCLIReviewer(a)) && a.Role == "reviewer" && a.Model == "deepseek-v4-pro" &&
		a.Protocol == "chat-completions" && a.Path == "/v1/chat/completions"
}

func dmCLIReviewer(a dmbridge.Admission) bool {
	return (a.Runtime == "opencode" || a.Runtime == "cline") && a.Role == "reviewer" && a.RoleID == "reviewer" && a.Model == "deepseek-v4-pro"
}

func dmDeepSeekTextRoute(a dmbridge.Admission) bool {
	return dmDeepSeekFlashRoute(a) || dmDeepSeekReviewerPro(a)
}

// Run before the original handler can preprocess attachments, route requests or
// use any auxiliary client. This initial route supports only bounded text APIs.
func CheckDreamMakerIngress(a dmbridge.Admission, body []byte) error {
	if a.Path == "/backend-api/codex/responses" {
		return dmCodexPlannerBody(a, body)
	}
	if dmClaudeReview(a) {
		if provider.DreamMakerMessagesTarget(a.UpstreamAccountRef, a.Model) == "" {
			return dmTargetDenied
		}
		return dmClaudeBody(a, body, a.Provider+"/"+a.Model)
	}
	if !dmDeepSeekTextRoute(a) {
		return dmTargetDenied
	}
	fields, err := dmbridge.RequestFields(body)
	var model string
	if err != nil || json.Unmarshal(fields["model"], &model) != nil || model != a.Provider+"/"+a.Model {
		return dmTargetDenied
	}
	return dmFinalBudget(a, fields)
}

func dmObject(raw json.RawMessage, allowed ...string) (map[string]json.RawMessage, error) {
	fields, err := dmbridge.RequestFields(raw)
	if err != nil {
		return nil, dmTargetDenied
	}
	for key := range fields {
		if !slices.Contains(allowed, key) {
			return nil, dmTargetDenied
		}
	}
	return fields, nil
}

// This initial text route reserves the same full context as NativeOwner.quote.
// It does not estimate tokens from character counts or qualify a provider price.
func dmFinalBudget(a dmbridge.Admission, fields map[string]json.RawMessage) error {
	if dmCLIReviewer(a) {
		for _, key := range []string{"tools", "tool_choice", "parallel_tool_calls", "system"} {
			if _, ok := fields[key]; ok {
				return dmTargetDenied
			}
		}
		var messages []json.RawMessage
		if json.Unmarshal(fields["messages"], &messages) != nil || len(messages) == 0 {
			return dmTargetDenied
		}
		for _, raw := range messages {
			m, err := dmObject(raw, "role", "content")
			var role string
			if err != nil || json.Unmarshal(m["role"], &role) != nil || !slices.Contains([]string{"user", "assistant", "system", "developer"}, role) || len(m["content"]) == 0 || m["content"][0] != '"' {
				return dmTargetDenied
			}
		}
	}
	if a.MaxInputTokens < 1048576 || a.MaxOutputTokens < 1 {
		return dmTargetDenied
	}
	var maximum int64
	if json.Unmarshal(fields["max_tokens"], &maximum) != nil || maximum < 1 || maximum > a.MaxOutputTokens {
		return dmTargetDenied
	}
	for key := range fields {
		switch key {
		case "model", "messages", "max_tokens", "stream", "stream_options", "temperature", "top_p", "stop", "stop_sequences", "tools", "tool_choice", "parallel_tool_calls", "thinking", "reasoning_effort", "response_format", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs", "system":
		case "n":
			var n int
			if json.Unmarshal(fields[key], &n) != nil || n != 1 {
				return dmTargetDenied
			}
		default:
			return dmTargetDenied // includes all alternative limits, media, service tiers and extra_body
		}
	}
	var messages []json.RawMessage
	if json.Unmarshal(fields["messages"], &messages) != nil || messages == nil {
		return dmTargetDenied
	}
	for _, raw := range messages {
		m, err := dmObject(raw, "role", "content", "tool_calls", "tool_call_id", "name", "reasoning_content", "reasoning", "reasoning_details", "prefix")
		if err != nil {
			return dmTargetDenied
		}
		var role string
		if json.Unmarshal(m["role"], &role) != nil || !slices.Contains([]string{"system", "developer", "user", "assistant", "tool"}, role) {
			return dmTargetDenied
		}
		if !dmTextContent(m["content"], 0) {
			return dmTargetDenied
		}
	}
	if system := fields["system"]; system != nil && !dmTextContent(system, 0) {
		return dmTargetDenied
	}
	if tools := fields["tools"]; tools != nil {
		var declarations []json.RawMessage
		if json.Unmarshal(tools, &declarations) != nil {
			return dmTargetDenied
		}
		for _, raw := range declarations {
			tool, err := dmbridge.RequestFields(raw)
			if err != nil {
				return dmTargetDenied
			}
			var kind string
			if value := tool["type"]; value != nil && json.Unmarshal(value, &kind) != nil {
				return dmTargetDenied
			}
			if kind == "function" {
				if _, err = dmObject(raw, "type", "function", "cache_control"); err != nil {
					return dmTargetDenied
				}
				if _, err = dmObject(tool["function"], "name", "description", "parameters", "strict"); err != nil {
					return dmTargetDenied
				}
			} else if kind == "" && tool["type"] == nil {
				if _, err = dmObject(raw, "name", "description", "input_schema", "cache_control"); err != nil {
					return dmTargetDenied
				}
				var name string
				if json.Unmarshal(tool["name"], &name) != nil || name == "" {
					return dmTargetDenied
				}
			} else {
				return dmTargetDenied
			}
		}
	}
	return nil
}
func dmTextContent(raw json.RawMessage, depth int) bool {
	if depth > 8 {
		return false
	}
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return true
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return true
	}
	var blocks []json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil || blocks == nil {
		return false
	}
	for _, rawBlock := range blocks {
		block, err := dmbridge.RequestFields(rawBlock)
		if err != nil {
			return false
		}
		var kind string
		if json.Unmarshal(block["type"], &kind) != nil {
			return false
		}
		var allowed []string
		switch kind {
		case "text":
			allowed = []string{"type", "text", "cache_control"}
		case "thinking":
			allowed = []string{"type", "thinking", "signature", "cache_control"}
		case "redacted_thinking":
			allowed = []string{"type", "data", "cache_control"}
		case "tool_use":
			allowed = []string{"type", "id", "name", "input", "cache_control"}
		case "tool_result":
			allowed = []string{"type", "tool_use_id", "content", "is_error", "cache_control"}
			if !dmTextContent(block["content"], depth+1) {
				return false
			}
		default:
			return false
		}
		if _, err = dmObject(rawBlock, allowed...); err != nil {
			return false
		}
	}
	return true
}

// Initial official API slice only; other providers/OAuth stay closed until explicitly integrated.
func dmPhysicalTarget(a dmbridge.Admission, r *http.Request) error {
	if a.Path == "/backend-api/codex/responses" {
		if r == nil || r.Method != "POST" || r.URL == nil || r.URL.String() != codexResponsesURL || r.RequestURI != "" || (r.Host != "" && r.Host != "chatgpt.com") || r.Body == nil || a.SubscriptionRequestHash == "" || len(r.Header.Values("Accept")) != 1 || r.Header.Get("Accept") != "text/event-stream" || dmbridge.CodexCredentialBinding(r.Header) != a.SubscriptionRequestHash {
			return dmTargetDenied
		}
		for name := range r.Header {
			switch http.CanonicalHeaderKey(name) {
			case "Authorization", "Chatgpt-Account-Id", "Content-Type", "Accept":
			default:
				return dmTargetDenied
			}
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 262145))
		r.Body.Close()
		if err != nil || dmCodexPlannerBody(a, data) != nil {
			return dmTargetDenied
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
		r.ContentLength = int64(len(data))
		r.GetBody = nil
		return nil
	}
	if dmClaudeReview(a) {
		target := provider.DreamMakerMessagesTarget(a.UpstreamAccountRef, a.Model)
		if target == "" || r == nil || r.URL == nil || r.Method != "POST" || r.URL.Scheme != "https" || r.URL.String() != target || r.URL.User != nil || r.URL.Opaque != "" || r.URL.RawPath != "" || r.URL.ForceQuery || r.URL.RawQuery != "" || r.URL.Fragment != "" || r.RequestURI != "" || (r.Host != "" && r.Host != r.URL.Host) || r.Body == nil {
			return dmTargetDenied
		}
		var key string
		for name, values := range r.Header {
			switch strings.ToLower(name) {
			case "authorization", "x-api-key":
				if name != http.CanonicalHeaderKey(name) || len(values) != 1 {
					return dmTargetDenied
				}
				value := values[0]
				if strings.EqualFold(name, "Authorization") {
					var ok bool
					value, ok = strings.CutPrefix(value, "Bearer ")
					if !ok {
						return dmTargetDenied
					}
				}
				if value == "" || (key != "" && key != value) {
					return dmTargetDenied
				}
				key = value
			case "cookie", "proxy-authorization", "chatgpt-account-id", "x-dm-gateway":
				return dmTargetDenied
			}
		}
		if key == "" || !provider.DreamMakerMessagesKeyMatches(a.UpstreamAccountRef, key) {
			return dmTargetDenied
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 262145))
		r.Body.Close()
		if err != nil || dmClaudeBody(a, data, a.Model) != nil {
			return dmTargetDenied
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
		r.ContentLength = int64(len(data))
		r.GetBody = nil
		return nil
	}
	if !dmDeepSeekTextRoute(a) || r.Method != "POST" || r.URL == nil || r.URL.Scheme != "https" || r.URL.Host != "api.deepseek.com" || r.URL.User != nil || r.URL.RawQuery != "" || r.URL.RawPath != "" || r.URL.Fragment != "" || r.URL.RawFragment != "" || r.URL.Opaque != "" || r.URL.ForceQuery || r.URL.OmitHost || r.RequestURI != "" || r.Host != "" && r.Host != r.URL.Host {
		return dmTargetDenied
	}
	for name := range r.Header {
		if (strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "X-Api-Key")) && name != http.CanonicalHeaderKey(name) {
			return dmTargetDenied
		}
	}
	if dmCLIReviewer(a) && r.URL.Path != "/chat/completions" && r.URL.Path != "/v1/chat/completions" {
		return dmTargetDenied
	}
	switch r.URL.Path {
	case "/chat/completions", "/v1/chat/completions", "/anthropic/v1/messages":
	default:
		return dmTargetDenied
	}
	key := ""
	authorization, apiKey := r.Header.Values("Authorization"), r.Header.Values("X-Api-Key")
	switch {
	case len(authorization) == 1 && len(apiKey) == 0:
		if !strings.HasPrefix(authorization[0], "Bearer ") {
			return dmTargetDenied
		}
		key = strings.TrimPrefix(authorization[0], "Bearer ")
	case len(authorization) == 0 && len(apiKey) == 1:
		key = apiKey[0]
	case r.URL.Path == "/anthropic/v1/messages" && len(authorization) == 1 && len(apiKey) == 1 &&
		strings.HasPrefix(authorization[0], "Bearer "):
		key = strings.TrimPrefix(authorization[0], "Bearer ")
		if apiKey[0] != key {
			return dmTargetDenied
		}
	default:
		return dmTargetDenied
	}
	if key == "" {
		return dmTargetDenied
	}
	sum := sha256.Sum256([]byte(key))
	if a.UpstreamAccountRef != "deepseek-official/"+hex.EncodeToString(sum[:5]) {
		return dmTargetDenied
	}
	if r.Body == nil {
		return dmTargetDenied
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024+1))
	_ = r.Body.Close()
	if err != nil || len(body) > 2*1024*1024 {
		return dmTargetDenied
	}
	parsed, parseError := dmbridge.RequestFields(body)
	var model string
	if parseError != nil || json.Unmarshal(parsed["model"], &model) != nil || model != a.Model || dmFinalBudget(a, parsed) != nil {
		return dmTargetDenied
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.GetBody = nil
	return nil
}

// The owned child receives the same loopback CFW variables as the Node role
// transport. A configured but malformed or ambiguous proxy fails before dialing;
// it never falls back to a direct provider connection.
func dmProxyEnvironmentURL() (*url.URL, error) {
	return dmProxyURL([]string{
		os.Getenv("HTTPS_PROXY"),
		os.Getenv("https_proxy"),
		os.Getenv("ALL_PROXY"),
		os.Getenv("all_proxy"),
	})
}

func dmProxyURL(values []string) (*url.URL, error) {
	selected := ""
	for _, raw := range values {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if selected != "" && raw != selected {
			return nil, dmProxySettingsDenied
		}
		selected = raw
	}
	if selected == "" {
		return nil, nil
	}
	proxy, err := url.Parse(selected)
	if err != nil || proxy.Scheme != "http" || proxy.Hostname() != "127.0.0.1" || proxy.Port() == "" || proxy.User != nil ||
		proxy.RawQuery != "" || proxy.Fragment != "" || proxy.RawFragment != "" || (proxy.Path != "" && proxy.Path != "/") {
		return nil, dmProxySettingsDenied
	}
	return proxy, nil
}

func newDreamMakerTransport() *http.Transport {
	proxy, proxyError := dmProxyEnvironmentURL()
	return &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) {
			if proxyError != nil {
				return nil, proxyError
			}
			if proxy == nil {
				return nil, nil
			}
			copy := *proxy
			return &copy, nil
		},
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: -1}).DialContext,
		DisableKeepAlives:     true,
		ForceAttemptHTTP2:     false,
		ResponseHeaderTimeout: 120 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
	}
}

func newDreamMakerClient(next http.RoundTripper) *http.Client {
	if next == nil {
		next = newDreamMakerTransport()
	}
	return &http.Client{Transport: &dmbridge.SinglePhysicalTransport{Next: next, Check: dmPhysicalTarget}, Timeout: 130 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// Uses the original routing/protocol Server; replaces only its model HTTP transport.
func NewDreamMakerServer() *Server { s := New(); s.client = newDreamMakerClient(nil); return s }

const codexResponsesURL = "https://chatgpt.com/backend-api/codex/responses"

func dmBufferedSSE(body io.Reader) (io.Reader, bool) {
	prefix := make([]byte, 64*1024)
	var buffered bytes.Buffer
	for buffered.Len() < len(prefix) {
		offset := buffered.Len()
		n, err := io.ReadAtLeast(body, prefix[offset:], 1)
		if n > 0 {
			buffered.Write(prefix[offset : offset+n])
			if dmSSEField(buffered.String()) {
				return io.MultiReader(bytes.NewReader(buffered.Bytes()), body), true
			}
		}
		if err != nil {
			break
		}
	}
	return io.MultiReader(bytes.NewReader(buffered.Bytes()), body), false
}

func dmSSEField(raw string) bool {
	text := strings.TrimPrefix(raw, "\ufeff")
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimLeft(line, " \t\r")
		for _, field := range []string{"data:", "event:", "id:", "retry:", ":"} {
			if strings.HasPrefix(line, field) {
				return true
			}
		}
	}
	return false
}

// The DM-only entry sends the admitted native wire through the same single-use
// transport and proxy as other roles. No provider selection or URL comes from HTTP.
func (s *Server) CodexPlannerResponses(w http.ResponseWriter, r *http.Request) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, codexResponsesURL, r.Body)
	if err != nil {
		http.Error(w, "DM_CODEX_REQUEST_INVALID", 400)
		return
	}
	for _, name := range []string{"Authorization", "ChatGPT-Account-ID", "Content-Type", "Accept"} {
		if value := r.Header.Get(name); value != "" {
			req.Header.Set(name, value)
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		http.Error(w, "DM_CODEX_UPSTREAM_FAILED", 502)
		return
	}
	defer resp.Body.Close()
	for _, name := range []string{"Content-Type", "X-Request-ID"} {
		if value := resp.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	body := io.Reader(resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		rawContentType := resp.Header.Get("Content-Type")
		media, _, mediaErr := mime.ParseMediaType(rawContentType)
		if strings.TrimSpace(rawContentType) == "" || mediaErr == nil && media == "text/plain" {
			var sse bool
			body, sse = dmBufferedSSE(resp.Body)
			if sse {
				w.Header().Set("Content-Type", "text/event-stream")
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	// Truncation must remain a broken response; never report a short stream as complete.
	if _, err = io.Copy(w, body); err != nil {
		panic(http.ErrAbortHandler)
	}
}

func dmClaudeReview(a dmbridge.Admission) bool {
	return a.Provider == "string" && a.Runtime == "claude" && a.Role == "reviewer" && a.Model == "claude-sonnet-5" && a.Protocol == "anthropic-messages" && a.Path == "/v1/messages" && a.Authentication == "api_key"
}

func dmClaudeText(raw json.RawMessage) bool {
	var text *string
	if json.Unmarshal(raw, &text) == nil && text != nil {
		return true
	}
	var blocks []json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil || len(blocks) == 0 {
		return false
	}
	for _, b := range blocks {
		fields, err := dmObject(b, "type", "text", "cache_control")
		if err != nil || string(fields["type"]) != `"text"` || json.Unmarshal(fields["text"], &text) != nil || text == nil {
			return false
		}
		if cache := fields["cache_control"]; cache != nil {
			c, err := dmObject(cache, "type", "ttl")
			if err != nil || string(c["type"]) != `"ephemeral"` || (c["ttl"] != nil && string(c["ttl"]) != `"5m"` && string(c["ttl"]) != `"1h"`) {
				return false
			}
		}
	}
	return true
}

func dmClaudeBody(a dmbridge.Admission, raw []byte, model string) error {
	if len(raw) > 262144 || int64(len(raw)) > a.MaxInputTokens {
		return dmTargetDenied
	}
	fields, err := dmObject(raw, "model", "max_tokens", "messages", "system", "tools", "stream", "thinking", "output_config")
	var name string
	var maximum int64
	var messages []json.RawMessage
	if err != nil || json.Unmarshal(fields["model"], &name) != nil || name != model || json.Unmarshal(fields["max_tokens"], &maximum) != nil || maximum < 1 || maximum > a.MaxOutputTokens || json.Unmarshal(fields["messages"], &messages) != nil || len(messages) == 0 {
		return dmTargetDenied
	}
	if v := fields["stream"]; v != nil && string(v) != "true" && string(v) != "false" {
		return dmTargetDenied
	}
	if v := fields["tools"]; v != nil {
		var tools []json.RawMessage
		if json.Unmarshal(v, &tools) != nil || tools == nil || len(tools) != 0 {
			return dmTargetDenied
		}
	}
	if v := fields["thinking"]; v != nil {
		m, e := dmObject(v, "type")
		if e != nil || string(m["type"]) != `"disabled"` {
			return dmTargetDenied
		}
	}
	if v := fields["output_config"]; v != nil {
		m, e := dmObject(v, "effort")
		if e != nil || string(m["effort"]) != `"high"` {
			return dmTargetDenied
		}
	}
	if v := fields["system"]; v != nil && !dmClaudeText(v) {
		return dmTargetDenied
	}
	for _, raw := range messages {
		m, e := dmObject(raw, "role", "content")
		if e != nil || (string(m["role"]) != `"user"` && string(m["role"]) != `"assistant"`) || !dmClaudeText(m["content"]) {
			return dmTargetDenied
		}
	}
	return nil
}

// Validate the controller's final native Responses payload. Transient CLI metadata
// and tool declarations do not belong to a data-only Planner 2 turn.
func dmCodexPlannerBody(a dmbridge.Admission, body []byte) error {
	if a.Method != "POST" || a.Role != "planner2" || a.RoleID != "planner2" || a.Runtime != "codex" || a.Provider != "openai" || a.Model != "gpt-6-luna" || a.Protocol != "openai-responses" || a.Authentication != "oauth" || a.Path != "/backend-api/codex/responses" {
		return dmTargetDenied
	}
	digest := sha256.Sum256(body)
	if a.BodyHash != hex.EncodeToString(digest[:]) || len(body) > 262144 || int64(len(body)) > a.MaxInputTokens {
		return dmTargetDenied
	}
	b, err := dmObject(body, "model", "input", "store", "stream", "max_output_tokens", "text", "instructions")
	var model string
	var maximum int64
	if err != nil || json.Unmarshal(b["model"], &model) != nil || model != a.Model || string(b["store"]) != "false" || string(b["stream"]) != "true" || json.Unmarshal(b["max_output_tokens"], &maximum) != nil || maximum < 1 || maximum > a.MaxOutputTokens {
		return dmTargetDenied
	}
	if v, ok := b["instructions"]; ok {
		var instructions *string
		if json.Unmarshal(v, &instructions) != nil || instructions == nil {
			return dmTargetDenied
		}
	}
	var input []json.RawMessage
	if json.Unmarshal(b["input"], &input) != nil || len(input) == 0 {
		return dmTargetDenied
	}
	for _, raw := range input {
		m, err := dmObject(raw, "role", "type", "content")
		if err != nil || string(m["type"]) != `"message"` {
			return dmTargetDenied
		}
		var role string
		if json.Unmarshal(m["role"], &role) != nil || !slices.Contains([]string{"developer", "system", "user"}, role) {
			return dmTargetDenied
		}
		var parts []json.RawMessage
		if json.Unmarshal(m["content"], &parts) != nil || len(parts) == 0 {
			return dmTargetDenied
		}
		for _, part := range parts {
			p, err := dmObject(part, "type", "text")
			var value *string
			if err != nil || string(p["type"]) != `"input_text"` || json.Unmarshal(p["text"], &value) != nil || value == nil {
				return dmTargetDenied
			}
		}
	}
	if raw, ok := b["text"]; ok {
		t, err := dmObject(raw, "format", "verbosity")
		if err != nil {
			return err
		}
		if v, exists := t["verbosity"]; exists && !slices.Contains([]string{`"low"`, `"medium"`, `"high"`}, string(v)) {
			return dmTargetDenied
		}
		if f, exists := t["format"]; exists {
			format, err := dmObject(f, "type", "name", "strict", "schema")
			if err != nil || string(format["type"]) != `"json_schema"` || string(format["strict"]) != "true" {
				return dmTargetDenied
			}
			var name string
			if json.Unmarshal(format["name"], &name) != nil || name == "" {
				return dmTargetDenied
			}
			if _, err := dmbridge.RequestFields(format["schema"]); err != nil {
				return dmTargetDenied
			}
		}
	}
	return nil
}
