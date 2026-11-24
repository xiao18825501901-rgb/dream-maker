package gateway

import (
	"bytes"
	"github.com/yetone/magpie/internal/dmbridge"
	"reflect"
	"strings"
)

// Parse all frames before a client can act on a tool call. Accept one block per turn.
func piFrames(raw []byte) []piObj {
	raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	if !bytes.HasSuffix(raw, []byte("\n\n")) {
		return nil
	}
	blocks := bytes.Split(raw[:len(raw)-2], []byte("\n\n"))
	if len(blocks) < 3 || len(blocks) > 2048 {
		return nil
	}
	out := make([]piObj, 0, len(blocks))
	for _, b := range blocks {
		lines := bytes.Split(b, []byte("\n"))
		if len(lines) != 2 || len(b) > 1<<20 || !bytes.HasPrefix(lines[1], []byte("data: ")) {
			return nil
		}
		o := piParse(lines[1][6:])
		if o == nil || string(lines[0]) != "event: "+piStr(o["type"]) {
			return nil
		}
		out = append(out, o)
	}
	return out
}
func piTranscript(raw []byte, a dmbridge.Admission, max int64, tools *piDeclaredTools) ([]byte, error) {
	frames := piFrames(raw)
	if frames == nil {
		return nil, dmTargetDenied
	}
	if a.Protocol == "openai-responses" {
		if piObject(frames[1]["item"])["type"] != "function_call" {
			usage := piObject(piObject(frames[len(frames)-1]["response"])["usage"])
			if piNum(usage["total_tokens"]) < 0 || piNum(piObject(usage["input_tokens_details"])["cached_tokens"]) < 0 {
				return nil, dmTargetDenied
			}
			if _, err := dmResponsesTranscript(raw, a, max); err != nil {
				return nil, err
			}
			return raw, nil
		}
		if !piResponseCall(frames, a, max, tools) {
			return nil, dmTargetDenied
		}
	} else if !piMessage(frames, a, max, tools) {
		return nil, dmTargetDenied
	}
	return raw, nil
}
func piEnvelope(f piObj, typ string) piObj {
	if !piKeys(f, "type response sequence_number") || f["type"] != typ {
		return nil
	}
	return piObject(f["response"])
}
func piResponseCall(fs []piObj, a dmbridge.Admission, max int64, t *piDeclaredTools) bool {
	if len(fs) < 6 {
		return false
	}
	start := piEnvelope(fs[0], "response.created")
	end := piEnvelope(fs[len(fs)-1], "response.completed")
	rid := piStr(start["id"])
	if !dmResponseID.MatchString(rid) || piStr(end["id"]) != rid || start["model"] != a.Model || end["model"] != a.Model || start["status"] != "in_progress" || end["status"] != "completed" || start["object"] != "response" || end["object"] != "response" || start["error"] != nil || end["error"] != nil || piArr(start["output"]) == nil || len(piArr(start["output"])) != 0 {
		return false
	}
	added := fs[1]
	if added["type"] != "response.output_item.added" || piNum(added["output_index"]) != 0 || !piKeys(added, "type output_index item sequence_number") {
		return false
	}
	item := piObject(added["item"])
	id := piStr(item["id"])
	name := piStr(item["name"])
	if !piKeys(item, "type id call_id name arguments status") || !dmResponseID.MatchString(id) || !dmResponseID.MatchString(piStr(item["call_id"])) || t.seen[piStr(item["call_id"])] || !t.names[name] || item["arguments"] != "" || item["status"] != "in_progress" || item["type"] != "function_call" {
		return false
	}
	var buf strings.Builder
	for _, f := range fs[2 : len(fs)-3] {
		if !piKeys(f, "type output_index item_id delta sequence_number") || f["type"] != "response.function_call_arguments.delta" || piNum(f["output_index"]) != 0 || piStr(f["item_id"]) != id || !piShort(f["delta"], 65536) || buf.Len()+len(piStr(f["delta"])) > 65536 {
			return false
		}
		buf.WriteString(piStr(f["delta"]))
	}
	done := fs[len(fs)-3]
	if !piKeys(done, "type output_index item_id arguments sequence_number") || done["type"] != "response.function_call_arguments.done" || piStr(done["item_id"]) != id || piNum(done["output_index"]) != 0 || piStr(done["arguments"]) != buf.String() || !piArguments(name, piParse([]byte(buf.String()))) {
		return false
	}
	last := fs[len(fs)-2]
	expected := piObj{"type": "function_call", "status": "completed", "id": id, "call_id": item["call_id"], "name": name, "arguments": buf.String()}
	if !piKeys(last, "type output_index item sequence_number") || last["type"] != "response.output_item.done" || piNum(last["output_index"]) != 0 || !reflect.DeepEqual(last["item"], expected) || !reflect.DeepEqual(end["output"], []any{expected}) {
		return false
	}
	u := piObject(end["usage"])
	input, output := piNum(u["input_tokens"]), piNum(u["output_tokens"])
	cache := piNum(piObject(u["input_tokens_details"])["cached_tokens"])
	if input < 0 || input > a.MaxInputTokens || output < 0 || output > max || piNum(u["total_tokens"]) != input+output || cache < 0 || cache > input {
		return false
	}
	return true
}
func piMessage(fs []piObj, a dmbridge.Admission, max int64, t *piDeclaredTools) bool {
	if len(fs) < 6 {
		return false
	}
	start := fs[0]
	m := piObject(start["message"])
	if !piKeys(start, "type message") || start["type"] != "message_start" || !piKeys(m, "id type role model content stop_reason stop_sequence usage") || !dmResponseID.MatchString(piStr(m["id"])) || m["model"] != a.Model || m["type"] != "message" || m["role"] != "assistant" || piArr(m["content"]) == nil || len(piArr(m["content"])) != 0 || m["stop_reason"] != nil || m["stop_sequence"] != nil {
		return false
	}
	u := piObject(m["usage"])
	input, cache := piNum(u["input_tokens"]), piNum(u["cache_read_input_tokens"])
	initial := piNum(u["output_tokens"])
	if !piKeys(u, "input_tokens output_tokens cache_read_input_tokens cache_creation_input_tokens") || input < 0 || input > a.MaxInputTokens || cache < 0 || cache > a.MaxInputTokens-input || piNum(u["cache_creation_input_tokens"]) != 0 || initial < 0 || initial > max {
		return false
	}
	b := fs[1]
	block := piObject(b["content_block"])
	if !piKeys(b, "type index content_block") || b["type"] != "content_block_start" || piNum(b["index"]) != 0 {
		return false
	}
	tool := block["type"] == "tool_use"
	name := piStr(block["name"])
	if tool {
		if !piKeys(block, "type id name input") || !dmResponseID.MatchString(piStr(block["id"])) || t.seen[piStr(block["id"])] || !t.names[name] || !reflect.DeepEqual(block["input"], piObj{}) {
			return false
		}
	} else if !piKeys(block, "type text") || block["type"] != "text" || block["text"] != "" {
		return false
	}
	var content strings.Builder
	for _, f := range fs[2 : len(fs)-3] {
		d := piObject(f["delta"])
		if !piKeys(f, "type index delta") || f["type"] != "content_block_delta" || piNum(f["index"]) != 0 {
			return false
		}
		key, kind := "text", "text_delta"
		if tool {
			key, kind = "partial_json", "input_json_delta"
		}
		if !piKeys(d, "type "+key) || d["type"] != kind || !piShort(d[key], 262144) {
			return false
		}
		content.WriteString(piStr(d[key]))
		if tool && content.Len() > 65536 {
			return false
		}
	}
	reason := "end_turn"
	if tool {
		reason = "tool_use"
		if !piArguments(name, piParse([]byte(content.String()))) {
			return false
		}
	} else if strings.TrimSpace(content.String()) == "" {
		return false
	}
	stop, delta, terminal := fs[len(fs)-3], fs[len(fs)-2], fs[len(fs)-1]
	d := piObject(delta["delta"])
	usage := piObject(delta["usage"])
	out := piNum(usage["output_tokens"])
	if !piKeys(stop, "type index") || stop["type"] != "content_block_stop" || piNum(stop["index"]) != 0 || !piKeys(delta, "type delta usage") || delta["type"] != "message_delta" || !piKeys(d, "stop_reason stop_sequence") || d["stop_reason"] != reason || d["stop_sequence"] != nil || !piKeys(usage, "output_tokens") || out < initial || out > max || !piKeys(terminal, "type") || terminal["type"] != "message_stop" {
		return false
	}
	return true
}
