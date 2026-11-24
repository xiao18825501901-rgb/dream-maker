import {createHash} from 'node:crypto';

import {concreteMagpieRoute, type MagpieConcreteRoute} from '../magpie-route.js';
import {DomainError} from '../security.js';
import {parseGatewayJson} from '../gateway-tool-arguments.js';
import type {NativeUsage} from '../native-budget.js';
import {codexExecutorResponsesEvents, type ResponsesCallItem} from './responses-wire.js';
import {
    chatBody, invalid, messagesBody, messagesSse, parseMessagesTurn, parseResponsesTurn, readBounded, readChatStream,
    readMessagesStream, readResponsesStream, requestBytes, responsesBody, unknownUsage,
} from './executor-transcript.js';
import type {LaneCodes, Row, Turn} from './executor-transcript.js';

/**
 * The CLI executor translation lane.
 *
 * The four installed CLIs own their tools: Claude Code, OpenCode and Cline post a Messages
 * request and read a Messages answer, and `codex exec` posts a Responses request and reads
 * Responses events. Those native wires stay passthroughs. A model that declares only one of the
 * OpenAI wires is served here instead: the product gateway translates the whole tool round trip
 * onto Chat or Responses upstream and rebuilds the answer in the dialect the CLI actually reads,
 * which is exactly what the DSH executor lane already does in the other direction. The Codex leg
 * has a third outlet of the same shape: a model that declares only the native Messages wire gets
 * the executor body rendered in the Anthropic dialect (tools as input_schema declarations, calls as
 * tool_use blocks, answers as tool_result blocks) and its answer rebuilt as function_call items.
 *
 * The transcript, both renderers and both stream readers are the shared ones
 * (flow/executor-transcript.ts). What is specific to a CLI turn lives here:
 *   - the 2.1.x client hints a Messages request carries (validated, then dropped: they are not
 *     model input and the native lane drops the same ones before the Magpie hop),
 *   - the trailing system-role message that carries cached system text, folded into the system
 *     prompt instead of being dropped, and
 *   - the Codex ingest, whose Responses document is replayed as the same neutral transcript so a
 *     Chat upstream can answer it.
 *
 * Nothing here authors prompt text. Every string it emits came from the request the CLI sent.
 */

type CliRuntime = 'claude' | 'opencode' | 'cline' | 'codex';
export interface CliExecutorLimits {model:string; maxInputTokens:number; maxOutputTokens:number}
type BoundAccount = Pick<MagpieConcreteRoute,'provider'|'authentication'|'authRef'|'accountRef'|'upstreamAccountRef'> & {
    capabilities?: readonly {model:string;protocol:string}[];
};
export interface CliExecutorContext {
    route:MagpieConcreteRoute; role:string; accounts:readonly BoundAccount[]; limits:Readonly<CliExecutorLimits>;
    assertCurrent():void; assertSafe(value:string):void; signal:AbortSignal;
}
/** The two ingest shapes: a Messages request (three CLIs) or a Responses request (Codex). */
export interface CliMessagesIngress {method:string; path:string; version:string; contentType:string; body:string}
export interface CliResponsesIngress {method:string; path:string; contentType:string; body:string}
export type CliExecutorIngress = CliMessagesIngress | CliResponsesIngress;

const codes:LaneCodes = {request:'CLI_EXECUTOR_REQUEST_INVALID',completion:'MODEL_GATEWAY_COMPLETION_INVALID',usage:'NATIVE_USAGE_UNKNOWN'};
function fail(code:string):never {throw new DomainError(code,code.endsWith('_REQUEST_INVALID')?400:502);}
/** Declared, not a const arrow: control-flow analysis only narrows after a never-returning call
 *  whose declaration carries the annotation. */
function badRequest():never {return fail(codes.request);}
const integer = (n:unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (v:unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v:unknown, keys:readonly string[]): v is Row => object(v) && Object.keys(v).every(key => keys.includes(key));

/** The client-side members a CLI Messages request carries and this lane accepts then drops. */
const messagesHints = ['output_config','context_management','metadata','temperature','top_p','top_k','stop_sequences'] as const;

/**
 * The hints are transport and display instructions, never model input: the effort switch, the
 * context-editing request, a client device id and the sampling knobs all mean nothing on an
 * OpenAI outlet whose provider never agreed to them. Each is shape-checked here so a foreign
 * value is refused rather than silently forwarded, then dropped with the rest.
 */
function checkHints(body:Row):void {
    // Measured on Claude Code 2.1.318: the effort switch is sent as {effort}, the context-editing
    // request as {edits:[...]}, and the client block as a bounded object. Each is validated here
    // and then dropped; an unknown or malformed value is refused rather than forwarded.
    if (body.context_management !== undefined) {
        const management = body.context_management;
        const edits = object(management) && Array.isArray(management.edits) ? management.edits : undefined;
        if (!edits || edits.length > 8) badRequest();
        for (const edit of edits)
            if (!object(edit) || typeof edit.type !== 'string' || !/^[a-z0-9_]{1,64}$/.test(edit.type)) badRequest();
    }
    if (body.output_config !== undefined) {
        const output = body.output_config;
        if (!object(output)) badRequest();
        for (const key of Object.keys(output))
            if (!['effort','format'].includes(key)) badRequest();
        if (output.effort !== undefined && !['low','medium','high','max'].includes(String(output.effort))) badRequest();
        if (output.format !== undefined && !object(output.format)) badRequest();
    }
    if (body.metadata !== undefined && body.metadata !== null && !object(body.metadata)) badRequest();
    for (const key of ['temperature','top_p','top_k'] as const)
        if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key] as number))) badRequest();
    if (body.stop_sequences !== undefined &&
        (!Array.isArray(body.stop_sequences) || body.stop_sequences.length > 8 || body.stop_sequences.some(value => typeof value !== 'string'))) badRequest();
}

/** One validated CLI Messages turn: sixteen declarations, the 2.1.x hints, the trailing system
 *  message the executor arm carries, and the tool history the CLI already ran. */
function messagesTurn(request:unknown, model:string, maxTokens:number):Turn {
    if (Buffer.byteLength(JSON.stringify(request ?? null),'utf8') > requestBytes) badRequest();
    return parseMessagesTurn(request,{model,maxTokens,codes,hints:messagesHints,systemMessages:true,toolHints:true,check:checkHints});
}

/** The Codex Responses document, replayed as the same neutral transcript. */
function responsesTurn(request:unknown, model:string, maxTokens:number):Turn {
    return parseResponsesTurn(request,{model,maxTokens,codes});
}

/**
 * The Responses event sequence a CLI reads back for one accepted turn.
 *
 * A Messages-shaped CLI is answered with Messages frames; `codex exec` is answered with the
 * function_call items it asked for. Both are rebuilt from the validated completion, never from
 * the upstream bytes, so what the CLI reads is exactly what this lane accounted for.
 */
function codexSse(model:string, result:{id:string;text:string;usage:NativeUsage;calls:readonly {id:string;name:string;arguments:string}[]}) {
    const calls:ResponsesCallItem[] = result.calls.map(call => ({itemId:call.id,callId:call.id,name:call.name,arguments:call.arguments}));
    return codexExecutorResponsesEvents({id:result.id,model,text:result.text,calls,usage:result.usage});
}

/** Instantiate once per controller dispatch, after the selected account and role are pinned. */
export function createCliExecutorExchange({route:rawRoute,role,accounts,limits,assertCurrent,assertSafe,signal}:CliExecutorContext) {
    const route = concreteMagpieRoute(rawRoute);
    const {model,protocol} = route;
    const runtime = route.runtime as CliRuntime;
    const codex = runtime === 'codex';
    // Every outlet of one leg is this lane: the CLI's request is validated once, and the resolved
    // protocol picks the upstream body and the reader that answers it. Chat and Responses serve all
    // four legs; Messages serves only Codex, because for the other three it is the native wire.
    const messages = protocol === 'anthropic-messages';
    if (!['claude','opencode','cline','codex'].includes(runtime) || role !== 'executor' ||
        (protocol !== 'chat-completions' && protocol !== 'openai-responses' && protocol !== 'anthropic-messages') ||
        (messages && !codex) || route.authentication !== 'api_key' ||
        !Array.isArray(accounts as unknown)) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    const matches = accounts.filter(a => (['provider','authentication','authRef','accountRef','upstreamAccountRef'] as const).every(key => a[key] === route[key]));
    // The selected protocol must be declared exactly once for this model, and the native wire the
    // CLI speaks must not be declared at all: a model that declares it never reaches this lane.
    const native:MagpieConcreteRoute['protocol'] = codex ? 'openai-responses' : 'anthropic-messages';
    if (matches.length !== 1 || !Array.isArray(matches[0].capabilities) ||
        matches[0].capabilities.some(c => c.model === model && c.protocol === native) ||
        // The Messages outlet is the last rung of the ladder, so a model that also declares Chat
        // would have resolved to that outlet: a Messages route for it is a lane mix-up.
        (messages && matches[0].capabilities.some(c => c.model === model && c.protocol === 'chat-completions')) ||
        matches[0].capabilities.filter(c => c.model === model && c.protocol === protocol).length !== 1) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    if (!only(limits,['model','maxInputTokens','maxOutputTokens']) || limits.model !== model ||
        !integer(limits.maxOutputTokens) || limits.maxOutputTokens < 1 || limits.maxOutputTokens > 16000 ||
        !integer(limits.maxInputTokens) || !limits.maxInputTokens) badRequest();
    const frozenLimits = Object.freeze({...limits});
    const qualifiedModel = route.provider+'/'+model;
    const chat = protocol === 'chat-completions';
    const current = () => {signal.throwIfAborted(); synchronous(assertCurrent());};
    function synchronous(result:unknown) {
        if (result !== undefined) {if (result instanceof Promise) void result.catch(()=>{}); fail('MODEL_GATEWAY_BINDING_INVALID');}
    }
    const safe = (value:string) => synchronous(assertSafe(value));
    let used = false;
    return {prepare(ingress:CliExecutorIngress) {
        current();
        if (used) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
        used = true;
        const contentType = String((ingress as {contentType?:unknown}).contentType ?? '');
        if (ingress.method !== 'POST' || typeof contentType !== 'string' ||
            contentType.split(';')[0].trim().toLowerCase() !== 'application/json') badRequest();
        if (typeof ingress.body !== 'string' || Buffer.byteLength(ingress.body) > requestBytes) badRequest();
        let turn:Turn;
        if (codex) {
            const {path} = ingress as CliResponsesIngress;
            // codex exec appends nothing to the fixed Responses path of its configured base URL.
            if (path !== '/v1/responses') badRequest();
            turn = responsesTurn(parseGatewayJson(ingress.body,safe),model,frozenLimits.maxOutputTokens);
        } else {
            const {path,version} = ingress as CliMessagesIngress;
            // Claude Code appends this literal flag; the admitted upstream path is fixed either way.
            if (!['/v1/messages','/v1/messages?beta=true'].includes(path) || version !== '2023-06-01') badRequest();
            turn = messagesTurn(parseGatewayJson(ingress.body,safe),model,frozenLimits.maxOutputTokens);
        }
        // A Codex executor reads Responses back, so its frozen body is built from the same neutral
        // turn - a Chat upstream gets the Chat dialect, a Responses upstream the item list.
        // One neutral turn, two renderers. A Codex turn onto Chat is the same replay the Messages
        // lane renders - a call becomes a tool_calls entry and its answer a tool row - because the
        // Chat wire has one assistant envelope and no item list to preserve. A Responses upstream
        // gets the item list in both cases.
        const body = messages ? messagesBody(turn,qualifiedModel) : chat ? chatBody(turn,qualifiedModel) : responsesBody(turn,qualifiedModel);
        const wire = JSON.stringify(body);
        if (Buffer.byteLength(wire) > requestBytes) badRequest();
        safe(wire); safe(turn.system);
        let consumed = false;
        return Object.freeze({path:messages ? '/v1/messages' : chat ? '/v1/chat/completions' : '/v1/responses',body:wire,maxOutputTokens:turn.maxTokens,
            async complete(response:Response) {
                current();
                if (consumed) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
                consumed = true;
                const bytes = await readBounded(response,'text/event-stream',signal,codes);
                const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
                safe(text);
                const result = messages ? readMessagesStream(text,model,qualifiedModel,turn.tools,safe,codes)
                    : chat ? readChatStream(text,model,qualifiedModel,turn.tools,safe,codes)
                    : readResponsesStream(text,model,qualifiedModel,turn.tools,safe,codes);
                const usage = result.usage;
                if (!integer(usage.inputTokens + usage.outputTokens)) unknownUsage(codes);
                safe(result.text); safe(result.id); current();
                const responseSha256 = createHash('sha256').update(bytes).digest('hex');
                if (usage.inputTokens > frozenLimits.maxInputTokens || usage.outputTokens > turn.maxTokens) {
                    // The caller settles known excess usage before failing the run. Never attach frames.
                    throw Object.assign(new DomainError('NATIVE_USAGE_BOUND_EXCEEDED',502),{usage,responseSha256});
                }
                return Object.freeze({responseId:result.id,model,observedUpstreamModel:result.observedModel,usage:Object.freeze(usage),responseSha256,
                    outputTextHash:createHash('sha256').update(result.text.trim()).digest('hex'),
                    // One finish-reason vocabulary for every translated lane; the Codex event builder
                    // reads the calls themselves, not this name.
                    finishReason:result.calls.length ? 'tool_use' as const : 'end_turn' as const,
                    sse:codex ? codexSse(model,result) : messagesSse(model,result)});
            },
        });
    }};
}
