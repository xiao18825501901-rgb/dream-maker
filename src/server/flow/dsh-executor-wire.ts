/**
 * The DSH executor translation lane.
 *
 * The pinned DSH SDK only speaks the native Messages wire, so an executor whose account
 * advertises Chat or Responses is served by this lane instead of the byte-identical native
 * passthrough. Unlike supervision, an executor turn is never one terminal tool: the SDK
 * declares up to eight tool functions, receives tool_use blocks, answers them with
 * tool_result blocks on the following user turn, and repeats the round trip until it produces
 * terminal text. The lane freezes every declared tool with its input_schema, replays the
 * completed tool history in the upstream dialect, and turns the upstream tool calls back into
 * Messages tool_use frames.
 *
 * The transcript, the two renderers and both stream readers are shared with the CLI executor
 * lane (flow/executor-transcript.ts), because a CLI executor turn is the same shape: declared
 * tools, a replayed tool history, and a rebuilt Messages answer. This file is only what is
 * specific to DSH - the eight-tool ceiling, the DSH error codes, and the route/account gate.
 */

import {createHash} from 'node:crypto';

import {concreteMagpieRoute, type MagpieConcreteRoute} from '../magpie-route.js';
import {DomainError} from '../security.js';
import type {NativeUsage} from '../native-budget.js';
import {parseGatewayJson} from '../gateway-tool-arguments.js';
import {
    chatBody, messagesSse, parseMessagesTurn, readBounded, readChatStream,
    readResponsesStream, requestBytes, responsesBody, unknownUsage,
} from './executor-transcript.js';
import type {LaneCodes, Row, Turn} from './executor-transcript.js';

export type {Call, DeclaredTool, TurnItem} from './executor-transcript.js';

export type DshExecutorLimits = {model:string; maxInputTokens:number; maxOutputTokens:number};
export interface DshExecutorContext {
    route:MagpieConcreteRoute; role:string; accounts:readonly BoundAccount[]; limits:Readonly<DshExecutorLimits>;
    assertCurrent():void; assertSafe(value:string):void; signal:AbortSignal;
}
export interface DshExecutorIngress {method:string; path:string; version:string; contentType:string; body:string}
type BoundAccount = Pick<MagpieConcreteRoute,'provider'|'authentication'|'authRef'|'accountRef'|'upstreamAccountRef'> & {
    capabilities?: readonly {model:string;protocol:string}[];
};
const maxTools = 8;
const codes:LaneCodes = {request:'CLAUDE_MESSAGES_REQUEST_INVALID',completion:'MODEL_GATEWAY_COMPLETION_INVALID',usage:'NATIVE_USAGE_UNKNOWN'};
function fail(code:string):never {throw new DomainError(code,code==='CLAUDE_MESSAGES_REQUEST_INVALID'?400:502);}
const badRequest = ():never => fail(codes.request);
const integer = (n:unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (v:unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v:unknown, keys:readonly string[]): v is Row => object(v) && Object.keys(v).every(key => keys.includes(key));

/** The DSH executor turn: eight tools at most, and no trailing system-role message. */
function executorTurn(request:unknown, model:string, limits:DshExecutorLimits):Turn {
    return parseMessagesTurn(request,{model,maxTokens:limits.maxOutputTokens,codes,maxTools,requireThinking:true});
}


/** Instantiate once per controller dispatch, after the selected account and role are pinned. */
export function createDshExecutorExchange({route:rawRoute,role,accounts,limits,assertCurrent,assertSafe,signal}:DshExecutorContext) {
    const route = concreteMagpieRoute(rawRoute);
    const {model,protocol} = route;
    // Both OpenAI outlets are the same lane; the resolved protocol picks the requests it builds.
    const chat = protocol === 'chat-completions';
    if (route.runtime !== 'dsh' || role !== 'executor' || (!chat && protocol !== 'openai-responses') || route.authentication !== 'api_key' ||
        !Array.isArray(accounts as unknown)) fail('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE');
    const matches = accounts.filter(a => (['provider','authentication','authRef','accountRef','upstreamAccountRef'] as const).every(key => a[key] === route[key]));
    // The selected protocol must be declared exactly once for this model; a model that declares
    // only the other OpenAI wire never reaches this branch.
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
    return {prepare({method,path,version,contentType,body:raw}:DshExecutorIngress) {
        current();
        if (used) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
        used = true;
        if (method !== 'POST' || !['/v1/messages','/v1/messages?beta=true'].includes(path) || version !== '2023-06-01' ||
            typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') badRequest();
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > requestBytes) badRequest();
        const turn = executorTurn(parseGatewayJson(raw,safe),model,frozenLimits);
        const body = chat ? chatBody(turn,qualifiedModel) : responsesBody(turn,qualifiedModel);
        const wire = JSON.stringify(body);
        if (Buffer.byteLength(wire) > requestBytes) badRequest();
        safe(wire); safe(turn.system);
        let consumed = false;
        return Object.freeze({path:chat ? '/v1/chat/completions' : '/v1/responses',body:wire,maxOutputTokens:turn.maxTokens,
            async complete(response:Response) {
                current();
                if (consumed) fail('MAGPIE_MODEL_REQUEST_ALREADY_USED');
                consumed = true;
                const bytes = await readBounded(response,'text/event-stream',signal,codes);
                const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
                safe(text);
                const result = chat ? readChatStream(text,model,qualifiedModel,turn.tools,safe,codes,maxTools) : readResponsesStream(text,model,qualifiedModel,turn.tools,safe,codes,maxTools);
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
                    finishReason:result.calls.length ? 'tool_use' as const : 'end_turn' as const,sse:messagesSse(model,result)});
            },
        });
    }};
}
