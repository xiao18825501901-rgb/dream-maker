import { DomainError, hash } from '../security.js';

/**
 * Inbound adapter for the OpenAI Responses wire that the pinned Codex CLI speaks
 * for every custom provider. The DM-owned gateway serves chat-completions
 * upstream (DeepSeek), so this module translates in exactly one direction and
 * back. Only shapes observed on the wire are accepted; anything else is refused
 * instead of being passed through.
 */
export interface ResponsesLimits { model: string; maxOutputTokens: number }
export interface ChatTool { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface ChatBody {
    model: string;
    messages: Array<Record<string, unknown>>;
    tools?: ChatTool[];
    tool_choice?: unknown;
    max_tokens: number;
    stream: false;
    response_format?: { type: 'json_object' };
}
export interface ResponsesTranslation { chat: ChatBody; stream: boolean }

const fail = (): never => { throw new DomainError('RESPONSES_REQUEST_INVALID', 400); };
const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
};
const text = (value: unknown): string => typeof value === 'string' ? value : fail();
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Flatten one Responses content array into plain text. Only text parts exist on this wire. */
function contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return fail();
    const parts: string[] = [];
    for (const raw of content) {
        const part = record(raw);
        if (part.type !== 'input_text' && part.type !== 'output_text' && part.type !== 'text') return fail();
        parts.push(text(part.text));
    }
    return parts.join('');
}

function chatTools(raw: unknown): ChatTool[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return fail();
    return raw.map(value => {
        const tool = record(value);
        if (tool.type !== 'function' || typeof tool.name !== 'string' || !NAME.test(tool.name)) return fail();
        const parameters = tool.parameters === undefined ? { type: 'object', properties: {} } : record(tool.parameters);
        return {
            type: 'function' as const,
            function: {
                name: tool.name,
                ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
                parameters,
            },
        };
    });
}

function chatToolChoice(raw: unknown): unknown {
    if (raw === undefined || raw === null || raw === 'auto') return raw === 'auto' ? 'auto' : undefined;
    if (typeof raw === 'string') {
        if (raw === 'none' || raw === 'required') return raw;
        return fail();
    }
    const value = record(raw);
    if (value.type !== 'function' || typeof value.name !== 'string' || !NAME.test(value.name)) return fail();
    return { type: 'function', function: { name: value.name } };
}

/**
 * Translate one `POST /v1/responses` body into the chat-completions body the
 * upstream understands. Rejects unknown item types so a future CLI change
 * fails closed instead of silently dropping the model's context.
 */
export function responsesRequestToChat(raw: unknown, limits: ResponsesLimits): ResponsesTranslation {
    const body = record(raw);
    if (body.model !== limits.model) return fail();
    if (body.stream !== undefined && typeof body.stream !== 'boolean') return fail();
    if (body.store !== undefined && body.store !== false) return fail();
    if (!Array.isArray(body.input) || body.input.length === 0) return fail();
    if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
        if (!Number.isSafeInteger(body.max_output_tokens) || Number(body.max_output_tokens) < 1) return fail();
    }

    const messages: Array<Record<string, unknown>> = [];
    let pendingCalls: Array<Record<string, unknown>> = [];
    const flushCalls = () => {
        if (!pendingCalls.length) return;
        messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
        pendingCalls = [];
    };
    for (const rawItem of body.input) {
        const item = record(rawItem);
        const type = item.type ?? 'message';
        if (type === 'message') {
            flushCalls();
            const role = item.role;
            if (role !== 'developer' && role !== 'system' && role !== 'user' && role !== 'assistant') return fail();
            messages.push({ role: role === 'developer' ? 'system' : role, content: contentText(item.content) });
            continue;
        }
        if (type === 'function_call') {
            if (typeof item.name !== 'string' || !NAME.test(item.name)) return fail();
            const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : text(item.id);
            pendingCalls.push({ id: callId, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' } });
            continue;
        }
        if (type === 'function_call_output') {
            flushCalls();
            if (typeof item.call_id !== 'string' || !item.call_id) return fail();
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
            continue;
        }
        if (type === 'reasoning') continue;
        return fail();
    }
    flushCalls();
    if (!messages.length) return fail();

    const tools = chatTools(body.tools);
    const toolChoice = chatToolChoice(body.tool_choice);
    const requested = Number.isSafeInteger(body.max_output_tokens) ? Number(body.max_output_tokens) : limits.maxOutputTokens;
    const chat: ChatBody = {
        model: limits.model,
        messages,
        max_tokens: Math.max(1, Math.min(requested, limits.maxOutputTokens)),
        stream: false,
        ...(tools.length ? { tools } : {}),
        ...(tools.length && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    };
    // The Codex roles ask for structured JSON through `text.format`. DeepSeek's
    // chat wire only guarantees json_object mode, and the controller still
    // validates the parsed document before it can become a plan or a review.
    const format = body.text !== undefined ? record(body.text).format : undefined;
    if (format !== undefined && format !== null) {
        const kind = record(format).type;
        if (kind !== 'json_schema' && kind !== 'json_object') return fail();
        chat.response_format = { type: 'json_object' };
    }
    return { chat, stream: body.stream === true };
}

export interface UpstreamChatResult {
    id: string;
    model: string;
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    usage: { prompt_tokens: number; completion_tokens: number };
}

/** Read the already-validated upstream chat document into the Responses result shape. */
export function chatResult(raw: Record<string, unknown>, model: string): UpstreamChatResult {
    const choices = raw.choices;
    if (!Array.isArray(choices) || choices.length !== 1) return fail();
    const message = record(record(choices[0]).message);
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls: UpstreamChatResult['toolCalls'] = [];
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
        if (!Array.isArray(message.tool_calls)) return fail();
        for (const rawCall of message.tool_calls) {
            const call = record(rawCall);
            const fn = record(call.function);
            if (call.type !== 'function' || typeof call.id !== 'string' || !call.id) return fail();
            if (typeof fn.name !== 'string' || !NAME.test(fn.name)) return fail();
            toolCalls.push({ id: call.id, name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}' });
        }
    }
    const usage = record(raw.usage ?? {});
    if (!Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens)) return fail();
    return {
        id: text(raw.id),
        model,
        content,
        toolCalls,
        usage: { prompt_tokens: Number(usage.prompt_tokens), completion_tokens: Number(usage.completion_tokens) },
    };
}

const responseId = (upstreamId: string) => 'resp_' + hash(upstreamId).slice(0, 24);

/** Responses JSON document for a non-streaming client. */
export function responsesDocument(result: UpstreamChatResult): Record<string, unknown> {
    const id = responseId(result.id);
    const output: Array<Record<string, unknown>> = result.toolCalls.map(call => ({
        id: 'fc_' + hash(call.id).slice(0, 20), type: 'function_call', status: 'completed',
        name: call.name, arguments: call.arguments, call_id: call.id,
    }));
    if (result.content) {
        output.push({
            id: 'msg_' + hash(result.id).slice(0, 20), type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: result.content, annotations: [] }],
        });
    }
    return {
        id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
        model: result.model, output,
        usage: {
            input_tokens: result.usage.prompt_tokens, output_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
        },
    };
}

/** SSE transcript equivalent to responsesDocument, in the order the CLI accepts. */
export function responsesEvents(result: UpstreamChatResult): string {
    const document = responsesDocument(result);
    const id = String(document.id);
    const created = Number(document.created_at);
    const lines: string[] = [];
    const emit = (type: string, payload: Record<string, unknown>) => {
        lines.push('event: ' + type, 'data: ' + JSON.stringify({ type, ...payload }), '');
    };
    emit('response.created', { response: { id, object: 'response', created_at: created, status: 'in_progress', model: result.model, output: [] } });
    const output = document.output as Array<Record<string, unknown>>;
    output.forEach((item, index) => {
        if (item.type === 'function_call') {
            emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', arguments: '' } });
            emit('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments });
            emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
            emit('response.output_item.done', { output_index: index, item });
            return;
        }
        const textValue = String((item.content as Array<Record<string, unknown>>)[0].text);
        emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', content: [] } });
        emit('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        if (textValue) emit('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: textValue });
        emit('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: textValue });
        emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: textValue, annotations: [] } });
        emit('response.output_item.done', { output_index: index, item });
    });
    emit('response.completed', { response: document });
    lines.push('');
    return lines.join('\n');
}

// Preserve the native Responses schema used by Codex. Only the frozen text
// messages and structured-output settings leave the Planner 2 controller.
export function codexPlannerResponsesBody(raw:unknown,limits:ResponsesLimits & {prompt:string; instructions:string; outputSchema?:Record<string,unknown>}):Record<string,unknown>{
    const body=record(raw);
    const allowed=['model','input','stream','store','max_output_tokens','text','instructions','include','reasoning','prompt_cache_key','client_metadata','parallel_tool_calls','tool_choice','tools'];
    if(Object.keys(body).some(key=>!allowed.includes(key))||body.model!==limits.model||body.store!==false||body.stream!==true||
       !Number.isSafeInteger(limits.maxOutputTokens)||limits.maxOutputTokens<1||limits.maxOutputTokens>16000||
       !Array.isArray(body.input)||!body.input.length)return fail();
    if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.length)||
       body.tool_choice!==undefined&&body.tool_choice!=='auto'&&body.tool_choice!=='none')return fail();
    if(typeof limits.prompt!=='string'||!limits.prompt||typeof limits.instructions!=='string'||!limits.instructions)return fail();
    const messages=[];
    for(const rawItem of body.input){
        const item=record(rawItem);
        if(item.type==='additional_tools'&&item.role==='developer'&&Array.isArray(item.tools)&&
           Object.keys(item).every(k=>['type','role','id','tools'].includes(k)))continue;
        if(item.type!=='message'||!['developer','system','user'].includes(String(item.role))||
           Object.keys(item).some(k=>!['type','role','id','content'].includes(k))||!Array.isArray(item.content)||!item.content.length)return fail();
        const content=item.content.map(value=>{
            const part=record(value);
            if(part.type!=='input_text'||Object.keys(part).some(k=>k!=='type'&&k!=='text'))return fail();
            return {type:'input_text',text:text(part.text)};
        });
        if(item.role==='user'&&content.length===1&&content[0].text===limits.prompt) messages.push({type:'message',role:'user',content});
    }
    const requested=body.max_output_tokens===undefined?limits.maxOutputTokens:body.max_output_tokens;
    if(messages.length!==1||typeof requested!=='number'||!Number.isSafeInteger(requested)||requested<1)return fail();
    const result:Record<string,unknown>={model:limits.model,input:messages,store:false,stream:true,max_output_tokens:Math.min(requested,limits.maxOutputTokens)};
    result.instructions=limits.instructions;
    if(body.text!==undefined){
        const options=record(body.text);
        if(Object.keys(options).some(k=>k!=='format'&&k!=='verbosity')||options.verbosity!==undefined&&!['low','medium','high'].includes(String(options.verbosity)))return fail();
        if(options.format!==undefined){
            const format=record(options.format);
            if(format.type!=='json_schema'||format.strict!==true||typeof format.name!=='string'||!NAME.test(format.name)||
               Object.keys(format).some(k=>!['type','strict','name','schema'].includes(k)))return fail();
            if(!limits.outputSchema||hash(record(format.schema))!==hash(limits.outputSchema))return fail();
        }
        result.text=structuredClone(options);
    }
    if(limits.outputSchema&&(!result.text||!record(result.text).format))return fail();
    return result;
}

/**
 * The executor arm of the same wire, answered in the other direction.
 *
 * The paid planner lane above closes on one message item. An executor turn may close on the
 * tool calls it asks for instead, and `codex exec` reads them as `response.function_call`
 * items streamed exactly the way the message item is: announced once, its arguments streamed,
 * then settled and echoed by `response.completed`. The Go body check that admitted the request
 * (dmExecutorTranscript) accepts zero to sixteen of them, so the client side has to read the same
 * shape back or the round trip stops at the first tool round.
 *
 * Nothing is invented here: the item id, the call id, the name and the arguments are the ones
 * the upstream stream carried, and the message item is still the one the planner lane expects.
 */
const executorItemId = (value: unknown): string => typeof value === 'string' && /^[-A-Za-z0-9_]{1,200}$/.test(value) ? value : fail();
export interface ResponsesCallItem {itemId:string; callId:string; name:string; arguments:string}

/** Serve one executor completion as the items it was assembled from, calls first in their order. */
export function codexExecutorResponsesEvents(result: {id: string; model: string; text: string; calls: readonly ResponsesCallItem[];
    usage: {inputTokens: number; outputTokens: number; cacheHitTokens?: number}}): string {
    // The transcript is released as a whole and its framing is the one the client reads: a text
    // item first when the turn answered in text (Codex reads a message as the finished answer), then
    // the calls of that same turn in the order they were asked for.
    const events: Record<string, unknown>[] = [], output: Record<string, unknown>[] = [];
    let seq = 0, index = 0;
    const push = (event: Record<string, unknown>) => events.push({...event, seq: seq++});
    const response = (status: string, output: unknown[], usage: unknown) =>
        ({id: result.id, object: 'response', status, model: result.model, output, usage});
    push({type: 'response.created', response: response('in_progress', [], null)});
    if (result.text.trim() || result.calls.length === 0) {
        const item = {id: result.id + '_msg', type: 'message', role: 'assistant', status: 'completed',
            content: [{type: 'output_text', text: result.text, annotations: []}]};
        push({type: 'response.output_item.added', output_index: index, item: {id: item.id, type: 'message', role: 'assistant', status: 'in_progress', content: []}});
        push({type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: result.text});
        push({type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text: result.text});
        push({type: 'response.output_item.done', output_index: index, item});
        output.push(item);
        index += 1;
    }
    for (const call of result.calls) {
        const item = {id: executorItemId(call.itemId ?? call.callId), type: 'function_call', status: 'completed', call_id: executorItemId(call.callId),
            name: call.name, arguments: call.arguments};
        push({type: 'response.output_item.added', output_index: index, item: {...item, status: 'in_progress', arguments: ''}});
        push({type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: call.arguments});
        push({type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: call.arguments});
        push({type: 'response.output_item.done', output_index: index, item});
        output.push(item);
        index += 1;
    }
    const cached = result.usage.cacheHitTokens ?? 0;
    push({type: 'response.completed', response: response('completed', output,
        {input_tokens: result.usage.inputTokens, input_tokens_details: {cached_tokens: cached}, output_tokens: result.usage.outputTokens,
            output_tokens_details: {reasoning_tokens: 0}, total_tokens: result.usage.inputTokens + result.usage.outputTokens})});
    // The client closes on response.completed; the paid planner lane's own builder ends there too,
    // without a [DONE] sentinel, and this one keeps the same convention.
    return events.map(event => 'event: ' + String(event.type) + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
}