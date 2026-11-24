import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {concreteMagpieRoute, type MagpieConcreteRoute} from '../magpie-route.js';
import {DomainError} from '../security.js';
import {parseGatewayJson} from '../gateway-tool-arguments.js';
import type {NativeUsage} from '../native-budget.js';

/**
 * The DSH planner2/reviewer translation lane.
 *
 * The pinned DSH SDK only speaks the native Messages wire, so a supervisor whose account
 * advertises Chat or Responses is served by this lane instead of the byte-identical native
 * passthrough. Unlike the read-only official CLI lanes, supervision cannot be tool-free:
 * both roles submit through exactly one terminal tool, so the lane freezes that single tool
 * together with its declared input_schema, forwards it in the upstream dialect, and turns the
 * one accepted tool call back into Messages SSE.
 *
 * Nothing here authors prompt text. The DSH host froze the system text and the single user
 * turn into the Messages request it sent; this lane validates and forwards them unchanged.
 */

type Row = Record<string, unknown>;
export type DshSupervisorLimits = {model:string; maxInputTokens:number; maxOutputTokens:number};
type FrozenTool = {name:string; description?:string; schema:Row};
type Bundle = {system:string; prompt:string; tool:FrozenTool; maxTokens:number};
type BoundAccount = Pick<MagpieConcreteRoute,'provider'|'authentication'|'authRef'|'accountRef'|'upstreamAccountRef'> & {
    capabilities?: readonly {model:string;protocol:string}[];
};
export interface DshSupervisorContext {
    route:MagpieConcreteRoute; role:string; accounts:readonly BoundAccount[]; limits:Readonly<DshSupervisorLimits>;
    assertCurrent():void; assertSafe(value:string):void; signal:AbortSignal;
}
export interface DshSupervisorIngress {method:string; path:string; version:string; contentType:string; body:string}
type Completion = {id:string; text:string; usage:NativeUsage; observedModel:string; tool?:{id:string;name:string;input:string}};
const requestBytes = 262144;
const responseBytes = 2_000_000;
const integer = (n:unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (v:unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v:unknown, keys:readonly string[]): v is Row => object(v) && Object.keys(v).every(key => keys.includes(key));
const id = (s:unknown): s is string => typeof s === 'string' && /^[-A-Za-z0-9_]{1,200}$/.test(s);
const toolName = (s:unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s);
function fail(code:string):never {throw new DomainError(code,code==='CLAUDE_MESSAGES_REQUEST_INVALID'?400:502);}
function invalid():never {return fail('MODEL_GATEWAY_COMPLETION_INVALID');}
function badRequest():never {return fail('CLAUDE_MESSAGES_REQUEST_INVALID');}
function unknown():never {return fail('NATIVE_USAGE_UNKNOWN');}
const row = (v:unknown):Row => object(v) ? v : invalid();
const list = (v:unknown):unknown[] => Array.isArray(v) ? v : invalid();

/** One text block, and nothing else, is the only content shape a frozen supervisor turn has. */
function textBlock(block:unknown): block is {type:'text';text:string} {
    return only(block,['type','text']) && block.type === 'text' && typeof block.text === 'string';
}

/** The SDK sends system as one joined string; a single text block carries the same text. */
function systemText(value:unknown):string {
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length === 1 && textBlock(value[0]) && value[0].text.trim()) return value[0].text;
    return badRequest();
}

/** The declared terminal tool keeps its name and its schema; only the envelope changes. */
function frozenTool(value:unknown):FrozenTool {
    if (!only(value,['name','description','input_schema']) || !toolName(value.name)) badRequest();
    if (value.description !== undefined && typeof value.description !== 'string') badRequest();
    if (!object(value.input_schema)) badRequest();
    return {name:value.name,...(typeof value.description === 'string' ? {description:value.description} : {}),schema:value.input_schema};
}

/** Every supervisor turn is one frozen system text, one user text and exactly one tool. */
function frozenMessages(request:unknown,model:string,limits:DshSupervisorLimits):Bundle {
    if (!only(request,['model','messages','system','tools','max_tokens','thinking','stream']) ||
        request.model !== model || request.stream !== true || !integer(request.max_tokens) || !request.max_tokens ||
        !Array.isArray(request.tools) || request.tools.length !== 1 ||
        !Array.isArray(request.messages) || request.messages.length !== 1 ||
        !only(request.thinking,['type']) || request.thinking.type !== 'disabled') badRequest();
    const [message] = list(request.messages);
    if (!only(message,['role','content']) || message.role !== 'user') badRequest();
    const content = list(message.content);
    if (content.length !== 1 || !textBlock(content[0]) || !content[0].text.trim()) badRequest();
    const [declared] = list(request.tools);
    const bundle:Bundle = {system:systemText(request.system),prompt:content[0].text,
        tool:frozenTool(declared),maxTokens:Math.min(request.max_tokens,limits.maxOutputTokens)};
    // The schema is forwarded verbatim, so an oversized declaration is refused here, not upstream.
    if (Buffer.byteLength(JSON.stringify(bundle),'utf8') > requestBytes) badRequest();
    return bundle;
}

/** A tool call is one JSON object, or it is not a supervisor submission at all. */
function toolArguments(raw:string,safe:(value:string)=>void):string {
    const parsed = parseGatewayJson(raw,safe);
    if (!object(parsed)) invalid();
    return JSON.stringify(parsed);
}

function checkCacheWrites(usage:unknown,details:unknown) {
    for (const value of [usage,details]) {
        if (!object(value)) continue;
        for (const key of ['cache_creation_input_tokens','cache_write_tokens','cache_creation_tokens']) {
            if (Object.hasOwn(value,key) && value[key] !== 0) unknown();
        }
    }
}

/** Same accounting as claude-readonly-wire: charged prompt tokens, reported cache hits. */
function chatUsage(raw:unknown):NativeUsage {
    const u = raw;
    if (!object(u) || !integer(u.prompt_tokens) || !integer(u.completion_tokens)) unknown();
    if (u.prompt_tokens_details !== undefined && !object(u.prompt_tokens_details)) unknown();
    checkCacheWrites(u,u.prompt_tokens_details);
    const hits = [u.prompt_tokens_details?.cached_tokens,u.prompt_cache_hit_tokens].filter(n => n !== undefined);
    const cached = hits[0];
    const inputTokens = Number(u.prompt_tokens);
    if (!integer(cached) || !hits.every(n => n === cached && cached <= inputTokens) || !integer(inputTokens + Number(u.completion_tokens)) ||
        (u.total_tokens !== undefined && u.total_tokens !== inputTokens + Number(u.completion_tokens)) ||
        (u.prompt_cache_miss_tokens !== undefined && u.prompt_cache_miss_tokens !== inputTokens - cached)) unknown();
    return {inputTokens,outputTokens:Number(u.completion_tokens),cacheHitTokens:cached};
}

function responsesUsage(raw:unknown):NativeUsage {
    const u = row(raw);
    if (!integer(u.input_tokens) || !integer(u.output_tokens)) unknown();
    if (u.total_tokens !== undefined && u.total_tokens !== Number(u.input_tokens) + Number(u.output_tokens)) unknown();
    // Same convention as the read-only CLI lane: a paid supervisor turn must report its cache
    // hit count, so an absent detail is unknown usage rather than a silent full-miss charge.
    const details = row(u.input_tokens_details);
    const cached = details.cached_tokens;
    if (!integer(cached) || cached > Number(u.input_tokens)) unknown();
    return {inputTokens:Number(u.input_tokens),outputTokens:Number(u.output_tokens),cacheHitTokens:cached};
}

function chatCompletion(doc:unknown,model:string,qualifiedModel:string,tool:FrozenTool,safe:(value:string)=>void):Completion {
    if (!object(doc) || doc.object !== 'chat.completion' || !id(doc.id) || (doc.model !== model && doc.model !== qualifiedModel) ||
        doc.error != null || !Array.isArray(doc.choices) || doc.choices.length !== 1) invalid();
    const [choice] = list(doc.choices);
    if (!only(choice,['index','finish_reason','message','logprobs']) || choice.index !== 0) invalid();
    const msg = row(choice.message);
    if (!only(msg,['role','content','refusal','reasoning_content','tool_calls','function_call','annotations']) || msg.role !== 'assistant' ||
        msg.refusal != null || msg.function_call != null ||
        (msg.reasoning_content != null && typeof msg.reasoning_content !== 'string') ||
        (msg.annotations != null && (!Array.isArray(msg.annotations) || msg.annotations.length))) invalid();
    let text = '', call:Completion['tool'];
    if (msg.tool_calls != null) {
        // Exactly one call, never parallel, and never alongside prose.
        if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length !== 1 || choice.finish_reason !== 'tool_calls') invalid();
        if (msg.content != null && (typeof msg.content !== 'string' || msg.content.trim())) invalid();
        const [raw] = list(msg.tool_calls);
        if (!only(raw,['index','id','type','function']) || raw.index !== 0 || raw.type !== 'function' || !id(raw.id)) invalid();
        const fn = row(raw.function);
        if (!only(fn,['name','arguments']) || fn.name !== tool.name || typeof fn.arguments !== 'string') invalid();
        call = {id:raw.id,name:fn.name,input:toolArguments(fn.arguments,safe)};
    } else if (choice.finish_reason === 'stop' && typeof msg.content === 'string' && msg.content.trim()) text = msg.content;
    else invalid();
    return {id:doc.id,text,usage:chatUsage(doc.usage),observedModel:doc.model,...(call ? {tool:call} : {})};
}

/**
 * One closed Responses transcript: either one message item or one function_call item.
 * Reasoning substreams need their own reconciler, so they are refused here.
 */
function responsesCompletion(raw:string,model:string,qualifiedModel:string,tool:FrozenTool,safe:(value:string)=>void):Completion {
    if (/\r(?!\n)/.test(raw)) invalid();
    const frames = raw.replaceAll('\r\n','\n').split('\n\n');
    if (frames.pop() !== '') invalid();
    let responseId:unknown, observedModel:unknown, completed:Row|undefined;
    let nextSequence:number|undefined, sequenced:boolean|undefined, active:Row|undefined;
    let itemIndex = 0, phase = 'created', kind:'message'|'call'|undefined, text = '', args = '';
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
        if (completed) invalid();
        const event = row(parseGatewayJson(data.join('\n'),safe));
        if (typeof event.type !== 'string' || (name !== undefined && name !== event.type)) invalid();
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
            if (phase !== 'created' || !response) invalid();
            const created = row(response);
            if (created.error != null || created.incomplete_details != null || !id(created.id) ||
                typeof created.model !== 'string' || (created.model !== model && created.model !== qualifiedModel)) invalid();
            responseId = created.id; observedModel = created.model; phase = 'between';
        } else if (type === 'response.in_progress' || type === 'response.metadata') {
            if (phase === 'created') invalid();
            if (response && (response.error != null || response.incomplete_details != null)) invalid();
            if (event.response_id !== undefined && event.response_id !== responseId) invalid();
        } else if (type === 'response.output_item.added') {
            if (phase !== 'between' || event.output_index !== itemIndex || !item) invalid();
            const added = row(item);
            if (!id(added.id) || closed.some(closedItem => closedItem.id === added.id)) invalid();
            if (added.type === 'message' && added.status === 'in_progress' && Array.isArray(added.content) && added.content.length === 0) {
                kind = 'message'; phase = 'message';
            } else if (added.type === 'function_call' && added.status === 'in_progress' && added.name === tool.name && id(added.call_id) &&
                (added.arguments === undefined || added.arguments === '')) {
                kind = 'call'; phase = 'call';
            } else invalid();
            active = added;
        } else if (type === 'response.completed') {
            if (phase !== 'between' || closed.length !== 1 || !response) invalid();
            const done = row(response);
            if (!isDeepStrictEqual(done.output,closed) || done.status !== 'completed' || done.error != null ||
                done.incomplete_details != null || done.id !== responseId || done.model !== observedModel) invalid();
            completed = done;
        } else {
            if (!active || event.output_index !== itemIndex) invalid();
            if (type === 'response.output_item.done') {
                // The closing event carries the whole item; the item-scoped events carry item_id.
                if (!item) invalid();
                const closing = row(item);
                if (closing.id !== active.id || closing.type !== active.type) invalid();
                if (kind === 'message') {
                    if (closing.status !== 'completed' || closing.role !== 'assistant') invalid();
                    const content = list(closing.content);
                    if (content.length !== 1) invalid();
                    const part = row(content[0]);
                    if (part.type !== 'output_text' || part.text !== text) invalid();
                } else if (closing.status !== 'completed' || closing.name !== tool.name || closing.arguments !== args || !id(closing.call_id)) invalid();
                closed.push(closing); active = undefined; kind = undefined; itemIndex++; phase = 'between';
            } else if (kind === 'message') {
                // Only the item-scoped events carry item_id; output_item.done carries the item itself.
                if (event.item_id !== active.id) invalid();
                if (phase === 'message' && type === 'response.content_part.added') {
                    const part = row(event.part);
                    if (part.type !== 'output_text' || part.text !== '') invalid();
                    phase = 'text';
                } else if (phase === 'text' && type === 'response.output_text.delta' && typeof event.delta === 'string' && event.content_index === 0) {
                    text += event.delta;
                } else if (phase === 'text' && type === 'response.output_text.done' && event.content_index === 0 && event.text === text) phase = 'textDone';
                else if (phase === 'textDone' && type === 'response.content_part.done' && event.content_index === 0) {
                    const part = row(event.part);
                    if (part.type !== 'output_text' || part.text !== text) invalid();
                    phase = 'partDone';
                } else invalid();
            } else {
                if (event.item_id !== active.id) invalid();
                if (phase === 'call' && type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
                    args += event.delta; phase = 'args';
                } else if (phase === 'args' && type === 'response.function_call_arguments.done' && event.arguments === args) phase = 'argsDone';
                else invalid();
            }
        }
    }
    if (!completed) invalid();
    const completedUsage = row(completed.usage);
    checkCacheWrites(completedUsage,object(completedUsage.input_tokens_details) ? completedUsage.input_tokens_details : undefined);
    const usage = responsesUsage(completedUsage);
    const [closedItem] = list(closed);
    const closedRow = row(closedItem);
    if (closedRow.type === 'message') {
        if (!text.trim()) invalid();
        return {id:String(responseId),text,usage,observedModel:String(observedModel)};
    }
    if (typeof closedRow.call_id !== 'string') invalid();
    return {id:String(responseId),text:'',usage,observedModel:String(observedModel),
        tool:{id:closedRow.call_id,name:tool.name,input:toolArguments(String(closedRow.arguments),safe)}};
}

/** Six Messages frames, text or tool_use, with the claude-readonly usage convention. */
function messagesSse(model:string,result:Completion) {
    const {inputTokens,outputTokens,cacheHitTokens} = result.usage;
    const usage = {input_tokens:inputTokens-cacheHitTokens,cache_creation_input_tokens:0,cache_read_input_tokens:cacheHitTokens,output_tokens:0};
    const events:Array<[string,Row]> = [
        ['message_start',{message:{id:result.id,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage}}],
        result.tool ?
            ['content_block_start',{index:0,content_block:{type:'tool_use',id:result.tool.id,name:result.tool.name,input:{}}}] :
            ['content_block_start',{index:0,content_block:{type:'text',text:''}}],
        result.tool ?
            ['content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:result.tool.input}}] :
            ['content_block_delta',{index:0,delta:{type:'text_delta',text:result.text}}],
        ['content_block_stop',{index:0}],
        ['message_delta',{delta:{stop_reason:result.tool ? 'tool_use' : 'end_turn',stop_sequence:null},usage:{output_tokens:outputTokens}}],
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
export function createDshSupervisorExchange({route:rawRoute,role,accounts,limits,assertCurrent,assertSafe,signal}:DshSupervisorContext) {
    const route = concreteMagpieRoute(rawRoute);
    const {model,protocol} = route;
    const chat = protocol === 'chat-completions';
    if (route.runtime !== 'dsh' || !['planner2','reviewer'].includes(role) || route.authentication !== 'api_key' ||
        (!chat && protocol !== 'openai-responses') || !Array.isArray(accounts as unknown)) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    const matches = accounts.filter(a => (['provider','authentication','authRef','accountRef','upstreamAccountRef'] as const).every(key => a[key] === route[key]));
    if (matches.length !== 1 || !Array.isArray(matches[0].capabilities) ||
        matches[0].capabilities.some(c => c.model === model && c.protocol === 'anthropic-messages') ||
        matches[0].capabilities.filter(c => c.model === model && c.protocol === protocol).length !== 1) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    if (!only(limits,['model','maxInputTokens','maxOutputTokens']) || limits.model !== model ||
        !integer(limits.maxOutputTokens) || limits.maxOutputTokens < 1 || limits.maxOutputTokens > 16000 ||
        !integer(limits.maxInputTokens) || !limits.maxInputTokens) badRequest();
    const frozenLimits = Object.freeze({...limits});
    const qualifiedModel = route.provider+'/'+model;
    const current = () => {signal.throwIfAborted(); synchronous(assertCurrent());};
    function synchronous(result:unknown) {
        if (result !== undefined) {if (result instanceof Promise) void result.catch(()=>{}); fail('MODEL_GATEWAY_BINDING_INVALID');}
    }
    const safe = (value:string) => synchronous(assertSafe(value));
    let used = false;
    return {prepare({method,path,version,contentType,body:raw}:DshSupervisorIngress) {
        current();
        if (used) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
        used = true;
        if (method !== 'POST' || !['/v1/messages','/v1/messages?beta=true'].includes(path) || version !== '2023-06-01' ||
            typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') badRequest();
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > requestBytes) badRequest();
        const frozen = frozenMessages(parseGatewayJson(raw,safe),model,frozenLimits);
        const description = frozen.tool.description === undefined ? {} : {description:frozen.tool.description};
        // The single terminal tool stays forced on both dialects: a supervision turn has no
        // free-form result, and the controller accepts exactly one submission.
        const body:Row = chat ? {
            model:qualifiedModel,stream:false,max_tokens:frozen.maxTokens,
            messages:[{role:'system',content:frozen.system},{role:'user',content:frozen.prompt}],
            tools:[{type:'function',function:{name:frozen.tool.name,...description,parameters:frozen.tool.schema}}],
            tool_choice:{type:'function',function:{name:frozen.tool.name}},
        } : {
            model:qualifiedModel,store:false,stream:true,max_output_tokens:frozen.maxTokens,instructions:frozen.system,
            input:[{type:'message',role:'user',content:[{type:'input_text',text:frozen.prompt}]}],
            tools:[{type:'function',name:frozen.tool.name,...description,parameters:frozen.tool.schema}],
            tool_choice:{type:'function',name:frozen.tool.name},
        };
        const wire = JSON.stringify(body);
        if (Buffer.byteLength(wire)>requestBytes) badRequest();
        safe(wire); safe(frozen.system);
        let consumed = false;
        return Object.freeze({path:chat?'/v1/chat/completions':'/v1/responses',body:wire,maxOutputTokens:frozen.maxTokens,
            async complete(response:Response) {
                current();
                if (consumed) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
                consumed = true;
                const bytes = await readBounded(response,chat?'application/json':'text/event-stream',signal);
                const raw = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
                safe(raw);
                const result = chat ? chatCompletion(parseGatewayJson(raw,safe),model,qualifiedModel,frozen.tool,safe) :
                    responsesCompletion(raw,model,qualifiedModel,frozen.tool,safe);
                const usage = result.usage;
                if (!integer(usage.inputTokens + usage.outputTokens)) unknown();
                safe(result.text); safe(result.id); if (result.tool) safe(result.tool.id); current();
                const responseSha256 = createHash('sha256').update(bytes).digest('hex');
                if (usage.inputTokens > frozenLimits.maxInputTokens || usage.outputTokens > frozen.maxTokens) {
                    // The caller settles known excess usage before failing the run. Never attach text.
                    throw Object.assign(new DomainError('NATIVE_USAGE_BOUND_EXCEEDED',502),{usage,responseSha256});
                }
                return Object.freeze({responseId:result.id,model,observedUpstreamModel:result.observedModel,usage:Object.freeze(usage),responseSha256,
                    outputTextHash:createHash('sha256').update(result.text.trim()).digest('hex'),
                    finishReason:result.tool?'tool_use':'end_turn',sse:messagesSse(model,result)});
            },
        });
    }};
}
