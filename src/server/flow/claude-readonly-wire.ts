import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {concreteMagpieRoute, type MagpieConcreteRoute} from '../magpie-route.js';
import {DomainError} from '../security.js';
import {parseGatewayJson} from '../gateway-tool-arguments.js';
import {CodexPlannerStream} from './codex-planner-stream.js';
import {paidCodexResponsesBody} from './paid-codex-responses.js';
import type {NativeUsage} from '../native-budget.js';

type Row = Record<string, unknown>;
type Limits = {model:string; prompt:string; instructions:string; maxInputTokens:number; maxOutputTokens:number};
type BoundAccount = Pick<MagpieConcreteRoute,'provider'|'authentication'|'authRef'|'accountRef'|'upstreamAccountRef'> & {
    capabilities?: readonly {model:string;protocol:string}[];
};
export interface ClaudeReadOnlyContext {
    route:MagpieConcreteRoute; role:string; accounts:readonly BoundAccount[]; limits:Readonly<Limits>;
    assertCurrent():void; assertSafe(value:string):void; signal:AbortSignal;
}
export interface ClaudeMessagesIngress {method:string; path:string; version:string; contentType:string; body:string}
type Completion = {id:string; text:string; usage:NativeUsage; observedModel:string};
const requestBytes = 262144;
const responseBytes = 2_000_000;
const integer = (n:unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (v:unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v:unknown, keys:readonly string[]): v is Row => object(v) && Object.keys(v).every(key => keys.includes(key));
const id = (s:unknown): s is string => typeof s === 'string' && /^[-A-Za-z0-9_]{1,200}$/.test(s);
function fail(code:string):never {throw new DomainError(code,code==='CLAUDE_MESSAGES_REQUEST_INVALID'?400:502);}
function invalid():never {return fail('MODEL_GATEWAY_COMPLETION_INVALID');}
function badRequest():never {return fail('CLAUDE_MESSAGES_REQUEST_INVALID');}
function unknown():never {return fail('NATIVE_USAGE_UNKNOWN');}

function textBlock(block:unknown): block is {type:"text";text:string} {
    if (!only(block, ['type','text','cache_control']) || block.type !== 'text' || typeof block.text !== 'string') return false;
    const cache = block.cache_control;
    return cache === undefined || (only(cache, ['type']) && cache.type === 'ephemeral');
}

function frozenChat(request:unknown, model:string, limits:Limits) {
    if (!only(request, ['model','messages','system','tools','metadata','max_tokens','output_config','stream']) ||
        request.model !== model || request.stream !== true || !Array.isArray(request.tools) || request.tools.length ||
        !Array.isArray(request.messages) || request.messages.length !== 1 || !integer(request.max_tokens) || !request.max_tokens) badRequest();
    if (!Array.isArray(request.system) || !request.system.length || !request.system.every(textBlock)) badRequest();
    if (request.metadata !== undefined && (!only(request.metadata, ['user_id']) || typeof request.metadata.user_id !== 'string')) badRequest();
    if (request.output_config !== undefined && (!only(request.output_config, ['effort']) || request.output_config.effort !== 'high')) badRequest();
    const [message] = request.messages;
    if (!only(message, ['role','content']) || message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1 ||
        !textBlock(message.content[0]) || message.content[0].text !== limits.prompt) badRequest();
    return {model, messages:[{role:'system',content:limits.instructions},{role:'user',content:limits.prompt}],
        max_tokens:Math.min(request.max_tokens, limits.maxOutputTokens), stream:false};
}

function checkCacheWrites(usage:unknown, details:unknown) {
    for (const value of [usage,details]) {
        if (!object(value)) continue;
        for (const key of ['cache_creation_input_tokens','cache_write_tokens','cache_creation_tokens']) {
            if (Object.hasOwn(value,key) && value[key] !== 0) unknown();
        }
    }
}

function chatCompletion(doc:unknown, model:string, qualifiedModel:string):Completion {
    if (!object(doc) || doc.object !== 'chat.completion' || !id(doc.id) || (doc.model !== model && doc.model !== qualifiedModel) ||
        doc.error != null || !Array.isArray(doc.choices) || doc.choices.length !== 1) invalid();
    const [choice] = doc.choices;
    if (!only(choice,['index','finish_reason','message','logprobs']) || choice.index !== 0 || choice.finish_reason !== 'stop') invalid();
    const msg = choice.message;
    if (!only(msg,['role','content','refusal','reasoning_content','tool_calls','function_call','annotations']) || msg.role !== 'assistant' ||
        typeof msg.content !== 'string' || !msg.content.trim() || msg.refusal != null || msg.tool_calls != null || msg.function_call != null ||
        (msg.reasoning_content != null && typeof msg.reasoning_content !== 'string') || (msg.annotations != null && (!Array.isArray(msg.annotations) || msg.annotations.length))) invalid();
    const u = doc.usage;
    if (!object(u) || !integer(u.prompt_tokens) || !integer(u.completion_tokens)) unknown();
    if (u.prompt_tokens_details !== undefined && !object(u.prompt_tokens_details)) unknown();
    checkCacheWrites(u,u.prompt_tokens_details);
    const hits = [u.prompt_tokens_details?.cached_tokens,u.prompt_cache_hit_tokens].filter(n => n !== undefined);
    const cached = hits[0];
    const total = u.prompt_tokens + u.completion_tokens;
    const inputTokens = u.prompt_tokens;
    if (!integer(cached) || !hits.every(n => n === cached && cached <= inputTokens) || !integer(total) ||
        (u.total_tokens !== undefined && u.total_tokens !== total) ||
        (u.prompt_cache_miss_tokens !== undefined && u.prompt_cache_miss_tokens !== u.prompt_tokens - cached)) unknown();
    return {id:doc.id,text:msg.content,observedModel:doc.model,usage:{inputTokens:u.prompt_tokens,outputTokens:u.completion_tokens,cacheHitTokens:cached}};
}

// Require one closed text item. Reasoning substreams need a separate reconciler. The shared
// observer verifies response/model identity, deltas vs terminal text and usage.
function responsesCompletion(raw:string, observer:CodexPlannerStream, safe:(value:string)=>void):Completion {
    if (/\r(?!\n)/.test(raw)) invalid();
    const frames = raw.replaceAll('\r\n','\n').split('\n\n');
    if (frames.pop() !== '') invalid();
    let result:ReturnType<CodexPlannerStream['observe']>, responseId:unknown, observedModel:unknown;
    let nextSequence:number|undefined, sequenced:boolean|undefined, active:Row|undefined;
    let itemIndex = 0, phase = 'created', messageDone = false;
    const closed:Row[] = [];
    for (const frame of frames) {
        if (!frame) continue;
        let name; const data = [];
        for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:') && name === undefined) name = line.slice(6).replace(/^ /,'');
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
            else invalid();
        }
        if (!data.length) {if (name !== undefined) invalid(); continue;}
        if (result) invalid();
        const event = parseGatewayJson(data.join('\n'),safe);
        if (!object(event) || typeof event.type !== 'string' || (name !== undefined && name !== event.type)) invalid();
        const {type} = event;
        const item = object(event.item) ? event.item : undefined;
        const response = object(event.response) ? event.response : undefined;
        if (sequenced === undefined) sequenced = Object.hasOwn(event,'sequence_number');
        if (sequenced !== Object.hasOwn(event,'sequence_number')) invalid();
        if (sequenced) {
            if (!integer(event.sequence_number) || (nextSequence !== undefined && event.sequence_number !== nextSequence)) invalid();
            nextSequence = event.sequence_number + 1;
        }
        if (type === 'response.created') {
            if (phase !== 'created' || response?.error != null || response?.incomplete_details != null) invalid();
            phase = 'between';
        } else if (type === 'response.in_progress' || type === 'response.metadata') {
            if (phase === 'created' || response?.error != null || response?.incomplete_details != null || (event.response_id !== undefined && event.response_id !== responseId)) invalid();
        } else if (type === 'response.output_item.added') {
            if (phase !== 'between' || event.output_index !== itemIndex || !id(item?.id) || closed.some(i => i.id === item?.id)) invalid();
            active = item;
            if (active.type === 'message' && !messageDone && active.status === 'in_progress') phase = 'message';
            else invalid();
        } else if (type === 'response.completed') {
            if (phase !== 'between' || !messageDone || response?.incomplete_details != null || !isDeepStrictEqual(response?.output,closed)) invalid();
            const usage = response?.usage;
            checkCacheWrites(usage,object(usage) ? usage.input_tokens_details : undefined);
        } else {
            if (!active || event.output_index !== itemIndex) invalid();
            if (type === 'response.output_item.done') {
                if (phase !== 'partDone' || item?.id !== active.id || item?.type !== active.type) invalid();
                if (active.type === 'message') messageDone = true;
                if (!item) invalid();
                closed.push(item); active = undefined; itemIndex++; phase = 'between';
            } else {
                if (event.item_id !== active.id) invalid();
                if (phase === 'message' && type === 'response.content_part.added') phase = 'text';
                else if (phase === 'text' && type === 'response.output_text.delta') { /* observer assembles text */ }
                else if (phase === 'text' && type === 'response.output_text.done') phase = 'textDone';
                else if (phase === 'textDone' && type === 'response.content_part.done') phase = 'partDone';
                else invalid();
            }
        }
        if (type === 'response.created') responseId = response?.id;
        result = observer.observe(event);
        if (result) observedModel = response?.model;
    }
    if (!result) invalid();
    if (!result.usage) unknown();
    if (typeof observedModel !== 'string') invalid();
    return {...result,usage:result.usage,observedModel};
}

function messagesSse(model:string, result:Completion) {
    const {inputTokens,outputTokens,cacheHitTokens} = result.usage;
    const events:Array<[string,Row]> = [
        ['message_start',{message:{id:result.id,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,
            usage:{input_tokens:inputTokens-cacheHitTokens,cache_creation_input_tokens:0,cache_read_input_tokens:cacheHitTokens,output_tokens:0}}}],
        ['content_block_start',{index:0,content_block:{type:'text',text:''}}],
        ['content_block_delta',{index:0,delta:{type:'text_delta',text:result.text}}],
        ['content_block_stop',{index:0}],
        ['message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:outputTokens}}],
        ['message_stop',{}],
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
export function createClaudeReadOnlyExchange({route:rawRoute,role,accounts,limits,assertCurrent,assertSafe,signal}:ClaudeReadOnlyContext) {
    const route = concreteMagpieRoute(rawRoute);
    const {model,protocol} = route;
    const chat = protocol === 'chat-completions';
    if (route.runtime !== 'claude' || !['planner2','reviewer'].includes(role) || route.authentication !== 'api_key' ||
        (!chat && protocol !== 'openai-responses') || !Array.isArray(accounts as unknown)) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    const matches = accounts.filter(a => (['provider','authentication','authRef','accountRef','upstreamAccountRef'] as const).every(key => a[key] === route[key]));
    if (matches.length !== 1 || !Array.isArray(matches[0].capabilities) ||
        matches[0].capabilities.some(c => c.model === model && c.protocol === 'anthropic-messages') ||
        matches[0].capabilities.filter(c => c.model === model && c.protocol === protocol).length !== 1) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    if (!only(limits,['model','instructions','prompt','maxInputTokens','maxOutputTokens']) || limits.model !== model ||
        ![limits.prompt,limits.instructions].every(s => typeof s === 'string' && s.trim()) ||
        !integer(limits.maxOutputTokens) || limits.maxOutputTokens < 1 || limits.maxOutputTokens > 16000 ||
        !integer(limits.maxInputTokens) || !limits.maxInputTokens) badRequest();
    limits = Object.freeze({...limits});
    const qualifiedModel = route.provider+'/'+model;
    const current = () => {signal.throwIfAborted(); synchronous(assertCurrent());};
    function synchronous(result:unknown) {
        if (result !== undefined) {if (result instanceof Promise) void result.catch(()=>{}); fail('MODEL_GATEWAY_BINDING_INVALID');}
    }
    const safe = (value:string) => synchronous(assertSafe(value));
    let used = false;
    return {prepare({method,path,version,contentType,body:raw}:ClaudeMessagesIngress) {
        current();
        if (used) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
        used = true;
        if (method !== 'POST' || !['/v1/messages','/v1/messages?beta=true'].includes(path) || version !== '2023-06-01' ||
            typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') badRequest();
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > requestBytes) badRequest();
        const chatBody = frozenChat(parseGatewayJson(raw,safe),model,limits);
        const maxOutputTokens = chatBody.max_tokens;
        const body = chat ? chatBody : paidCodexResponsesBody({model,stream:true,store:false,max_output_tokens:maxOutputTokens,
            input:[{type:'message',role:'user',content:[{type:'input_text',text:limits.prompt}]}]},limits);
        const wire = JSON.stringify({...body, model:qualifiedModel});
        if (Buffer.byteLength(wire)>requestBytes) badRequest();
        safe(wire); safe(limits.instructions);
        let consumed = false;
        return Object.freeze({path:chat?'/v1/chat/completions':'/v1/responses',body:wire,maxOutputTokens,
            async complete(response:Response) {
                current();
                if (consumed) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
                consumed = true;
                const bytes = await readBounded(response,chat?'application/json':'text/event-stream',signal);
                const raw = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
                safe(raw);
                const result = chat ? chatCompletion(parseGatewayJson(raw,safe),model,qualifiedModel) :
                    responsesCompletion(raw,new CodexPlannerStream(model,{qualifiedModel,maxInputTokens:limits.maxInputTokens,maxOutputTokens}),safe);
                const usage = result.usage;
                if (!integer(usage.inputTokens + usage.outputTokens)) unknown();
                safe(result.text); safe(result.id); current();
                const responseSha256 = createHash('sha256').update(bytes).digest('hex');
                if (usage.inputTokens > limits.maxInputTokens || usage.outputTokens > maxOutputTokens) {
                    // The caller settles known excess usage before failing the run. Never attach text.
                    throw Object.assign(new DomainError('NATIVE_USAGE_BOUND_EXCEEDED',502),{usage,responseSha256});
                }
                return Object.freeze({responseId:result.id,model,observedUpstreamModel:result.observedModel,usage:Object.freeze(usage),responseSha256,
                    outputTextHash:createHash('sha256').update(result.text.trim()).digest('hex'),finishReason:'end_turn',
                    sse:messagesSse(model,result)});
            },
        });
    }};
}
