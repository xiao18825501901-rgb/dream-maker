import {createHash} from 'node:crypto';

import {concreteMagpieRoute,type MagpieConcreteRoute} from '../magpie-route.js';
import {DomainError} from '../security.js';
import {parseGatewayJson} from '../gateway-tool-arguments.js';
import type {NativeUsage} from '../native-budget.js';

/**
 * The Codex read-only translation lane: Responses ingress, Anthropic Messages upstream.
 *
 * The pinned Codex CLI speaks only `wire_api = "responses"`. A planner2/reviewer whose
 * account declares only the native Messages wire is served here instead of the frozen
 * Responses passthrough: this lane accepts the controller-frozen Codex turn, forwards one
 * tool-free Messages request, and rebuilds the upstream Messages stream as the Responses
 * event sequence the CLI consumes.
 *
 * Nothing here authors prompt text. The controller froze the system text and the single
 * user turn; the lane verifies both against that freeze and translates only the envelope.
 * The request model is provider-qualified because the owned Magpie admits exactly
 * `provider/model` in the body before it strips the prefix for the provider hop.
 */

type Row = Record<string, unknown>;
export interface CodexSupervisorLimits {model:string;instructions:string;maxInputTokens:number;maxOutputTokens:number}
type BoundAccount = Pick<MagpieConcreteRoute,'provider'|'authentication'|'authRef'|'accountRef'|'upstreamAccountRef'> & {
    capabilities?: readonly {model:string;protocol:string}[];
};
export interface CodexSupervisorContext {
    route:MagpieConcreteRoute; role:string; accounts:readonly BoundAccount[]; limits:Readonly<CodexSupervisorLimits>;
    /** The Codex runner reports its exact wire prompt once the thread is bound. */
    prompt:()=>string;
    assertCurrent():void; assertSafe(value:string):void; signal:AbortSignal;
}
export interface CodexResponsesIngress {method:string; path:string; contentType:string; body:string}
type Completion = {id:string; text:string; usage:NativeUsage; observedModel:string};
const requestBytes = 262144;
const responseBytes = 2_000_000;
const integer = (n:unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (v:unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v:unknown, keys:readonly string[]): v is Row => object(v) && Object.keys(v).every(key => keys.includes(key));
const id = (s:unknown): s is string => typeof s === 'string' && /^[-A-Za-z0-9_]{1,200}$/.test(s);
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
function fail(code:string):never {throw new DomainError(code,code==='CODEX_RESPONSES_REQUEST_INVALID'?400:502);}
function invalid():never {return fail('MODEL_GATEWAY_COMPLETION_INVALID');}
function badRequest():never {return fail('CODEX_RESPONSES_REQUEST_INVALID');}
function unknown():never {return fail('NATIVE_USAGE_UNKNOWN');}

const messageKeys = ['id','type','role','model','content','stop_reason','stop_sequence','usage'] as const;
const turnKeys = ['model','input','store','stream','max_output_tokens','text','instructions','include','reasoning','prompt_cache_key','client_metadata','parallel_tool_calls','tool_choice','tools'] as const;
const startUsageKeys = ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'] as const;
const deltaUsageKeys = ['output_tokens','input_tokens','cache_read_input_tokens','cache_creation_input_tokens'] as const;

function inputText(part:unknown): part is {type:'input_text';text:string} {
    return only(part,['type','text']) && part.type === 'input_text' && typeof part.text === 'string';
}

/** Exactly one frozen user text, at most one system text, and no declared tool. */
function frozenTurn(request:unknown, model:string, prompt:string, cap:number):number {
    if (!only(request,turnKeys) || request.model !== model || request.store !== false || request.stream !== true) badRequest();
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length)) badRequest();
    if (request.tool_choice !== undefined && request.tool_choice !== 'auto' && request.tool_choice !== 'none') badRequest();
    if (request.instructions !== undefined && typeof request.instructions !== 'string') badRequest();
    // Codex sends its reasoning request as an object; only the declared switches are accepted.
    if (request.reasoning !== undefined && (!only(request.reasoning,['effort','summary','generate_summary']) ||
        (request.reasoning.effort !== undefined && typeof request.reasoning.effort !== 'string'))) badRequest();
    // Codex declares structured output through `text.format`. The Messages wire has no such
    // field, so the declaration is shape-checked here and then dropped: the frozen prompt still
    // carries the schema and the controller validates the parsed document before it becomes a
    // plan or a review. Only the CLI's own json_schema shape is accepted.
    if (request.text !== undefined) {
        if (!only(request.text,['verbosity','format'])) badRequest();
        if (request.text.verbosity !== undefined && !['low','medium','high'].includes(String(request.text.verbosity))) badRequest();
        if (request.text.format !== undefined) {
            const format = request.text.format;
            if (!only(format,['type','strict','name','schema']) || format.type !== 'json_schema' || format.strict !== true ||
                typeof format.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(format.name) || !object(format.schema)) badRequest();
        }
    }
    if (request.max_output_tokens !== undefined && (!integer(request.max_output_tokens) || !request.max_output_tokens)) badRequest();
    if (!Array.isArray(request.input) || !request.input.length) badRequest();
    let system = 0, user = 0;
    for (const raw of request.input) {
        const item = object(raw) ? raw : badRequest();
        // Codex declares repository tool groups as a developer item. This lane exposes no tool.
        if (item.type === 'additional_tools') {
            if (item.role !== 'developer' || !only(item,['type','role','id','tools']) || !Array.isArray(item.tools)) badRequest();
            continue;
        }
        if (!only(item,['type','role','id','content']) || item.type !== 'message' ||
            (item.role !== 'developer' && item.role !== 'system' && item.role !== 'user') ||
            !Array.isArray(item.content) || !item.content.length || !item.content.every(inputText)) badRequest();
        if (item.role !== 'user') {system++; continue;}
        user++;
        // A Codex turn carries one frozen user text; a substring or a second part is not it.
        if (item.content.length !== 1 || item.content[0].text !== prompt) badRequest();
    }
    if (system > 1 || user !== 1) badRequest();
    return request.max_output_tokens === undefined ? cap : Math.min(Number(request.max_output_tokens),cap);
}

/** One text answer on the Messages wire; this lane never charges a cache write. */
function messageStart(row:Row, model:string, qualifiedModel:string) {
    const message = object(row.message) ? row.message : invalid();
    if (!only(message,messageKeys) || !id(message.id) || message.type !== 'message' || message.role !== 'assistant' ||
        typeof message.model !== 'string' || (message.model !== model && message.model !== qualifiedModel)) invalid();
    if (!Array.isArray(message.content) || message.content.length) invalid();
    if (message.stop_reason !== null && message.stop_reason !== undefined) invalid();
    const usage = object(message.usage) ? message.usage : unknown();
    if (!only(usage,startUsageKeys) || !integer(usage.input_tokens) || !integer(usage.output_tokens)) unknown();
    const cacheRead = usage.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens;
    const cacheWrite = usage.cache_creation_input_tokens === undefined ? 0 : usage.cache_creation_input_tokens;
    if (!integer(cacheRead) || cacheRead > usage.input_tokens) unknown();
    if (cacheWrite !== 0) unknown();
    return {id:message.id, model:message.model, input:usage.input_tokens, cacheRead, output:usage.output_tokens};
}

/**
 * Validate the whole upstream transcript, then read it. Order, identity, terminal frame and
 * the usage convention are the ones claude-readonly-wire already applies in the other
 * direction: input is the charged prompt including cache reads, output is the final count.
 */
function messagesCompletion(raw:string, model:string, qualifiedModel:string, safe:(value:string)=>void):Completion {
    if (/\r(?!\n)/.test(raw)) invalid();
    const frames = raw.replaceAll('\r\n','\n').split('\n\n');
    // A stream that does not end on a frame boundary carries trailing bytes.
    if (frames.pop() !== '') invalid();
    let start:{id:string;model:string;input:number;cacheRead:number;output:number}|undefined;
    let outputTokens:number|undefined, text = '', phase = 'start', stopped = false;
    for (const frame of frames) {
        if (!frame) continue;
        // Nothing may follow the terminal frame.
        if (stopped) invalid();
        let name; const data:string[] = [];
        for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:') && name === undefined) name = line.slice(6).replace(/^ /,'');
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
            else invalid();
        }
        if (!data.length) {if (name !== undefined) invalid(); continue;}
        const event = parseGatewayJson(data.join('\n'),safe);
        if (!object(event) || typeof event.type !== 'string' || (name !== undefined && name !== event.type)) invalid();
        const type = event.type;
        if (type === 'ping') continue;
        if (type === 'message_start') {
            if (phase !== 'start') invalid();
            start = messageStart(event,model,qualifiedModel);
            phase = 'open';
        } else if (type === 'content_block_start') {
            if (phase !== 'open' || event.index !== 0 || !only(event.content_block,['type','text']) ||
                event.content_block.type !== 'text' || event.content_block.text !== '') invalid();
            phase = 'text';
        } else if (type === 'content_block_delta') {
            if (phase !== 'text' || event.index !== 0 || !only(event.delta,['type','text']) ||
                event.delta.type !== 'text_delta' || typeof event.delta.text !== 'string') invalid();
            text += event.delta.text;
        } else if (type === 'content_block_stop') {
            if (phase !== 'text' || event.index !== 0) invalid();
            phase = 'textDone';
        } else if (type === 'message_delta') {
            if (phase !== 'textDone' || !start || !only(event,['type','delta','usage'])) invalid();
            if (!only(event.delta,['stop_reason','stop_sequence']) || event.delta.stop_reason !== 'end_turn' ||
                (event.delta.stop_sequence !== null && event.delta.stop_sequence !== undefined)) invalid();
            const usage = object(event.usage) ? event.usage : unknown();
            if (!only(usage,deltaUsageKeys) || !integer(usage.output_tokens)) unknown();
            // A repeated counter must agree with message_start, never drift.
            for (const key of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens'] as const) {
                if (!Object.hasOwn(usage,key)) continue;
                const expected = key === 'input_tokens' ? start.input : key === 'cache_read_input_tokens' ? start.cacheRead : 0;
                if (usage[key] !== expected) unknown();
            }
            if (usage.output_tokens < start.output) unknown();
            outputTokens = usage.output_tokens;
            phase = 'closed';
        } else if (type === 'message_stop') {
            if (phase !== 'closed' || !only(event,['type'])) invalid();
            stopped = true;
        } else invalid();
    }
    // A missing terminal frame is a truncated answer, not a short one.
    if (!stopped || !start) invalid();
    if (outputTokens === undefined || !integer(outputTokens)) unknown();
    if (!text.trim()) invalid();
    const inputTokens = start.input + start.cacheRead;
    if (!integer(inputTokens)) unknown();
    return {id:start.id,text,observedModel:start.model,usage:{inputTokens,outputTokens,cacheHitTokens:start.cacheRead}};
}

/** The Responses frames the pinned CLI accepts, in the order it accepts them. */
function responsesSse(model:string, result:Completion) {
    const {inputTokens,outputTokens,cacheHitTokens} = result.usage;
    const envelope = {object:'response',created_at:Math.floor(Date.now() / 1000),model};
    const responseId = 'resp_' + digest(result.id).slice(0,24);
    const itemId = 'msg_' + digest(result.id).slice(0,20);
    const part = {type:'output_text',text:'',annotations:[]};
    const item = {type:'message',role:'assistant',id:itemId,status:'completed',content:[{...part,text:result.text}]};
    const events:Array<[string,Row]> = [
        ['response.created',{response:{...envelope,id:responseId,status:'in_progress',output:[]}}],
        ['response.output_item.added',{output_index:0,item:{type:'message',role:'assistant',id:itemId,status:'in_progress',content:[]}}],
        ['response.content_part.added',{item_id:itemId,output_index:0,content_index:0,part}],
        ['response.output_text.delta',{item_id:itemId,output_index:0,content_index:0,delta:result.text}],
        ['response.output_text.done',{item_id:itemId,output_index:0,content_index:0,text:result.text}],
        ['response.content_part.done',{item_id:itemId,output_index:0,content_index:0,part:{...part,text:result.text}}],
        ['response.output_item.done',{output_index:0,item}],
        ['response.completed',{response:{...envelope,id:responseId,status:'completed',output:[item],
            usage:{input_tokens:inputTokens,output_tokens:outputTokens,total_tokens:inputTokens+outputTokens,
                input_tokens_details:{cached_tokens:cacheHitTokens}}}}],
    ];
    return events.map(([type,fields]) => 'event: '+type+'\ndata: '+JSON.stringify({type,...fields})+'\n\n').join('');
}

async function readBounded(response:Response, mediaType:string, signal:AbortSignal) {
    if (response.status !== 200 || response.redirected || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mediaType || !response.body) {
        await response.body?.cancel(); invalid();
    }
    const reader = response.body.getReader();
    const abort = () => {void reader.cancel().catch(()=>{});};
    signal.addEventListener('abort',abort,{once:true});
    const bytes = Buffer.allocUnsafe(responseBytes);
    let length = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array) || chunk.value.length > responseBytes - length) fail('MODEL_GATEWAY_RESPONSE_LIMIT');
            bytes.set(chunk.value,length); length += chunk.value.length;
        }
        return bytes.subarray(0,length);
    } catch (error) {await reader.cancel().catch(()=>{}); throw error;}
    finally {signal.removeEventListener('abort',abort);reader.releaseLock();}
}

/** Instantiate once per controller dispatch, after the selected account and role are pinned. */
export function createCodexSupervisorExchange({route:rawRoute,role,accounts,limits,prompt,assertCurrent,assertSafe,signal}:CodexSupervisorContext) {
    const route = concreteMagpieRoute(rawRoute);
    const {model,protocol} = route;
    if (route.runtime !== 'codex' || (role !== 'planner2' && role !== 'reviewer') || route.authentication !== 'api_key' ||
        protocol !== 'anthropic-messages' || !Array.isArray(accounts as unknown) || typeof prompt !== 'function')
        fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    // The exact selected account must declare this wire for this model and no Responses alternative.
    const matches = accounts.filter(a => (['provider','authentication','authRef','accountRef','upstreamAccountRef'] as const).every(key => a[key] === route[key]));
    if (matches.length !== 1 || !Array.isArray(matches[0].capabilities) ||
        matches[0].capabilities.some(c => c.model === model && c.protocol === 'openai-responses') ||
        matches[0].capabilities.filter(c => c.model === model && c.protocol === protocol).length !== 1) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    if (!only(limits,['model','instructions','maxInputTokens','maxOutputTokens']) || limits.model !== model ||
        typeof limits.instructions !== 'string' || !limits.instructions.trim() ||
        !integer(limits.maxOutputTokens) || limits.maxOutputTokens < 1 || limits.maxOutputTokens > 16000 ||
        !integer(limits.maxInputTokens) || !limits.maxInputTokens) badRequest();
    const frozen = Object.freeze({...limits});
    const qualifiedModel = route.provider+'/'+model;
    const current = () => {signal.throwIfAborted(); synchronous(assertCurrent());};
    function synchronous(result:unknown) {
        if (result !== undefined) {if (result instanceof Promise) void result.catch(()=>{}); fail('MODEL_GATEWAY_BINDING_INVALID');}
    }
    const safe = (value:string) => synchronous(assertSafe(value));
    let used = false;
    return {prepare({method,path,contentType,body:raw}:CodexResponsesIngress) {
        current();
        if (used) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
        used = true;
        // Codex appends nothing to the fixed Responses path of its configured base URL.
        if (method !== 'POST' || path !== '/v1/responses' ||
            typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') badRequest();
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > requestBytes) badRequest();
        const frozenPrompt = prompt();
        if (typeof frozenPrompt !== 'string' || !frozenPrompt.trim()) badRequest();
        const maxOutputTokens = frozenTurn(parseGatewayJson(raw,safe),model,frozenPrompt,frozen.maxOutputTokens);
        // The Messages wire is Anthropic-shaped: one system block, one user text block.
        const body = JSON.stringify({model:qualifiedModel,stream:true,max_tokens:maxOutputTokens,
            system:[{type:'text',text:frozen.instructions}],
            messages:[{role:'user',content:[{type:'text',text:frozenPrompt}]}]});
        if (Buffer.byteLength(body) > requestBytes) badRequest();
        safe(body); safe(frozen.instructions); safe(frozenPrompt);
        let consumed = false;
        return Object.freeze({path:'/v1/messages',body,maxOutputTokens,
            async complete(response:Response) {
                current();
                if (consumed) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
                consumed = true;
                const bytes = await readBounded(response,'text/event-stream',signal);
                const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
                safe(text);
                const result = messagesCompletion(text,model,qualifiedModel,safe);
                const usage = result.usage;
                if (!integer(usage.inputTokens + usage.outputTokens)) unknown();
                safe(result.text); safe(result.id); current();
                const responseSha256 = digest(text);
                if (usage.inputTokens > frozen.maxInputTokens || usage.outputTokens > maxOutputTokens) {
                    // The caller settles known excess usage before failing the run. Never attach text.
                    throw Object.assign(new DomainError('NATIVE_USAGE_BOUND_EXCEEDED',502),{usage,responseSha256});
                }
                return Object.freeze({responseId:result.id,model,observedUpstreamModel:result.observedModel,usage:Object.freeze(usage),responseSha256,
                    outputTextHash:createHash('sha256').update(result.text.trim()).digest('hex'),finishReason:'end_turn',
                    sse:responsesSse(model,result)});
            },
        });
    }};
}
