package gateway

import (
	"bytes"
	"encoding/json"
	"github.com/yetone/magpie/internal/dmbridge"
	"reflect"
	"slices"
	"strings"
)

type piObj = map[string]any
type piDeclaredTools struct {
	names map[string]bool
	seen  map[string]bool
}

func piNative(a dmbridge.Admission) bool {
	return a.Runtime == "pi" && a.Role == "executor" && (a.Protocol == "openai-responses" || a.Protocol == "anthropic-messages")
}
func piParse(raw []byte) piObj {
	if !dmReplyJSON(raw, nil) {
		return nil
	}
	var o piObj
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&o) != nil {
		return nil
	}
	return o
}
func piObject(x any) piObj  { o, _ := x.(map[string]any); return o }
func piArr(x any) []any  { a, _ := x.([]any); return a }
func piStr(x any) string { s, _ := x.(string); return s }
func piNum(x any) int64 {
	n, ok := x.(json.Number)
	if !ok {
		return -1
	}
	i, e := n.Int64()
	if e != nil {
		return -1
	}
	return i
}
func piKeys(o piObj, allowed string) bool {
	if o == nil {
		return false
	}
	names := strings.Fields(allowed)
	for k := range o {
		if !slices.Contains(names, k) {
			return false
		}
	}
	return true
}
func piShort(x any, max int) bool { s, ok := x.(string); return ok && len(s) > 0 && len(s) <= max }
func piCache(o piObj) bool {
	c, exists := o["cache_control"]
	return !exists || reflect.DeepEqual(c, piObj{"type": "ephemeral"})
}

// Only controller-registered tools. The broker owns path and Prework authorization.
var piArgs = map[string][]string{"desk_read": {"path"}, "desk_search": {"text"}, "desk_write": {"path", "content", "?expected_sha"}, "desk_edit": {"path", "old_text", "new_text", "?expected_sha"}, "desk_run": {"entry", "?runtime", "?args", "?stdin"}}

func piSchema(name string) piObj {
	props := piObj{}
	required := []any{}
	for _, field := range piArgs[name] {
		k := strings.TrimPrefix(field, "?")
		if k == field {
			required = append(required, k)
		}
		props[k] = piObj{"type": "string"}
		if k == "args" {
			props[k] = piObj{"type": "array", "items": piObj{"type": "string"}}
		}
	}
	return piObj{"type": "object", "required": required, "properties": props}
}
func piArguments(name string, o piObj) bool {
	defs := piArgs[name]
	if defs == nil || o == nil {
		return false
	}
	count := 0
	for _, f := range defs {
		k := strings.TrimPrefix(f, "?")
		v, ok := o[k]
		if !ok {
			if k == f {
				return false
			}
			continue
		}
		count++
		if k == "args" {
			a := piArr(v)
			if a == nil || len(a) > 128 {
				return false
			}
			for _, x := range a {
				if _, ok := x.(string); !ok {
					return false
				}
			}
		} else if _, ok := v.(string); !ok {
			return false
		}
	}
	return count == len(o)
}
func piDeclarations(v any, responses bool) *piDeclaredTools {
	list := piArr(v)
	if len(list) == 0 || len(list) > len(piArgs) {
		return nil
	}
	tools := &piDeclaredTools{names: map[string]bool{}, seen: map[string]bool{}}
	for _, x := range list {
		o := piObject(x)
		name := piStr(o["name"])
		if piArgs[name] == nil || tools.names[name] || !piShort(o["description"], 2048) {
			return nil
		}
		if responses {
			if !piKeys(o, "type name description parameters") || o["type"] != "function" || !reflect.DeepEqual(o["parameters"], piSchema(name)) {
				return nil
			}
		} else {
			if !piKeys(o, "name description input_schema eager_input_streaming cache_control") || !piCache(o) || !reflect.DeepEqual(o["input_schema"], piSchema(name)) {
				return nil
			}
			if v, ok := o["eager_input_streaming"]; ok && v != true {
				return nil
			}
		}
		tools.names[name] = true
	}
	return tools
}
func piTextBlocks(x any, kind string) bool {
	a := piArr(x)
	if len(a) < 1 || len(a) > 64 {
		return false
	}
	for _, v := range a {
		o := piObject(v)
		if !piKeys(o, "type text cache_control") || o["type"] != kind || !piShort(o["text"], 262144) || !piCache(o) {
			return false
		}
	}
	return true
}
func piHistory(o piObj, resp bool, tools *piDeclaredTools) bool {
	field := "messages"
	if resp {
		field = "input"
	}
	list := piArr(o[field])
	if len(list) == 0 || len(list) > 256 {
		return false
	}
	seen := tools.seen
	pending := ""
	user := false
	for i, v := range list {
		m := piObject(v)
		if m == nil {
			return false
		}
		var call, name, id, out string
		var args piObj
		if resp {
			switch m["type"] {
			case "function_call":
				if !piKeys(m, "type id call_id name arguments") || !dmResponseID.MatchString(piStr(m["id"])) {
					return false
				}
				call = "call"
				id = piStr(m["call_id"])
				name = piStr(m["name"])
				args = piParse([]byte(piStr(m["arguments"])))
			case "function_call_output":
				if !piKeys(m, "type call_id output") {
					return false
				}
				call = "result"
				id = piStr(m["call_id"])
				out = piStr(m["output"])
			case nil, "message":
				if !piKeys(m, "type role content") || pending != "" {
					return false
				}
				switch m["role"] {
				case "system", "developer":
					if i != 0 || !piShort(m["content"], 262144) {
						return false
					}
				case "user":
					if !piTextBlocks(m["content"], "input_text") {
						return false
					}
					user = true
				default:
					return false
				}
				continue
			default:
				return false
			}
		} else {
			if !piKeys(m, "role content") {
				return false
			}
			blocks := piArr(m["content"])
			if len(blocks) != 1 {
				return false
			}
			b := piObject(blocks[0])
			switch b["type"] {
			case "text":
				if m["role"] != "user" || pending != "" || !piTextBlocks(blocks, "text") {
					return false
				}
				user = true
				continue
			case "tool_use":
				if m["role"] != "assistant" || !piKeys(b, "type id name input") {
					return false
				}
				call = "call"
				id = piStr(b["id"])
				name = piStr(b["name"])
				args = piObject(b["input"])
			case "tool_result":
				if m["role"] != "user" || !piKeys(b, "type tool_use_id content is_error cache_control") || !piCache(b) {
					return false
				}
				if e, ok := b["is_error"]; ok {
					if _, ok = e.(bool); !ok {
						return false
					}
				}
				call = "result"
				id = piStr(b["tool_use_id"])
				out = piStr(b["content"])
			default:
				return false
			}
		}
		if !user || !dmResponseID.MatchString(id) {
			return false
		}
		if call == "call" {
			if pending != "" || seen[id] || !tools.names[name] || !piArguments(name, args) {
				return false
			}
			seen[id] = true
			pending = id
		} else {
			if id != pending || out == "" || len(out) > 262144 {
				return false
			}
			pending = ""
		}
	}
	return user && pending == ""
}
func piRequest(a dmbridge.Admission, raw []byte) (*piDeclaredTools, bool) {
	if len(raw) > 262144 || a.MaxInputTokens < 1048576 {
		return nil, false
	}
	o := piParse(raw)
	resp := a.Protocol == "openai-responses"
	max := "max_tokens"
	if resp {
		max = "max_output_tokens"
		if !piKeys(o, "model input stream store max_output_tokens prompt_cache_key tools") || o["store"] != false {
			return nil, false
		}
		if v, ok := o["prompt_cache_key"]; ok && !piShort(v, 256) {
			return nil, false
		}
	} else if !piKeys(o, "model messages max_tokens stream system tools") || !piTextBlocks(o["system"], "text") {
		return nil, false
	}
	t := piDeclarations(o["tools"], resp)
	return t, t != nil && o["stream"] == true && piNum(o[max]) > 0 && piNum(o[max]) <= a.MaxOutputTokens && piHistory(o, resp, t)
}
