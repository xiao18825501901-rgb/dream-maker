import {isDeepStrictEqual} from 'node:util';
import {DomainError} from '../security.js';
import {parseGatewayJson} from '../gateway-tool-arguments.js';
import type {NativeUsage} from '../native-budget.js';

/**
 * The neutral tool transcript a translated executor turn is built on.
 *
 * Three lanes speak a translated executor wire: the DSH SDK and the CLI harnesses (Claude Code,
 * OpenCode and Cline on Messages; Codex on Responses). All of them carry the same thing - a frozen
 * system prompt, a bounded set of declared tools, and an ordered history of text turns, tool calls
 * and the results that answered them - so the validation and the rendering live here once and each
 * lane only decides which wire it renders to. Nothing in this file authors prompt text: every
 * string it emits came from the client request it validated.
 *
 * One transcript, two outlets. Chat bundles one assistant turn's calls into tool_calls and its
 * answers into tool rows; Responses gives every call its own function_call item and every answer
 * its own function_call_output. The reader side is the mirror image and is just as closed: a
 * stream is accepted only in full, frame by frame, before a byte is handed back to the client.
 */

export type Row = Record<string, unknown>;
export type DeclaredTool = {name:string; description?:string; schema:Row};
export type Call = {id:string; name:string; arguments:string};
export type TurnItem = {role:'user'; text:string} | {role:'assistant'; text:string; calls:Call[]} | {role:'tool'; call:Call; text:string};
export type Turn = {system:string; tools:DeclaredTool[]; items:TurnItem[]; toolChoice:'auto'|undefined; maxTokens:number};
export type Completion = {id:string; text:string; usage:NativeUsage; observedModel:string; calls:Call[]};
/** Each lane names its own three refusal codes, so an error always points at the wire the caller
 *  actually spoke: an invalid ingress body, an invalid upstream transcript, unaccountable usage. */
export interface LaneCodes {request:string; completion:string; usage:string}

export const requestBytes = 262144;
export const responseBytes = 2_000_000;
export const maxTools = 16;
const maxMessages = 512;
const maxCalls = 64;
const resultBytes = 512000;
const integer = (n:unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (v:unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v:unknown, keys:readonly string[]): v is Row => object(v) && Object.keys(v).every(key => keys.includes(key));
const id = (s:unknown): s is string => typeof s === 'string' && /^[-A-Za-z0-9_]{1,200}$/.test(s);
const toolName = (s:unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s);

export function failure(code:string):never {throw new DomainError(code,code.endsWith('_REQUEST_INVALID')?400:502);}
export function invalid(codes:LaneCodes):never {return failure(codes.completion);}
export function badRequest(codes:LaneCodes):never {return failure(codes.request);}
export function unknownUsage(codes:LaneCodes):never {return failure(codes.usage);}
const row = (v:unknown,codes:LaneCodes):Row => object(v) ? v : invalid(codes);
const list = (v:unknown,codes:LaneCodes):unknown[] => Array.isArray(v) ? v : invalid(codes);

/** A cache hint is inert on every wire this lane renders to; only the documented shape passes. */
function cacheHint(raw:unknown):boolean {
    return raw === undefined || only(raw,['type','ttl']) && raw.type === 'ephemeral' && (raw.ttl === undefined || raw.ttl === '5m' || raw.ttl === '1h');
}

/** Messages text blocks are the only content carrier on this lane; cache hints are inert. */
function textBlock(block:unknown): block is {type:'text';text:string} {
    if (!only(block,['type','text','cache_control']) || block.type !== 'text' || typeof block.text !== 'string') return false;
    return cacheHint(block.cache_control);
}

/** The Chat wire has one string per turn, so ordered text blocks are joined in place. */
function contentText(blocks:unknown[], where:'user'|'assistant'|'tool_result', codes:LaneCodes):string {
    const parts:string[] = [];
    for (const block of blocks) {
        if (!textBlock(block)) badRequest(codes);
        if (where !== 'tool_result' && !block.text.trim()) badRequest(codes);
        parts.push(block.text);
    }
    const text = parts.join('\n\n');
    if (Buffer.byteLength(text,'utf8') > resultBytes) badRequest(codes);
    return text;
}

/** One system prompt on the Chat wire: ordered blocks are joined in place, never re-authored. */
function systemText(value:unknown, codes:LaneCodes):string {
    if (typeof value === 'string') {
        if (!value.trim() || Buffer.byteLength(value,'utf8') > 400000) badRequest(codes);
        return value;
    }
    if (!Array.isArray(value) || !value.length || value.length > 16) badRequest(codes);
    const parts:string[] = [];
    for (const block of value) {
        if (!textBlock(block) || !block.text.trim()) badRequest(codes);
        parts.push(block.text);
    }
    const text = parts.join('\n\n');
    if (!text.trim() || Buffer.byteLength(text,'utf8') > 400000) badRequest(codes);
    return text;
}

/** Every declared tool keeps its name and its schema; only the envelope changes. A client may
 *  attach transport hints of its own ('eager_input_streaming', a custom type marker, a cache
 *  hint); they are not model input, so they are validated and then dropped, exactly as the native
 *  lane drops them before the Magpie hop. */
function declaredTool(value:unknown, codes:LaneCodes, hints:boolean):DeclaredTool {
    // Measured on the installed CLIs: 2.1.x attaches 'eager_input_streaming' to a declaration and
    // 'defer_loading' to its lazily-loaded placeholder; an SDK lane sends neither.
    const keys = hints
        ? ['name','description','input_schema','cache_control','type','eager_input_streaming','defer_loading']
        : ['name','description','input_schema'];
    if (!only(value,keys) || !toolName(value.name)) badRequest(codes);
    if (value.description !== undefined && typeof value.description !== 'string') badRequest(codes);
    if (!object(value.input_schema)) badRequest(codes);
    // A CLI attaches transport hints of its own to a declaration; a supervised SDK does not, so
    // the stricter lane refuses the field outright instead of pretending to understand it.
    if (hints) {
        if (value.type !== undefined && value.type !== 'custom') badRequest(codes);
        if (!cacheHint(value.cache_control)) badRequest(codes);
    }
    return {name:value.name,...(typeof value.description === 'string' ? {description:value.description} : {}),schema:value.input_schema};
}

function declaredTools(value:unknown, codes:LaneCodes, limit:number, hints:boolean):DeclaredTool[] {
    if (!Array.isArray(value) || value.length > limit) badRequest(codes);
    const tools = value.map(tool => declaredTool(tool,codes,hints));
    // A duplicate declaration makes every later tool call ambiguous.
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) badRequest(codes);
    return tools;
}

/** A tool call is one JSON object, or it is not an executor tool call at all. */
export function toolArguments(raw:string,safe:(value:string)=>void,codes:LaneCodes):string {
    const parsed = parseGatewayJson(raw,safe);
    if (!object(parsed)) invalid(codes);
    return JSON.stringify(parsed);
}

/**
 * Replay a whole Messages transcript as ordered neutral items.
 *
 * Every client on this wire resends the completed rounds on each request, so the replay is the
 * authority for turn order: an assistant tool_use is answered by exactly the tool_result blocks
 * of the immediately following user turn, in the declared order, once each. Every departure from
 * that shape is refused here rather than repaired upstream, once for every outlet.
 */
function transcript(value:unknown, tools:readonly DeclaredTool[], codes:LaneCodes, systemMessages:boolean):TurnItem[] {
    if (!Array.isArray(value) || !value.length || value.length > maxMessages) badRequest(codes);
    const declared = new Set(tools.map(tool => tool.name));
    const answered = new Set<string>();
    const items:TurnItem[] = [];
    let prior:'user'|'assistant'|undefined, pending:Call[]|undefined, total = 0;
    for (const raw of value) {
        if (!only(raw,['role','content']) || (raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'system')) badRequest(codes);
        const role = raw.role;
        const blocks = raw.content;
        // A system-role message is how 2.1.x carries its cached system text, and 2.1.318 sends it
        // AFTER the first user turn rather than only at the end. It is text only, it never opens a
        // turn and never changes whose turn it is, and the caller folds it into the system prompt;
        // the native lane strips the same message before the Magpie hop.
        if (role === 'system') {
            if (!systemMessages) badRequest(codes);
            if (typeof blocks === 'string' ? !blocks.trim() : !Array.isArray(blocks) || !blocks.length || !blocks.every(textBlock)) badRequest(codes);
            continue;
        }
        if (prior === undefined ? role !== 'user' : role === prior) badRequest(codes);
        if (!Array.isArray(blocks) || !blocks.length) badRequest(codes);
        if (role === 'assistant') {
            const texts:unknown[] = [], requested:Call[] = [];
            for (const block of blocks) {
                if (only(block,['type','text','cache_control']) && block.type === 'text') {texts.push(block);continue;}
                if (!only(block,['type','id','name','input','cache_control']) || block.type !== 'tool_use' || !id(block.id) ||
                    typeof block.name !== 'string' || !declared.has(block.name) || !object(block.input) || !cacheHint(block.cache_control)) badRequest(codes);
                // A repeated call id is either a duplicated round or a forged history.
                if (requested.some(call => call.id === block.id) || answered.has(block.id)) badRequest(codes);
                if (++total > maxCalls) badRequest(codes);
                requested.push({id:block.id,name:block.name,arguments:JSON.stringify(block.input)});
            }
            const text = texts.length ? contentText(texts,'assistant',codes) : '';
            if (!text && !requested.length) badRequest(codes);
            items.push({role:'assistant',text,calls:requested});
            pending = requested.length ? requested : undefined;
        } else if (pending) {
            const waiting:Call[] = pending;
            // A tool round trip answers every call of the previous assistant turn, in order.
            if (blocks.length !== waiting.length) badRequest(codes);
            for (const [position, block] of blocks.entries()) {
                if (!only(block,['type','tool_use_id','content','is_error','cache_control']) || block.type !== 'tool_result' ||
                    typeof block.tool_use_id !== 'string' || block.tool_use_id !== waiting[position].id || !cacheHint(block.cache_control)) badRequest(codes);
                if (block.is_error !== undefined && typeof block.is_error !== 'boolean') badRequest(codes);
                const parts = block.content;
                const text = parts === undefined ? '' : typeof parts === 'string' ? parts : Array.isArray(parts) ? contentText(parts,'tool_result',codes) : badRequest(codes);
                if (Buffer.byteLength(text,'utf8') > resultBytes) badRequest(codes);
                answered.add(block.tool_use_id);
                items.push({role:'tool',call:waiting[position],text});
            }
            pending = undefined;
        } else {
            items.push({role:'user',text:contentText(blocks,'user',codes)});
        }
        prior = role;
    }
    // The executor turn always asks for the next assistant message, never a prefill.
    if (prior !== 'user' || pending) badRequest(codes);
    return items;
}

/** Fold any trailing system-role message into the system prompt instead of dropping it. */
function foldedSystem(request:Row, codes:LaneCodes):string {
    const parts:string[] = [];
    if (request.system !== undefined) parts.push(systemText(request.system,codes));
    for (const raw of Array.isArray(request.messages) ? request.messages : []) {
        if (!object(raw) || raw.role !== 'system') continue;
        const blocks = typeof raw.content === 'string' ? [{type:'text',text:raw.content}] : raw.content;
        parts.push(contentText(blocks as unknown[],'user',codes));
    }
    const joined = parts.join('\n\n');
    if (!joined.trim() || Buffer.byteLength(joined,'utf8') > 400000) badRequest(codes);
    return joined;
}

export interface MessagesTurnOptions {
    model:string; maxTokens:number; codes:LaneCodes;
    /** Extra top-level members this caller's client sends and this lane accepts then drops. */
    hints?:readonly string[];
    /** How many tool declarations this lane admits. */
    maxTools?:number;
    /** Whether a trailing system-role message may appear (the 2.1.x executor arm) or not. */
    systemMessages?:boolean;
    /** Whether the request must carry the explicit disabled thinking switch (the SDK arm does). */
    requireThinking?:boolean;
    /** Whether a declaration may carry a CLI's transport hints beside its schema. */
    toolHints?:boolean;
    check?:(body:Row)=>void;
}

/** One validated Messages executor turn, ready to be rendered onto either OpenAI outlet. */
export function parseMessagesTurn(request:unknown, options:MessagesTurnOptions):Turn {
    const {model,codes} = options;
    const allowed = ['model','messages','system','tools','tool_choice','max_tokens','thinking','stream',...(options.hints ?? [])];
    if (!only(request,allowed) || request.model !== model || request.stream !== true ||
        !integer(request.max_tokens) || !request.max_tokens || !Array.isArray(request.messages) || !request.messages.length) badRequest(codes);
    if (options.requireThinking === true && request.thinking === undefined) badRequest(codes);
    // The CLI's own thinking request: disabled, or the adaptive display pair 2.1.x attaches.
    if (request.thinking !== undefined) {
        const thinking = request.thinking;
        const adaptive = only(thinking,['type','display']) && thinking.type === 'adaptive' && thinking.display === 'updates';
        if (!adaptive && !(only(thinking,['type']) && thinking.type === 'disabled')) badRequest(codes);
    }
    options.check?.(request);
    const system = foldedSystem(request,codes);
    const limit = options.maxTools ?? maxTools;
    const tools = declaredTools(request.tools,codes,limit,options.toolHints === true);
    const items = transcript(request.messages,tools,codes,options.systemMessages === true);
    let toolChoice:'auto'|undefined;
    if (request.tool_choice !== undefined) {
        // A forced or parse tool choice is a supervision shape; an executor leaves it open.
        const choice = request.tool_choice;
        const automatic = choice === 'auto' || only(choice,['type']) && choice.type === 'auto';
        if (!automatic || !tools.length) badRequest(codes);
        toolChoice = 'auto';
    }
    const turn:Turn = {system,tools,items,toolChoice,maxTokens:Math.min(Number(request.max_tokens),options.maxTokens)};
    // The schemas are forwarded verbatim, so an oversized transcript is refused here, not upstream.
    if (Buffer.byteLength(JSON.stringify(turn),'utf8') > requestBytes) badRequest(codes);
    return turn;
}

/**
 * The Responses ingress `codex exec` speaks, replayed as the same neutral items.
 *
 * `codex exec` declares its own function tools, replays the calls it already made and the
 * outputs that answered them, and adds two client-side item classes this lane must recognise and
 * then drop: a developer 'additional_tools' bundle (hosted tools the CLI owns, which cannot be
 * audited as calls) and a 'reasoning' item (a display hint, never model input). Everything else is
 * refused rather than silently dropped, so a future CLI change fails closed.
 *
 * The transcript the Chat wire receives is the same one a Messages client would have produced:
 * an assistant turn carrying its calls, then a tool item per answer. An assistant message with no
 * calls of its own is one text turn; only the text the model actually wrote is forwarded.
 */
export interface ResponsesTurnOptions {
    model:string; maxTokens:number; codes:LaneCodes;
    /** How many declarations this lane admits. */
    maxTools?:number;
    /** The system text this caller froze, when the manager holds it instead of the client. */
    instructions?:()=>string;
    /** The caller's own secret/redaction scan, applied to every replayed argument object. */
    safe?:(value:string)=>void;
    check?:(body:Row)=>void;
}

export function parseResponsesTurn(request:unknown, options:ResponsesTurnOptions):Turn {
    const {model,codes} = options;
    const limit = options.maxTools ?? maxTools;
    const allowed = ['model','input','instructions','max_output_tokens','tools','tool_choice','stream','store','text','reasoning',
        'include','prompt_cache_key','client_metadata','parallel_tool_calls','temperature','top_p'];
    if (!only(request,allowed) || request.model !== model || request.stream !== true || request.store !== false ||
        !Array.isArray(request.input) || !request.input.length) badRequest(codes);
    if (request.max_output_tokens !== undefined && (!integer(request.max_output_tokens) || !request.max_output_tokens)) badRequest(codes);
    if (request.instructions !== undefined && typeof request.instructions !== 'string') badRequest(codes);
    if (request.reasoning !== undefined && (!object(request.reasoning) ||
        request.reasoning.effort !== undefined && typeof request.reasoning.effort !== 'string')) badRequest(codes);
    if (request.include !== undefined && (!Array.isArray(request.include) || request.include.some(value => typeof value !== 'string'))) badRequest(codes);
    if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== 'boolean') badRequest(codes);
    if (request.prompt_cache_key !== undefined && typeof request.prompt_cache_key !== 'string') badRequest(codes);
    if (request.client_metadata !== undefined && !object(request.client_metadata)) badRequest(codes);
    // `codex exec` declares its function tools as flat {type,name,description,parameters} entries and
    // marks a schema strict; the marker is a client hint and the declaration is forwarded whole.
    // It also declares hosted bundles of its own - a 'namespace' of sub-tools and a hosted
    // 'web_search' - which are not calls this lane can replay or audit. The native lane drops the
    // same two classes (magpie-owned keeps only type:function), so they are recognised here and
    // dropped as well; everything that is neither a function nor a recognised hosted class is
    // still refused.
    const hosted = new Set(['namespace','web_search','web_search_preview','file_search','code_interpreter','image_generation','mcp']);
    const tools:DeclaredTool[] = [];
    if (request.tools !== undefined) {
        if (!Array.isArray(request.tools) || request.tools.length > limit) badRequest(codes);
        for (const raw of request.tools) {
            if (!object(raw) || typeof raw.type !== 'string') badRequest(codes);
            if (raw.type !== 'function') {
                if (!hosted.has(raw.type)) badRequest(codes);
                continue;
            }
            if (!only(raw,['type','name','description','parameters','strict']) || !toolName(raw.name)) badRequest(codes);
            if (raw.description !== undefined && typeof raw.description !== 'string') badRequest(codes);
            if (raw.strict !== undefined && typeof raw.strict !== 'boolean') badRequest(codes);
            if (!object(raw.parameters)) badRequest(codes);
            tools.push({name:raw.name,...(typeof raw.description === 'string' ? {description:raw.description} : {}),schema:raw.parameters});
        }
        if (new Set(tools.map(tool => tool.name)).size !== tools.length) badRequest(codes);
    }
    const declared = new Set(tools.map(tool => tool.name));
    const parts:string[] = [];
    if (typeof request.instructions === 'string' && request.instructions.trim()) parts.push(request.instructions);
    const items:TurnItem[] = [];
    const answered = new Set<string>();
    // A round of calls is answered in the order it was asked for, so the pending set is a queue and
    // not one call: two parallel calls share one assistant turn and then two output items.
    let pending:Call[] = [], total = 0;
    for (const raw of request.input) {
        const item = object(raw) ? raw : badRequest(codes);
        // A hosted-tool bundle belongs to the CLI, not to this turn: it can never be audited as a
        // call, so it is recognised and dropped rather than being mistaken for model context.
        if (item.type === 'additional_tools') {
            if (item.role !== 'developer' || !only(item,['type','role','id','tools']) || !Array.isArray(item.tools)) badRequest(codes);
            continue;
        }
        if (item.type === 'reasoning') continue;
        if (item.type === 'message') {
            if (!only(item,['type','role','id','content']) || !['developer','system','user','assistant'].includes(String(item.role)) ||
                !Array.isArray(item.content) || !item.content.length) badRequest(codes);
            const blocks = item.content.map(part => {
                if (!only(part,['type','text']) || !['input_text','output_text','text'].includes(String(part.type)) || typeof part.text !== 'string') badRequest(codes);
                return {type:'text',text:String(part.text)};
            });
            if (item.role === 'developer' || item.role === 'system') {
                // The frozen system text travels as instructions; a system row is the same text.
                const text = contentText(blocks,'user',codes);
                if (items.length) badRequest(codes);
                parts.push(text);
                continue;
            }
            if (item.role === 'assistant') {
                if (pending.length) badRequest(codes);
                items.push({role:'assistant',text:contentText(blocks,'assistant',codes),calls:[]});
                continue;
            }
            if (pending.length) badRequest(codes);
            items.push({role:'user',text:contentText(blocks,'user',codes)});
            continue;
        }
        if (item.type === 'function_call') {
            if (!only(item,['type','call_id','name','arguments','id','status']) || !id(item.call_id) ||
                typeof item.name !== 'string' || !declared.has(item.name) || typeof item.arguments !== 'string') badRequest(codes);
            if (answered.has(item.call_id) || pending.some(call => call.id === item.call_id)) badRequest(codes);
            if (++total > maxCalls) badRequest(codes);
            const call:Call = {id:item.call_id,name:item.name,arguments:toolArguments(item.arguments,options.safe ?? (() => {}),codes)};
            const last = items.at(-1);
            // Calls of one round belong to the assistant turn that asked for them; a call after a
            // tool answer opens a new assistant turn, exactly as the Messages replay would.
            if (last?.role === 'assistant') last.calls.push(call);
            else items.push({role:'assistant',text:'',calls:[call]});
            pending.push(call);
            continue;
        }
        if (item.type === 'function_call_output') {
            // The CLI stamps its own item id on the output ('fco_...'). It addresses an item of a
            // stored response this lane never keeps, so it is validated and dropped; the call_id is
            // what carries the round trip.
            if (!only(item,['type','call_id','output','id']) || typeof item.call_id !== 'string' ||
                typeof item.output !== 'string' || (item.id !== undefined && !id(item.id))) badRequest(codes);
            if (!pending.length || pending[0].id !== item.call_id || answered.has(item.call_id)) badRequest(codes);
            if (Buffer.byteLength(item.output,'utf8') > resultBytes) badRequest(codes);
            answered.add(item.call_id);
            items.push({role:'tool',call:pending[0],text:item.output});
            pending = pending.slice(1);
            continue;
        }
        return badRequest(codes);
    }
    if (pending.length) badRequest(codes);
    const last = items.at(-1);
    // The turn always asks for the next assistant message, never a prefill.
    if (!last || last.role === 'assistant') badRequest(codes);
    if (options.instructions) {
        const frozen = options.instructions();
        if (typeof frozen !== 'string' || !frozen.trim()) badRequest(codes);
        parts.push(frozen);
    }
    const system = parts.join('\n\n');
    if (!system.trim() || Buffer.byteLength(system,'utf8') > 400000) badRequest(codes);
    options.check?.(request);
    const turn:Turn = {system,tools,items,toolChoice:undefined,
        maxTokens:Math.min(request.max_output_tokens === undefined ? options.maxTokens : Number(request.max_output_tokens),options.maxTokens)};
    if (Buffer.byteLength(JSON.stringify(turn),'utf8') > requestBytes) badRequest(codes);
    return turn;
}

/** The Chat replay: one system string, then the same ordered items in the Chat dialect. */
function chatRows(items:readonly TurnItem[]):Row[] {
    return items.map(item => item.role === 'tool' ? {role:'tool',tool_call_id:item.call.id,content:item.text}
        : item.role === 'user' ? {role:'user',content:item.text}
        : {role:'assistant',content:item.text || null,
            ...(item.calls.length ? {tool_calls:item.calls.map(call => ({id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}))} : {})});
}

export function chatBody(turn:Turn, qualifiedModel:string):Row {
    return {model:qualifiedModel,stream:true,max_tokens:turn.maxTokens,
        messages:[{role:'system',content:turn.system},...chatRows(turn.items)],
        ...(turn.tools.length ? {tools:turn.tools.map(tool => ({type:'function',function:{name:tool.name,
            ...(tool.description === undefined ? {} : {description:tool.description}),parameters:tool.schema}}))} : {}),
        ...(turn.toolChoice === undefined ? {} : {tool_choice:turn.toolChoice})};
}

/**
 * The Responses replay. The wire has no assistant tool-call envelope, so every tool_use becomes its
 * own function_call item and every tool_result its own function_call_output, in the order the
 * Messages transcript wrote them. An assistant's prose becomes one message item ahead of its calls;
 * the frozen system text travels as instructions, exactly as the supervision lanes send it.
 */
function responsesItems(items:readonly TurnItem[]):Row[] {
    const out:Row[] = [];
    for (const item of items) {
        if (item.role === 'user') out.push({type:'message',role:'user',content:[{type:'input_text',text:item.text}]});
        else if (item.role === 'tool') out.push({type:'function_call_output',call_id:item.call.id,output:item.text});
        else {
            if (item.text) out.push({type:'message',role:'assistant',content:[{type:'input_text',text:item.text}]});
            for (const call of item.calls) out.push({type:'function_call',call_id:call.id,name:call.name,arguments:call.arguments});
        }
    }
    return out;
}

/** The Responses request. tool_choice is not forwarded: a declared 'auto' is the wire default. */
export function responsesBody(turn:Turn, qualifiedModel:string):Row {
    return {model:qualifiedModel,store:false,stream:true,max_output_tokens:turn.maxTokens,instructions:turn.system,
        input:responsesItems(turn.items),
        ...(turn.tools.length ? {tools:turn.tools.map(tool => ({type:'function',name:tool.name,
            ...(tool.description === undefined ? {} : {description:tool.description}),parameters:tool.schema}))} : {})};
}
/**
 * The Messages replay: one system block, then the same ordered items in the Anthropic dialect.
 *
 * A call becomes a tool_use block of the assistant turn that asked for it, and every answer becomes
 * a tool_result block of the user turn that follows it, so parallel calls share one assistant turn
 * and one answer turn exactly as a Messages client already produces them. Nothing is re-authored:
 * the block id is the call's own id, the name the declared one, and the input is the argument object
 * the client already sent (every Call in this file is normalised to a JSON object string first).
 */
export function messagesBody(turn:Turn, qualifiedModel:string):Row {
    const messages:Row[] = [];
    let answers:Row[] = [];
    const flush = () => {if(answers.length){messages.push({role:'user',content:answers});answers = [];}};
    for (const item of turn.items) {
        if (item.role === 'tool') {answers.push({type:'tool_result',tool_use_id:item.call.id,content:item.text});continue;}
        flush();
        if (item.role === 'user') {messages.push({role:'user',content:[{type:'text',text:item.text}]});continue;}
        const blocks:Row[] = [];
        if (item.text) blocks.push({type:'text',text:item.text});
        for (const call of item.calls) blocks.push({type:'tool_use',id:call.id,name:call.name,input:JSON.parse(call.arguments)});
        messages.push({role:'assistant',content:blocks});
    }
    flush();
    return {model:qualifiedModel,stream:true,max_tokens:turn.maxTokens,system:[{type:'text',text:turn.system}],messages,
        ...(turn.tools.length ? {tools:turn.tools.map(tool => ({name:tool.name,
            ...(tool.description === undefined ? {} : {description:tool.description}),input_schema:tool.schema}))} : {})};
}

export function checkCacheWrites(usage:unknown,details:unknown,codes:LaneCodes) {
    for (const value of [usage,details]) {
        if (!object(value)) continue;
        for (const key of ['cache_creation_input_tokens','cache_write_tokens','cache_creation_tokens']) {
            if (Object.hasOwn(value,key) && value[key] !== 0) unknownUsage(codes);
        }
    }
}

/** Same accounting as claude-readonly-wire: charged prompt tokens, reported cache hits. */
export function chatUsage(raw:unknown,codes:LaneCodes):NativeUsage {
    if (!object(raw) || !integer(raw.prompt_tokens) || !integer(raw.completion_tokens)) unknownUsage(codes);
    if (raw.prompt_tokens_details !== undefined && !object(raw.prompt_tokens_details)) unknownUsage(codes);
    const details = object(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
    checkCacheWrites(raw,details,codes);
    const hits = [details?.cached_tokens,raw.prompt_cache_hit_tokens].filter(n => n !== undefined);
    const cached = hits[0];
    const inputTokens = Number(raw.prompt_tokens);
    if (!integer(cached) || !hits.every(n => n === cached && cached <= inputTokens) || !integer(inputTokens + Number(raw.completion_tokens)) ||
        (raw.total_tokens !== undefined && raw.total_tokens !== inputTokens + Number(raw.completion_tokens)) ||
        (raw.prompt_cache_miss_tokens !== undefined && raw.prompt_cache_miss_tokens !== inputTokens - cached)) unknownUsage(codes);
    return {inputTokens,outputTokens:Number(raw.completion_tokens),cacheHitTokens:cached};
}

/** The Responses terminal usage: charged input/output plus the reported cache hits, no writes. */
export function responsesUsage(raw:unknown,codes:LaneCodes):NativeUsage {
    const u = row(raw,codes);
    if (!integer(u.input_tokens) || !integer(u.output_tokens)) unknownUsage(codes);
    if (u.total_tokens !== undefined && u.total_tokens !== Number(u.input_tokens) + Number(u.output_tokens)) unknownUsage(codes);
    // A paid executor turn must report its cache hit count, so an absent detail is unknown usage
    // rather than a silent full-miss charge; the detail object must be an object at all.
    const details = row(u.input_tokens_details,codes);
    const cached = details.cached_tokens;
    if (!integer(cached) || cached > Number(u.input_tokens)) unknownUsage(codes);
    checkCacheWrites(u,details,codes);
    return {inputTokens:Number(u.input_tokens),outputTokens:Number(u.output_tokens),cacheHitTokens:cached};
}

const chunkKeys = ['id','object','created','model','choices','usage','system_fingerprint'];
const deltaKeys = ['role','content','reasoning_content','tool_calls','function_call'];
type Fragment = {id:string;typed:boolean;name:string;arguments:string};

/**
 * One closed Chat Completions stream. Every frame is validated before any byte is exposed to
 * the client, including a repeated finish reason, a fragment that arrives after the terminal
 * frame, and any payload after the [DONE] sentinel.
 */
export function readChatStream(raw:string, model:string, qualifiedModel:string, tools:readonly DeclaredTool[], safe:(value:string)=>void, codes:LaneCodes, limit = maxTools):Completion {
    if (/\r(?!\n)/.test(raw)) invalid(codes);
    const normalized = raw.replaceAll('\r\n','\n');
    if (!normalized.endsWith('\n\n')) invalid(codes);
    const frames = normalized.slice(0,-2).split('\n\n');
    if (frames.length > 4096) invalid(codes);
    const declared = new Set(tools.map(tool => tool.name));
    const calls = new Map<number,Fragment>();
    let streamId:unknown, observedModel:unknown, finish:string|undefined, usageRaw:unknown, done = false, text = '';
    for (const frame of frames) {
        if (!frame) invalid(codes);
        const data:string[] = [];
        for (const line of frame.split('\n')) {
            // Only a comment line is inert on the Chat wire; any other field is a foreign event.
            if (line.startsWith(':')) continue;
            if (!line.startsWith('data:')) invalid(codes);
            data.push(line.slice(5).replace(/^ /,''));
        }
        if (!data.length) invalid(codes);
        const payload = data.join('\n');
        if (done) invalid(codes);
        if (payload === '[DONE]') {done = true;continue;}
        const chunk = parseGatewayJson(payload,safe);
        if (!only(chunk,chunkKeys) || chunk.object !== 'chat.completion.chunk' || !id(chunk.id) ||
            (chunk.model !== model && chunk.model !== qualifiedModel) || !Array.isArray(chunk.choices) || chunk.choices.length > 1) invalid(codes);
        if (streamId === undefined) {streamId = chunk.id;observedModel = chunk.model;}
        else if (chunk.id !== streamId || chunk.model !== observedModel) invalid(codes);
        if (chunk.usage != null) {
            if (usageRaw !== undefined) invalid(codes);
            usageRaw = chunk.usage;
        }
        if (!chunk.choices.length) {
            // A usage-only trailer is the one frame that may carry no delta at all.
            if (chunk.usage == null) invalid(codes);
            continue;
        }
        const choice = row(list(chunk.choices,codes)[0],codes);
        if (!only(choice,['index','delta','finish_reason','logprobs']) || choice.index !== 0 || choice.logprobs != null) invalid(codes);
        const delta = row(choice.delta,codes);
        if (!only(delta,deltaKeys) || (delta.role !== undefined && delta.role !== 'assistant')) invalid(codes);
        // Reasoning substreams and the legacy function_call shape need their own reconciler.
        if (delta.reasoning_content != null || delta.function_call != null) invalid(codes);
        const hasPayload = delta.content !== undefined || delta.tool_calls !== undefined;
        if (hasPayload && (finish !== undefined || choice.finish_reason != null)) invalid(codes);
        if (delta.content !== undefined) {
            if (typeof delta.content !== 'string') invalid(codes);
            text += delta.content;
        }
        if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > limit) invalid(codes);
            for (const item of delta.tool_calls) {
                if (!only(item,['index','id','type','function']) || !integer(item.index) || item.index >= limit) invalid(codes);
                const fragment = calls.get(item.index) ?? {id:'',typed:false,name:'',arguments:''};
                if (item.id !== undefined) {
                    if (typeof item.id !== 'string') invalid(codes);
                    fragment.id += item.id;
                }
                if (item.type !== undefined) {
                    if (item.type !== 'function' || fragment.typed) invalid(codes);
                    fragment.typed = true;
                }
                if (item.function !== undefined) {
                    if (!only(item.function,['name','arguments'])) invalid(codes);
                    if (item.function.name !== undefined) {
                        if (typeof item.function.name !== 'string') invalid(codes);
                        fragment.name += item.function.name;
                    }
                    if (item.function.arguments !== undefined) {
                        if (typeof item.function.arguments !== 'string') invalid(codes);
                        fragment.arguments += item.function.arguments;
                    }
                }
                calls.set(item.index,fragment);
            }
        }
        if (choice.finish_reason != null) {
            if (finish !== undefined || typeof choice.finish_reason !== 'string') invalid(codes);
            // A truncated or filtered answer is never a completed executor turn.
            if (!['stop','tool_calls'].includes(choice.finish_reason)) invalid(codes);
            finish = choice.finish_reason;
        }
    }
    if (!done || typeof streamId !== 'string' || finish === undefined || usageRaw === undefined) invalid(codes);
    const ordered:Call[] = [], seen = new Set<string>();
    // Tool fragments must be a dense 0..n-1 set; a sparse index cannot map onto block order.
    for (let index = 0; index < calls.size; index++) {
        const fragment = calls.get(index);
        if (!fragment || !id(fragment.id) || !fragment.typed || !declared.has(fragment.name) || seen.has(fragment.id)) invalid(codes);
        seen.add(fragment.id);
        ordered.push({id:fragment.id,name:fragment.name,arguments:toolArguments(fragment.arguments,safe,codes)});
    }
    if ((finish === 'tool_calls') !== (ordered.length > 0)) invalid(codes);
    if (finish === 'stop' && !text.trim()) invalid(codes);
    for (const call of ordered) {safe(call.id);safe(call.name);safe(call.arguments);}
    safe(text);
    return {id:streamId,text,usage:chatUsage(usageRaw,codes),observedModel:String(observedModel),calls:ordered};
}

type Open = {added:Row; kind:'message'|'call'; index:number; text:string; args:string;
    phase:'open'|'text'|'textDone'|'partDone'|'args'|'argsDone'};

/**
 * One closed Responses transcript.
 *
 * An executor answer is up to sixteen function_call items and at most one message item, so this is
 * an ordered per-item state machine: each item opens at output_item.added, streams its deltas,
 * closes at output_item.done, and the whole closed output is compared with response.completed
 * before any byte reaches the client. Reasoning, refusal and image substreams need their own
 * reconciler, so they are refused.
 *
 * The wire needs no [DONE] sentinel. An upstream that appends one is accepted only as the exact
 * final frame of an already completed stream, and nothing may follow it.
 */
export function readResponsesStream(raw:string, model:string, qualifiedModel:string, tools:readonly DeclaredTool[], safe:(value:string)=>void, codes:LaneCodes, limit = maxTools):Completion {
    if (/\r(?!\n)/.test(raw)) invalid(codes);
    const frames = raw.replaceAll('\r\n','\n').split('\n\n');
    if (frames.pop() !== '') invalid(codes);
    const declared = new Set(tools.map(tool => tool.name));
    let responseId:unknown, observedModel:unknown, completed:Row|undefined, sentinel = false;
    let nextSequence:number|undefined, sequenced:boolean|undefined;
    let phase:'created'|'between'|'item' = 'created', text = '', calls = 0;
    const closed:Row[] = [];
    let active:Open|undefined;
    for (const frame of frames) {
        if (!frame) continue;
        let name:string|undefined; const data:string[] = [];
        for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:') && name === undefined) name = line.slice(6).replace(/^ /,'');
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
            else invalid(codes);
        }
        if (!data.length) {if (name !== undefined) invalid(codes); continue;}
        const payload = data.join('\n');
        // One optional [DONE] sentinel may close a completed stream; anything after it is foreign.
        if (payload === '[DONE]') {if (!completed || sentinel) invalid(codes); sentinel = true; continue;}
        if (completed || sentinel) invalid(codes);
        const event = row(parseGatewayJson(payload,safe),codes);
        if (typeof event.type !== 'string' || (name !== undefined && name !== event.type)) invalid(codes);
        const type = event.type;
        if (sequenced === undefined) sequenced = Object.hasOwn(event,'sequence_number');
        if (sequenced !== Object.hasOwn(event,'sequence_number')) invalid(codes);
        if (sequenced) {
            if (!integer(event.sequence_number) || (nextSequence !== undefined && event.sequence_number !== nextSequence)) invalid(codes);
            nextSequence = event.sequence_number + 1;
        }
        const item = object(event.item) ? event.item : undefined;
        const response = object(event.response) ? event.response : undefined;
        if (type === 'response.created') {
            if (phase !== 'created' || !response) invalid(codes);
            if (response.error != null || response.incomplete_details != null || !id(response.id) ||
                typeof response.model !== 'string' || (response.model !== model && response.model !== qualifiedModel)) invalid(codes);
            responseId = response.id; observedModel = response.model; phase = 'between';
        } else if (type === 'response.in_progress' || type === 'response.metadata') {
            if (phase === 'created') invalid(codes);
            if (response && (response.error != null || response.incomplete_details != null)) invalid(codes);
            if (event.response_id !== undefined && event.response_id !== responseId) invalid(codes);
        } else if (type === 'response.output_item.added') {
            // Items open one at a time, in output order, so a reopened index is a broken transcript.
            if (phase !== 'between' || event.output_index !== closed.length || !item) invalid(codes);
            if (!id(item.id) || closed.some(closedItem => closedItem.id === item.id)) invalid(codes);
            if (item.type === 'message') {
                // The executor answers in text once; a second message item duplicates that answer.
                if (closed.some(closedItem => closedItem.type === 'message') || item.status !== 'in_progress' ||
                    !Array.isArray(item.content) || item.content.length) invalid(codes);
                active = {added:item,kind:'message',index:closed.length,text:'',args:'',phase:'open'};
            } else if (item.type === 'function_call') {
                if (calls >= limit || item.status !== 'in_progress' || typeof item.name !== 'string' || !declared.has(item.name) ||
                    !id(item.call_id) || closed.some(closedItem => closedItem.type === 'function_call' && closedItem.call_id === item.call_id) ||
                    (item.arguments !== undefined && item.arguments !== '')) invalid(codes);
                calls++;
                active = {added:item,kind:'call',index:closed.length,text:'',args:'',phase:'open'};
            } else invalid(codes);
            phase = 'item';
        } else if (type === 'response.completed') {
            if (phase !== 'between' || !closed.length || !response) invalid(codes);
            if (!isDeepStrictEqual(response.output,closed) || response.status !== 'completed' || response.error != null ||
                response.incomplete_details != null || response.id !== responseId || response.model !== observedModel) invalid(codes);
            completed = response;
        } else {
            const open = active;
            if (!open || event.output_index !== open.index) invalid(codes);
            if (type === 'response.output_item.done') {
                // The closing event carries the whole item; the item-scoped events carry item_id.
                if (!item) invalid(codes);
                const closing = row(item,codes);
                if (closing.id !== open.added.id || closing.type !== open.added.type) invalid(codes);
                if (open.kind === 'message') {
                    if (open.phase !== 'partDone' || closing.status !== 'completed' || closing.role !== 'assistant') invalid(codes);
                    const content = list(closing.content,codes);
                    if (content.length !== 1) invalid(codes);
                    const part = row(content[0],codes);
                    if (part.type !== 'output_text' || part.text !== open.text) invalid(codes);
                    text = open.text;
                } else if (open.phase !== 'argsDone' || closing.status !== 'completed' || closing.name !== open.added.name ||
                    closing.call_id !== open.added.call_id || closing.arguments !== open.args) invalid(codes);
                closed.push(closing); active = undefined; phase = 'between';
            } else if (open.kind === 'message') {
                if (event.item_id !== open.added.id) invalid(codes);
                if (open.phase === 'open' && type === 'response.content_part.added') {
                    const part = row(event.part,codes);
                    if (part.type !== 'output_text' || part.text !== '') invalid(codes);
                    open.phase = 'text';
                } else if (open.phase === 'text' && type === 'response.output_text.delta' && typeof event.delta === 'string' && event.content_index === 0) {
                    open.text += event.delta;
                } else if (open.phase === 'text' && type === 'response.output_text.done' && event.content_index === 0 && event.text === open.text) open.phase = 'textDone';
                else if (open.phase === 'textDone' && type === 'response.content_part.done' && event.content_index === 0) {
                    const part = row(event.part,codes);
                    if (part.type !== 'output_text' || part.text !== open.text) invalid(codes);
                    open.phase = 'partDone';
                } else invalid(codes);
            } else {
                if (event.item_id !== open.added.id) invalid(codes);
                if ((open.phase === 'open' || open.phase === 'args') && type === 'response.function_call_arguments.delta' &&
                    typeof event.delta === 'string') {
                    open.args += event.delta; open.phase = 'args';
                } else if (open.phase === 'args' && type === 'response.function_call_arguments.done' && event.arguments === open.args) open.phase = 'argsDone';
                else invalid(codes);
            }
        }
    }
    if (!completed || phase !== 'between' || !closed.length) invalid(codes);
    const finished = row(completed,codes);
    const usage = responsesUsage(finished.usage,codes);
    const ordered:Call[] = [], seen = new Set<string>();
    for (const item of closed) {
        if (item.type !== 'function_call') continue;
        if (typeof item.name !== 'string' || !declared.has(item.name) || typeof item.call_id !== 'string' || seen.has(item.call_id)) invalid(codes);
        seen.add(item.call_id);
        ordered.push({id:item.call_id,name:item.name,arguments:toolArguments(String(item.arguments),safe,codes)});
    }
    // The executor turn either answers in text or asks for tools; a silent turn is never one.
    if (!ordered.length && !text.trim()) invalid(codes);
    for (const call of ordered) {safe(call.id);safe(call.name);safe(call.arguments);}
    safe(text);
    return {id:String(responseId),text,usage,observedModel:String(observedModel),calls:ordered};
}


type OpenBlock = {index:number; kind:'text'|'call'; text:string; args:string; streamed:boolean; initial:Row; id:string; name:string};

/**
 * One closed Messages transcript, read back as the same Completion every other reader produces.
 *
 * The upstream is the Anthropic wire, so an executor answer is at most one text block and zero to
 * sixteen tool_use blocks. Every block is opened, streamed and closed in dense index order before
 * the terminal frames, and the stop reason must agree with the blocks actually read: `tool_use`
 * without a call, or `end_turn` without text, is refused rather than repaired. A block may arrive
 * already complete (an upstream that does not stream partial_json); it is then accepted without
 * deltas and refused if deltas follow it. Nothing reaches the client before the whole transcript has
 * been validated, and the charged input is the prompt the start frame reported, cache reads included.
 */
export function readMessagesStream(raw:string, model:string, qualifiedModel:string, tools:readonly DeclaredTool[], safe:(value:string)=>void, codes:LaneCodes, limit = maxTools):Completion {
    if (/\r(?!\n)/.test(raw)) invalid(codes);
    const frames = raw.replaceAll('\r\n','\n').split('\n\n');
    // A stream that does not end on a frame boundary carries trailing bytes.
    if (frames.pop() !== '') invalid(codes);
    const declared = new Set(tools.map(tool => tool.name));
    const startUsageKeys = ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'];
    const deltaUsageKeys = ['output_tokens','input_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
    const messageKeys = ['id','type','role','model','content','stop_reason','stop_sequence','usage'];
    let start:{id:string;model:string;input:number;cacheRead:number;output:number}|undefined;
    let outputTokens:number|undefined, text = '', stopReason:string|undefined, nextIndex = 0, textSeen = false;
    let stopped = false, sawContent = false;
    let phase:'start'|'blocks'|'closed' = 'start';
    let open:OpenBlock|undefined;
    const calls:Call[] = [], seen = new Set<string>();
    for (const frame of frames) {
        if (!frame) continue;
        // Nothing may follow the terminal frame.
        if (stopped) invalid(codes);
        let name; const data:string[] = [];
        for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:') && name === undefined) name = line.slice(6).replace(/^ /,'');
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
            else invalid(codes);
        }
        if (!data.length) {if (name !== undefined) invalid(codes); continue;}
        const event = row(parseGatewayJson(data.join('\n'),safe),codes);
        if (typeof event.type !== 'string' || (name !== undefined && name !== event.type)) invalid(codes);
        const type = event.type;
        if (type === 'ping') continue;
        if (type === 'message_start') {
            if (phase !== 'start' || !only(event,['type','message'])) invalid(codes);
            const message = row(event.message,codes);
            if (!only(message,messageKeys) || !id(message.id) || message.type !== 'message' || message.role !== 'assistant' ||
                typeof message.model !== 'string' || (message.model !== model && message.model !== qualifiedModel) ||
                !Array.isArray(message.content) || message.content.length ||
                (message.stop_reason !== null && message.stop_reason !== undefined)) invalid(codes);
            const usage = object(message.usage) ? message.usage : unknownUsage(codes);
            if (!only(usage,startUsageKeys) || !integer(usage.input_tokens) || !integer(usage.output_tokens)) unknownUsage(codes);
            const cacheRead = usage.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens;
            // This lane never charges a cache write; a reported one is unaccountable spend.
            if (usage.cache_creation_input_tokens !== undefined && usage.cache_creation_input_tokens !== 0) unknownUsage(codes);
            if (!integer(cacheRead) || cacheRead > Number(usage.input_tokens)) unknownUsage(codes);
            start = {id:message.id,model:message.model,input:Number(usage.input_tokens),cacheRead,output:Number(usage.output_tokens)};
            phase = 'blocks';
        } else if (type === 'content_block_start') {
            if (phase !== 'blocks' || open !== undefined || event.index !== nextIndex || !only(event,['type','index','content_block'])) invalid(codes);
            const block = row(event.content_block,codes);
            if (block.type === 'text') {
                // The wire carries one text block per answer; a second one duplicates it.
                if (textSeen || !only(block,['type','text']) || block.text !== '') invalid(codes);
                textSeen = true;
                open = {index:nextIndex,kind:'text',text:'',args:'',streamed:false,initial:{},id:'',name:''};
            } else if (block.type === 'tool_use') {
                if (!only(block,['type','id','name','input']) || !id(block.id) || !toolName(block.name) || !declared.has(block.name) ||
                    !object(block.input) || seen.has(block.id) || calls.length >= limit) invalid(codes);
                if (!integer(event.index)) invalid(codes);
                open = {index:nextIndex,kind:'call',text:'',args:'',streamed:false,initial:block.input,id:block.id,name:block.name};
            } else invalid(codes);
            nextIndex += 1;
        } else if (type === 'content_block_delta') {
            if (phase !== 'blocks' || !open || event.index !== open.index || !only(event,['type','index','delta'])) invalid(codes);
            const delta = row(event.delta,codes);
            if (open.kind === 'text') {
                if (!only(delta,['type','text']) || delta.type !== 'text_delta' || typeof delta.text !== 'string') invalid(codes);
                open.text += delta.text;
            } else {
                // A block that arrived complete can never grow a second, partial copy of its input.
                if (open.streamed === false && Object.keys(open.initial).length) invalid(codes);
                if (!only(delta,['type','partial_json']) || delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') invalid(codes);
                open.args += delta.partial_json; open.streamed = true;
            }
        } else if (type === 'content_block_stop') {
            if (phase !== 'blocks' || !open || event.index !== open.index || !only(event,['type','index'])) invalid(codes);
            if (open.kind === 'text') text += open.text;
            else {
                // A tool with no parameters is still a call: an empty object is the whole input.
                const raw = open.streamed ? open.args : JSON.stringify(open.initial);
                seen.add(open.id);
                calls.push({id:open.id,name:open.name,arguments:toolArguments(raw,safe,codes)});
            }
            sawContent = true; open = undefined;
        } else if (type === 'message_delta') {
            if (phase !== 'blocks' || open || !start || !only(event,['type','delta','usage'])) invalid(codes);
            const delta = row(event.delta,codes);
            if (!only(delta,['stop_reason','stop_sequence']) || typeof delta.stop_reason !== 'string' ||
                !['end_turn','tool_use'].includes(delta.stop_reason) ||
                (delta.stop_sequence !== null && delta.stop_sequence !== undefined)) invalid(codes);
            const usage = object(event.usage) ? event.usage : unknownUsage(codes);
            if (!only(usage,deltaUsageKeys) || !integer(usage.output_tokens) || usage.output_tokens < start.output) unknownUsage(codes);
            // A repeated counter must agree with message_start, never drift.
            for (const key of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens'] as const) {
                if (!Object.hasOwn(usage,key)) continue;
                const expected = key === 'input_tokens' ? start.input : key === 'cache_read_input_tokens' ? start.cacheRead : 0;
                if (usage[key] !== expected) unknownUsage(codes);
            }
            stopReason = delta.stop_reason; outputTokens = Number(usage.output_tokens); phase = 'closed';
        } else if (type === 'message_stop') {
            if (phase !== 'closed' || !only(event,['type'])) invalid(codes);
            stopped = true;
        } else invalid(codes);
    }
    // A missing terminal frame is a truncated answer, not a short one.
    if (!stopped || !start || phase !== 'closed' || !sawContent) invalid(codes);
    if (outputTokens === undefined || !integer(outputTokens)) unknownUsage(codes);
    // The reason and the blocks must agree; a silent turn is never a completed executor turn.
    if ((stopReason === 'tool_use') !== (calls.length > 0)) invalid(codes);
    if (!calls.length && !text.trim()) invalid(codes);
    for (const call of calls) {safe(call.id);safe(call.name);safe(call.arguments);}
    safe(text);
    const inputTokens = start.input + start.cacheRead;
    if (!integer(inputTokens)) unknownUsage(codes);
    return {id:start.id,text,usage:{inputTokens,outputTokens,cacheHitTokens:start.cacheRead},observedModel:start.model,calls};
}

/** message_start, one block per accepted content part, then the terminal frames. */
export function messagesSse(model:string,result:Completion) {
    const {inputTokens,outputTokens,cacheHitTokens} = result.usage;
    const usage = {input_tokens:inputTokens-cacheHitTokens,cache_creation_input_tokens:0,cache_read_input_tokens:cacheHitTokens,output_tokens:0};
    const events:Array<[string,Row]> = [
        ['message_start',{message:{id:result.id,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage}}],
    ];
    let index = 0;
    if (result.text) {
        events.push(['content_block_start',{index,content_block:{type:'text',text:''}}],
            ['content_block_delta',{index,delta:{type:'text_delta',text:result.text}}],['content_block_stop',{index}]);
        index++;
    }
    for (const call of result.calls) {
        events.push(['content_block_start',{index,content_block:{type:'tool_use',id:call.id,name:call.name,input:{}}}],
            ['content_block_delta',{index,delta:{type:'input_json_delta',partial_json:call.arguments}}],['content_block_stop',{index}]);
        index++;
    }
    events.push(['message_delta',{delta:{stop_reason:result.calls.length ? 'tool_use' : 'end_turn',stop_sequence:null},usage:{output_tokens:outputTokens}}],
        ['message_stop',{}]);
    return events.map(([type,fields]) => 'event: '+type+'\ndata: '+JSON.stringify({type,...fields})+'\n\n').join('');
}

export async function readBounded(response:Response, mediaType:string, signal:AbortSignal, codes:LaneCodes) {
    if (response.status !== 200 || response.redirected || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mediaType || !response.body) {
        await response.body?.cancel(); invalid(codes);
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
            if (!(chunk.value instanceof Uint8Array) || chunk.value.length > responseBytes - length) failure('MODEL_GATEWAY_RESPONSE_LIMIT');
            bytes.set(chunk.value,length); length += chunk.value.length;
        }
        return bytes.subarray(0,length);
    } catch (error) {await reader.cancel().catch(()=>{}); throw error;}
    finally {signal.removeEventListener('abort',abort);reader.releaseLock();}
}
