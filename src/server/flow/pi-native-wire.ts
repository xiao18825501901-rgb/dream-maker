import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '../security.js';

export interface PiNativeLimits {
    protocol: 'openai-responses' | 'anthropic-messages';
    model: string;
    /** Exact model on the native response envelope (can be provider-qualified). */
    responseModel?: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    tools: readonly string[];
    prompt: string;
    system?: string;
    promptCacheKey?: string;
}
/**
 * The controller's own instruction block for the Anthropic wire. The Go ingress requires a
 * system block on that wire, and the executor's frozen system prompt may be absent, so a fixed
 * controller-authored line is used instead of anything the CLI supplied.
 */
export const PI_NATIVE_CONTROLLER_SYSTEM = 'Dream Maker controlled executor turn; tools are mediated by the controller.';
export interface PiNativeToolCall { itemId?: string; callId: string; name: string; arguments: string }
/** Supply only completed calls and results observed by the controller's tool broker. */
export interface PiNativeToolTurn extends PiNativeToolCall { output: string }
export interface PiNativeReply {
    id: string; model: string; text: string; toolCall: PiNativeToolCall | null;
    usage: {inputTokens: number; outputTokens: number; cacheHitTokens: number};
    usageLimitExceeded: boolean;
    sse: string;
}

type Obj = Record<string, unknown>;
const maxBytes = 2 * 1024 * 1024;
const ephemeral = {type: 'ephemeral'};
const invalid = (): never => { throw new DomainError('PI_NATIVE_WIRE_INVALID', 400); };
function check(condition: unknown): asserts condition { if (!condition) invalid(); }
function object(x: unknown): Obj {
    check(x !== null && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype);
    return x as Obj;
}
function list(x: unknown): unknown[] { check(Array.isArray(x)); return x; }
function same(x: unknown, expected: unknown) { check(isDeepStrictEqual(x, expected)); }
function string(x: unknown, max = maxBytes): string { check(typeof x === 'string' && Buffer.byteLength(x) <= max); return x; }
function identifier(x: unknown): string { check(typeof x === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(x)); return x; }
function count(x: unknown): number { check(typeof x === 'number' && Number.isSafeInteger(x) && x >= 0); return x; }
function keys(o: Obj, allowed: string[]) { check(Object.keys(o).every(k => allowed.includes(k))); }
const fields: Record<string, {required: string[]; optional?: string[]}> = {
    desk_read: {required: ['path']}, desk_search: {required: ['text']},
    desk_write: {required: ['path', 'content'], optional: ['expected_sha']},
    desk_edit: {required: ['path', 'old_text', 'new_text'], optional: ['expected_sha']},
    desk_run: {required: ['entry'], optional: ['runtime', 'args', 'stdin']},
};
/**
 * The complete read-only desk tool set, and the one authority for "what may a planner2 or reviewer
 * Pi turn declare": the runner refuses any other name for those roles, the transport refuses a
 * read-only lane whose session limits widen past this list, and the gateway refuses the purpose.
 *
 * Why a frozen subset instead of declaring no tools at all: on this harness "no tools" is a
 * different lane, not a stricter version of this one. Pi's reply validator admits exactly one text
 * block or one tool call, its own shell/file tools are disabled (--no-builtin-tools), and every
 * tool it can hold is a broker-mediated desk_* intent that PiNativeSession already arbitrates one
 * call per turn. A read-only role that cannot read the workspace cannot plan or review it, so the
 * read-only pair is what the role actually needs; it also reuses the executor's existing
 * arbitration instead of adding a second, unused zero-tool code path through this validator.
 * desk_write, desk_edit and desk_run are never in this list, whatever the frozen permissions say.
 */
export const PI_READ_ONLY_TOOLS: readonly string[] = Object.freeze(['desk_read', 'desk_search']);
/** True when every declared name is one a read-only Pi role may hold. */
export function piReadOnlyToolsOnly(tools: readonly string[]): boolean {
    return tools.every(name => PI_READ_ONLY_TOOLS.includes(name));
}
function parameters(name: string) {
    check(Object.hasOwn(fields, name));
    const {required, optional = []} = fields[name];
    return {type: 'object', required, properties: Object.fromEntries([...required, ...optional].map(k =>
        [k, k === 'args' ? {type: 'array', items: {type: 'string'}} : {type: 'string'}]))};
}
function limitsValid(l: PiNativeLimits) {
    check(l.protocol === 'openai-responses' || l.protocol === 'anthropic-messages');
    check(string(l.model, 256).trim() && string(l.responseModel ?? l.model, 512).trim() && string(l.prompt, 400000).trim());
    check(count(l.maxInputTokens) > 0 && count(l.maxOutputTokens) > 0 && l.maxOutputTokens <= 16000);
    check(Array.isArray(l.tools) && l.tools.length <= Object.keys(fields).length && l.tools.every(n => Object.hasOwn(fields, n)) && new Set(l.tools).size === l.tools.length);
    if (l.system !== undefined) check(string(l.system, 128000).trim());
    if (l.promptCacheKey !== undefined) identifier(l.promptCacheKey);
}
/** JSON.parse resolves duplicate keys silently. Reject ambiguity even when keys use Unicode escapes. */
function uniqueJson(raw: string): unknown {
    const parsed: unknown = JSON.parse(raw);
    const stack: (Set<string> | null)[] = [];
    for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"\s*:?|[{}\[\]]/g)) {
        const token = match[0];
        if (token === '{' || token === '[') {
            check(stack.length < 32); stack.push(token === '{' ? new Set() : null);
        } else if (token === '}' || token === ']') stack.pop();
        else if (token.endsWith(':')) {
            const names = stack.at(-1), name: string = JSON.parse(token.slice(0,-1));
            check(names && !names.has(name)); names.add(name);
        }
    }
    return parsed;
}
function argumentsObject(raw: string, name: string, l: PiNativeLimits): Obj {
    check(l.tools.includes(name));
    let value: unknown;
    try { value = uniqueJson(string(raw, 512000)); } catch { return invalid(); }
    const args = object(value), schema = parameters(name);
    keys(args, Object.keys(schema.properties));
    check(schema.required.every(k => Object.hasOwn(args, k)));
    for (const [k, v] of Object.entries(args)) {
        if (k === 'args') { check(Array.isArray(v) && v.length <= 256); for (const s of v) string(s, 32768); }
        else string(v, 512000);
    }
    return args;
}
function declarations(value: unknown, l: PiNativeLimits): unknown[] {
    const tools = list(value), responses = l.protocol === 'openai-responses';
    same(tools.map(t => object(t).name).sort(), [...l.tools].sort());
    return tools.map((raw, i) => {
        const name = identifier(object(raw).name), schema = parameters(name);
        const description = name + ' (Dream Maker controlled project tool)';
        const expected = responses ? {type: 'function', name, description, parameters: schema} :
            {name, description, input_schema: schema, eager_input_streaming: true, ...(i === tools.length-1 ? {cache_control: ephemeral} : {})};
        same(raw, expected); return expected;
    });
}
/** Rebuild from the frozen selection and broker history. Unbound CLI system/cache data is discarded. */
export function piNativeRequestBody(raw: unknown, l: PiNativeLimits, history: readonly PiNativeToolTurn[] = []): Obj {
    limitsValid(l);
    check(history.length <= 63);
    const o = object(raw), responses = l.protocol === 'openai-responses';
    check(o.model === l.model && o.stream === true && Buffer.byteLength(JSON.stringify(o)) <= maxBytes);
    const tools = declarations(o.tools, l);
    const calls = new Set<string>(), items = new Set<string>();
    const replay: unknown[] = [];
    for (const [i, turn] of history.entries()) {
        const callId = identifier(turn.callId); check(!calls.has(callId)); calls.add(callId);
        const args = argumentsObject(turn.arguments, turn.name, l), output = string(turn.output, 512000);
        if (responses) {
            const id = identifier(turn.itemId); check(!items.has(id)); items.add(id);
            replay.push({type:'function_call', id, call_id:callId, name:turn.name, arguments:JSON.stringify(args)}, {type:'function_call_output', call_id:callId, output});
        } else {
            replay.push({role:'assistant', content:[{type:'tool_use', id:callId, name:turn.name, input:args}]},
                {role:'user', content:[{type:'tool_result', tool_use_id:callId, content:output, is_error:false, ...(i === history.length-1 ? {cache_control:ephemeral} : {})}]});
        }
    }
    if (responses) {
        keys(o, ['model','input','stream','prompt_cache_key','store','max_output_tokens','tools']);
        check(o.store === false && o.max_output_tokens === l.maxOutputTokens);
        if (o.prompt_cache_key !== undefined) identifier(o.prompt_cache_key);
        if (l.promptCacheKey !== undefined) same(o.prompt_cache_key, l.promptCacheKey);
        const [system, ...rest] = list(o.input), text = string(object(system).content, 128000);
        same(system, {role:'system',content:text}); if (l.system !== undefined) same(text, l.system);
        const input = [{role:'user', content:[{type:'input_text', text:l.prompt}]}, ...replay];
        same(rest, input);
        return {model:l.model, stream:true, store:false, max_output_tokens:l.maxOutputTokens, tools,
            input:l.system === undefined ? input : [system, ...input], ...(l.promptCacheKey === undefined ? {} : {prompt_cache_key:l.promptCacheKey})};
    }
    keys(o, ['model','messages','max_tokens','stream','system','tools']); check(o.max_tokens === l.maxOutputTokens);
    const system = list(o.system), text = string(object(system[0]).text, 128000);
    same(system, [{type:'text', text, cache_control:ephemeral}]); if (l.system !== undefined) same(text, l.system);
    const messages = [{role:'user', content:[{type:'text', text:l.prompt, ...(history.length ? {} : {cache_control:ephemeral})}]}, ...replay];
    same(o.messages, messages);
    // The Go ingress accepts system only as text blocks (dm_pi.go piTextBlocks), never a bare string,
    // and requires the block to be present; l.system stays the frozen prompt when the controller has one.
    return {model:l.model, messages, max_tokens:l.maxOutputTokens, stream:true, tools, system:[{type:'text' as const, text:l.system ?? PI_NATIVE_CONTROLLER_SYSTEM}]};
}

// The subset supported by the pinned Pi executor is one text block or one tool call.
// Validate every frame, including repeated snapshots, before exposing any bytes to Pi.
class Events {
    private offset = 0;
    constructor(private readonly frames: Obj[]) {}
    peek() { return this.frames[this.offset]?.type; }
    take(type: string, attrs: Obj = {}, extra: string[] = []): Obj {
        const frame = this.frames[this.offset++];
        check(frame?.type === type); keys(frame, ['type','sequence_number', ...Object.keys(attrs), ...extra]);
        for (const [key, value] of Object.entries(attrs)) same(frame[key], value);
        return frame;
    }
    done() { check(this.offset === this.frames.length); }
    deltas(type: string, extract: () => string) {
        const pieces: string[] = [];
        while (this.peek() === type) pieces.push(extract());
        check(pieces.length > 0); return pieces.join('');
    }
}
function responseFrames(events: Events, l: PiNativeLimits) {
    const model = l.responseModel ?? l.model;
    const created = object(events.take('response.created', {}, ['response']).response), id = identifier(created.id);
    same(created, {object:'response', id, model, status:'in_progress', output:[], ...(created.usage === null ? {usage:null} : {})});
    const added = object(events.take('response.output_item.added', {output_index:0}, ['item']).item);
    const itemId = identifier(added.id), location = {item_id:itemId, output_index:0};
    let text = '', toolCall: PiNativeToolCall | null = null, completed: Obj;
    if (added.type === 'function_call') {
        const callId = identifier(added.call_id), name = identifier(added.name);
        check(l.tools.includes(name));
        const item = {type:'function_call', id:itemId, call_id:callId, name};
        same(added, {...item, status:'in_progress', arguments:''});
        const args = events.deltas('response.function_call_arguments.delta', () =>
            string(events.take('response.function_call_arguments.delta', location, ['delta']).delta));
        events.take('response.function_call_arguments.done', {...location, arguments:args});
        argumentsObject(args, name, l);
        toolCall = {itemId, callId, name, arguments:args}; completed = {...item, status:'completed', arguments:args};
    } else {
        const item = {type:'message', role:'assistant', id:itemId}, pos = {...location, content_index:0};
        const part = {type:'output_text', text:'', annotations:[]};
        same(added, {...item, status:'in_progress', content:[]});
        events.take('response.content_part.added', {...pos, part});
        text = events.deltas('response.output_text.delta', () => string(events.take('response.output_text.delta', pos, ['delta']).delta));
        check(text.trim()); events.take('response.output_text.done', {...pos, text});
        const finalPart = {...part, text}; events.take('response.content_part.done', {...pos, part:finalPart});
        completed = {...item, status:'completed', content:[finalPart]};
    }
    events.take('response.output_item.done', {output_index:0, item:completed});
    const final = object(events.take('response.completed', {}, ['response']).response), u = object(final.usage);
    same(final, {object:'response', id, model, status:'completed', output:[completed], usage:u});
    keys(u, ['input_tokens','output_tokens','total_tokens','input_tokens_details']);
    const inputTokens = count(u.input_tokens), outputTokens = count(u.output_tokens), details = object(u.input_tokens_details);
    const cacheHitTokens = count(details.cached_tokens); keys(details,['cached_tokens']);
    check(cacheHitTokens <= inputTokens && count(u.total_tokens) === inputTokens + outputTokens);
    return {id, model, text, toolCall, usage:{inputTokens,outputTokens,cacheHitTokens}};
}
function messageFrames(events: Events, l: PiNativeLimits) {
    const model = l.responseModel ?? l.model;
    const message = object(events.take('message_start', {}, ['message']).message), id = identifier(message.id), startUsage = object(message.usage);
    same(message,{id, type:'message', role:'assistant', model, content:[], stop_reason:null, stop_sequence:null, usage:startUsage});
    keys(startUsage,['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens']);
    const missed = count(startUsage.input_tokens), cacheHitTokens = count(startUsage.cache_read_input_tokens);
    check(count(startUsage.cache_creation_input_tokens) === 0);
    const initialOutput = count(startUsage.output_tokens), inputTokens = count(missed + cacheHitTokens);
    const start = object(events.take('content_block_start',{index:0},['content_block']).content_block);
    const isTool = start.type === 'tool_use';
    const name = isTool ? identifier(start.name) : '', callId = isTool ? identifier(start.id) : '';
    if (isTool) { check(l.tools.includes(name)); same(start,{type:'tool_use', id:callId, name, input:{}}); }
    else same(start,{type:'text',text:''});
    const data = events.deltas('content_block_delta', () => {
        const delta = object(events.take('content_block_delta',{index:0},['delta']).delta);
        const piece = string(isTool ? delta.partial_json : delta.text);
        same(delta, isTool ? {type:'input_json_delta', partial_json:piece} : {type:'text_delta', text:piece}); return piece;
    });
    let toolCall: PiNativeToolCall | null = null;
    if (isTool) { argumentsObject(data, name, l); toolCall = {callId, name, arguments:data}; }
    else check(data.trim());
    events.take('content_block_stop',{index:0});
    const u = object(events.take('message_delta', {delta:{stop_reason:isTool ? 'tool_use' : 'end_turn', stop_sequence:null}}, ['usage']).usage);
    keys(u,['output_tokens','input_tokens','cache_read_input_tokens','cache_creation_input_tokens']);
    for (const k of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens']) if (Object.hasOwn(u,k)) same(u[k],startUsage[k]);
    const outputTokens = count(u.output_tokens); check(outputTokens >= initialOutput);
    events.take('message_stop');
    return {id, model, text:isTool ? '' : data, toolCall, usage:{inputTokens,outputTokens,cacheHitTokens}};
}
async function readBounded(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
    const reader = stream.getReader(), chunks: Buffer[] = [], decoder = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
    const timeout = AbortSignal.timeout(120000), stop = signal ? AbortSignal.any([timeout,signal]) : timeout;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    let size = 0, ended = false;
    stop.addEventListener('abort',cancel,{once:true});
    try {
        for (;;) {
            stop.throwIfAborted(); const next = await reader.read(); stop.throwIfAborted();
            if (next.done) { ended = true; break; }
            size += next.value.byteLength; check(size <= maxBytes && chunks.length < 65536);
            chunks.push(Buffer.from(next.value));
        }
        return decoder.decode(Buffer.concat(chunks,size));
    } finally { stop.removeEventListener('abort',cancel); if (!ended) cancel(); reader.releaseLock(); }
}
/** Complete and verify through EOF. On a known overrun, return measured usage to the settler. */
export async function readPiNativeSse(stream: ReadableStream<Uint8Array>, l: PiNativeLimits, signal?: AbortSignal): Promise<PiNativeReply> {
    limitsValid(l);
    try {
        const sse = (await readBounded(stream,signal)).replaceAll('\r\n','\n');
        check(sse.endsWith('\n\n') && !sse.includes('\r'));
        const blocks = sse.slice(0,-2).split('\n\n'); check(blocks.length <= 4096);
        const frames = blocks.map((block,i) => {
            const lines = block.split('\n'); check(lines.length === 2 && lines[0].startsWith('event: ') && lines[1].startsWith('data: '));
            const f = object(uniqueJson(lines[1].slice(6))); check(f.type === lines[0].slice(7));
            if (Object.hasOwn(f,'sequence_number')) same(f.sequence_number,i);
            return f;
        });
        const events = new Events(frames);
        const r = l.protocol === 'openai-responses' ? responseFrames(events,l) : messageFrames(events,l);
        events.done();
        // Emit only the frames admitted by the protocol validator.
        const verified = frames.map(f => 'event: '+f.type+'\ndata: '+JSON.stringify(f)+'\n\n').join('');
        return {...r, sse:verified, usageLimitExceeded:r.usage.inputTokens > l.maxInputTokens || r.usage.outputTokens > l.maxOutputTokens};
    } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw new DomainError('PI_NATIVE_RESPONSE_INVALID',502);
    }
}
export function assertPiNativeReplySafe(reply: PiNativeReply, assertSafe: (value: string) => void): void {
    for (const value of [reply.sse, reply.id, reply.model, reply.text]) assertSafe(value);
    const call = reply.toolCall;
    if (call) {
        for (const value of [call.itemId, call.callId, call.name, call.arguments]) if (value !== undefined) assertSafe(value);
        for (const arg of Object.values(object(JSON.parse(call.arguments)))) {
            for (const value of Array.isArray(arg) ? arg : [arg]) assertSafe(string(value));
        }
    }
}
