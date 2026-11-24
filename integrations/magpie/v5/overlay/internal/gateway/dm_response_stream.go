package gateway

import (
	"bytes"
	"encoding/json"
	"github.com/yetone/magpie/internal/dmbridge"
	"regexp"
	"strings"
)

var dmResponseID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)

type dmResponsePart struct {
	Type string
	Text *string
}
type dmOutputItem struct {
	ID, Type, Status, Role string
	Content                []dmResponsePart
}
type dmResponseUsage struct {
	Input   *int64 `json:"input_tokens"`
	Output  *int64 `json:"output_tokens"`
	Total   *int64 `json:"total_tokens"`
	Details *struct {
		Cached *int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
}
type dmNativeResponse struct {
	ID, Model, Status, Object string
	Error                     json.RawMessage
	Output                    []dmOutputItem
	Usage                     *dmResponseUsage
}
type dmWireEvent struct {
	Type         string
	Response     *dmNativeResponse
	Item         *dmOutputItem
	Part         *dmResponsePart
	ItemID       string `json:"item_id"`
	Index        *int   `json:"output_index"`
	ContentIndex *int   `json:"content_index"`
	Delta, Text  *string
}

func dmPartEquals(p *dmResponsePart, text string) bool {
	return p != nil && p.Type == "output_text" && p.Text != nil && *p.Text == text
}
func dmItemEquals(i *dmOutputItem, id, text string) bool {
	return i != nil && i.Type == "message" && i.Role == "assistant" && i.Status == "completed" && i.ID == id && len(i.Content) == 1 && dmPartEquals(&i.Content[0], text)
}
func dmUsageAllowed(u *dmResponseUsage, input, output int64) bool {
	return u != nil && u.Input != nil && u.Output != nil && *u.Input >= 0 && *u.Input <= input && *u.Output >= 0 && *u.Output <= output && (u.Total == nil || *u.Total == *u.Input+*u.Output) && (u.Details == nil || u.Details.Cached == nil || *u.Details.Cached >= 0 && *u.Details.Cached <= *u.Input)
}

// Validate the complete transcript before releasing any supervisor text. Only the
// account qualification on response.model changes on the wire to the controller.
func dmResponsesTranscript(raw []byte, a dmbridge.Admission, limit int64) ([]byte, error) {
	if len(raw) > explicitReplyLimit {
		return nil, dmTargetDenied
	}
	raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	if !bytes.HasSuffix(raw, []byte("\n\n")) {
		return nil, dmTargetDenied
	}
	var out bytes.Buffer
	var text strings.Builder
	id, item := "", ""
	stage, count := 0, 0
	for len(raw) > 0 {
		block, rest, ok := bytes.Cut(raw, []byte("\n\n"))
		if !ok {
			return nil, dmTargetDenied
		}
		raw = rest
		if len(block) == 0 {
			continue
		}
		count++
		if count > 8192 || len(block) > 1<<20 {
			return nil, dmTargetDenied
		}
		if stage == 8 {
			if !bytes.Equal(block, []byte("data: [DONE]")) || len(raw) != 0 {
				return nil, dmTargetDenied
			}
			out.Write(block)
			out.WriteString("\n\n")
			break
		}
		var name string
		var data []byte
		for _, line := range bytes.Split(block, []byte("\n")) {
			if v, ok := bytes.CutPrefix(line, []byte("event:")); ok && name == "" {
				name = string(bytes.TrimSpace(v))
			} else if v, ok := bytes.CutPrefix(line, []byte("data:")); ok && data == nil {
				data = bytes.TrimSpace(v)
			} else {
				return nil, dmTargetDenied
			}
		}
		var e dmWireEvent
		fields, err := dmbridge.RequestFields(data)
		if err != nil || json.Unmarshal(data, &e) != nil || e.Type == "" || name != "" && name != e.Type {
			return nil, dmTargetDenied
		}
		if strings.HasPrefix(e.Type, "response.output_item.") || strings.HasPrefix(e.Type, "response.content_part.") || strings.HasPrefix(e.Type, "response.output_text.") {
			if e.Index == nil || *e.Index != 0 {
				return nil, dmTargetDenied
			}
			if !strings.HasPrefix(e.Type, "response.output_item.") && (e.ContentIndex == nil || *e.ContentIndex != 0 || e.ItemID != item) {
				return nil, dmTargetDenied
			}
		}
		switch e.Type {
		case "response.created", "response.in_progress", "response.completed":
			r := e.Response
			if r == nil || r.Model != a.Model || !dmResponseID.MatchString(r.ID) || r.Object != "response" || r.Output == nil || len(r.Error) > 0 && string(r.Error) != "null" {
				return nil, dmTargetDenied
			}
			if e.Type == "response.created" {
				if stage != 0 {
					return nil, dmTargetDenied
				}
				id = r.ID
				stage = 1
			}
			if r.ID != id {
				return nil, dmTargetDenied
			}
			if e.Type == "response.completed" {
				if stage != 7 || r.Status != "completed" || len(r.Output) != 1 || !dmItemEquals(&r.Output[0], item, text.String()) || !dmUsageAllowed(r.Usage, a.MaxInputTokens, limit) {
					return nil, dmTargetDenied
				}
				stage = 8
			} else if stage != 1 || r.Status != "in_progress" || len(r.Output) != 0 {
				return nil, dmTargetDenied
			}
			response, er := dmbridge.RequestFields(fields["response"])
			if er != nil {
				return nil, dmTargetDenied
			}
			response["model"], _ = json.Marshal(a.Provider + "/" + a.Model)
			fields["response"], _ = json.Marshal(response)
			data, _ = json.Marshal(fields)
		case "response.output_item.added":
			i := e.Item
			if stage != 1 || i == nil || !dmResponseID.MatchString(i.ID) || i.Type != "message" || i.Role != "assistant" || i.Status != "in_progress" || len(i.Content) != 0 {
				return nil, dmTargetDenied
			}
			item = i.ID
			stage = 2
		case "response.content_part.added":
			if stage != 2 || !dmPartEquals(e.Part, "") {
				return nil, dmTargetDenied
			}
			stage = 3
		case "response.output_text.delta":
			if stage != 3 || e.Delta == nil {
				return nil, dmTargetDenied
			}
			text.WriteString(*e.Delta)
		case "response.output_text.done":
			if stage != 3 || e.Text == nil || *e.Text != text.String() || strings.TrimSpace(text.String()) == "" {
				return nil, dmTargetDenied
			}
			stage = 4
		case "response.content_part.done":
			if stage != 4 || !dmPartEquals(e.Part, text.String()) {
				return nil, dmTargetDenied
			}
			stage = 5
		case "response.output_item.done":
			if stage != 5 || !dmItemEquals(e.Item, item, text.String()) {
				return nil, dmTargetDenied
			}
			stage = 7
		default:
			return nil, dmTargetDenied
		}
		out.WriteString("event: " + e.Type + "\ndata: ")
		out.Write(data)
		out.WriteString("\n\n")
		if out.Len() > explicitReplyLimit {
			return nil, dmTargetDenied
		}
	}
	if stage != 8 {
		return nil, dmTargetDenied
	}
	return out.Bytes(), nil
}
