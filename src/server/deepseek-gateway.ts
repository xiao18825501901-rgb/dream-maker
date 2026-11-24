import {readPiNativeSse,assertPiNativeReplySafe,piReadOnlyToolsOnly,type PiNativeReply} from './flow/pi-native-wire.js';
import {CodexPlannerStream} from './flow/codex-planner-stream.js';
import type {CodexIncludedTurn} from './providers/codex.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { once } from 'node:events';
import { DomainError, hasSecret, object, hash, redact, networkFailureError, boundedResponseText } from './security.js';
import { NativeBudget, type NativePrice, type NativeUsage,type ProbeBudgetPermit,type EngineeringBudgetPermit,type CustomProbeBudgetPermit } from './native-budget.js';
import type {NativeRequestBinding} from '../shared/native-request.js';
import type {MagpieDshRequestTransport,PreparedMagpieModelRequest} from './magpie-model-transport.js';
import {GatewayToolArguments,GatewayToolArgumentError,parseGatewayJson} from './gateway-tool-arguments.js';
import {classifyNetworkFailure,classifyNetworkResponse,type NetworkFailureClass} from './network-failure.js';
import {responsesRequestToChat,responsesDocument,responsesEvents,chatResult,codexExecutorResponsesEvents} from './flow/responses-wire.js';
import {chatSupervisorCompletion} from './flow/chat-supervisor-responses.js';
import {isPaidCodexResponsesRoute} from './flow/paid-codex-responses.js';

const chatUpstream = 'https://api.deepseek.com/chat/completions';
const messagesUpstream = 'https://api.deepseek.com/anthropic/v1/messages';
const model = 'deepseek-flash';
const maxBodyBytes = 262144, maxResponseBytes = 2000000;
/** Finite per-request upstream ceiling: default 120s, operator-tightenable, never above 300s. */
function upstreamDeadlineMs(): number {
    const raw = Number(process.env.DM_GATEWAY_DEADLINE_MS ?? 120000);
    return Number.isSafeInteger(raw) && raw >= 5000 && raw <= 300000 ? raw : 120000;
}
type Receipt = { id: string; upstream: string; requestedModel: string; responseModelMatched: boolean;
    responseId:string|null; observedModel:string|null; finishReason:string|null;
    responseSha256:string|null; outputTextHash:string|null; completionObserved:boolean; minimalResponseVerified:boolean;
    protocolEventCount:number; protocolLastEventType:string|null; protocolLastEventDetail:string|null;protocolFailureStage:string|null;
    toolArgumentFailureDetail:string|null;
    upstreamHttpStatus:number|null;upstreamContentType:string|null;upstreamBodyShape:string|null;upstreamBodyBytes:number|null;upstreamBodySha256:string|null;upstreamBodyCode:string|null;
    upstreamRequestIdSha256:string|null;transportErrorCode:string|null;elapsedMs:number;elapsedMsCapped:boolean;
    networkFailureClass:NetworkFailureClass|null;automaticRetryAllowed:boolean;
    outcome: string; usage: NativeUsage | null; reservedMicros: number; recordedAt: string };

function normalizedMediaType(value:unknown):string|null {
    if(typeof value!=='string')return null;
    const mediaType=value.split(';',1)[0].trim().toLowerCase();
    return mediaType.length>0&&mediaType.length<=127&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)?mediaType:null;
}

function diagnosticBodyShape(value:string):string {
    const text=value.trim();
    if(!text)return 'EMPTY';
    if(text.startsWith('{'))try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return 'JSON_OBJECT';}catch{}
    if(text.startsWith('['))try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return 'JSON_ARRAY';}catch{}
    if(/^(?:data|event):/m.test(text))return 'SSE';
    if(/^<!doctype\s+html\b|^<html\b/i.test(text))return 'HTML';
    return 'TEXT';
}

function diagnosticBodyCode(value:string):string|null {
    const text=value.trim();
    const safe=(code:unknown)=>typeof code==='string'&&/^[A-Z][A-Z0-9_:-]{2,119}$/.test(code)&&!hasSecret(code)?code:null;
    const direct=safe(text);
    if(direct)return direct;
    try{
        const parsed=JSON.parse(text) as Record<string,unknown>;
        const error=parsed.error;
        const nested=error&&typeof error==='object'?object(error).code:error;
        return safe(nested)??safe(parsed.code);
    }catch{return null;}
}

function parseUpstreamEnvelope(raw:string,safe:(text:string)=>void,failureCode:string):unknown {
    try{return parseGatewayJson(raw,safe);}
    catch(error){
        if(error instanceof GatewayToolArgumentError&&error.detail==='JSON_PARSE')throw new DomainError(failureCode,502);
        throw error;
    }
}

// Names the inbound values the request gate measures. Kept in its own function so the diagnostic can never
// widen or narrow the surrounding request body type. Local instance stderr only.
function logInboundRequest(served:string,ceiling:number,body:unknown):void {
    const b=body as {model?:unknown;messages?:unknown;max_tokens?:unknown;stream?:unknown}|null;
    process.stderr.write('GATEWAY_INBOUND '+JSON.stringify({model:b?.model,served,messages:Array.isArray(b?.messages)?(b.messages as unknown[]).length:null,maxTokens:b?.max_tokens,ceiling,stream:typeof b?.stream})+'\n');
}

// Preserve a useful transport diagnosis without serializing exceptions, proxy details or headers.
function allowedTransportError(error:unknown):string|null {
    const allowed=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','ENOTFOUND','ABORT_ERR','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
    let value=error;
    try{for(let depth=0;depth<3&&value&&typeof value==='object';depth++){
        const fields=Object.getOwnPropertyDescriptors(value),code=fields.code?.value;
        if(typeof code==='string'&&allowed.has(code))return code;
        value=fields.cause?.value;
    }}catch{/* Diagnostics must not replace the original failure. */}
    return null;
}

function toolResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const v=value as Record<string, unknown>;
    if (v.type==='tool_use' || v.type==='input_json_delta' || v.finish_reason==='tool_calls' || v.finish_reason==='function_call' ||
        Array.isArray(v.tool_calls) && v.tool_calls.length>0 || v.function_call && typeof v.function_call==='object') return true;
    return [v.content,v.choices].some(a=>Array.isArray(a)&&a.some(toolResponse)) ||
        [v.message,v.delta,v.content_block].some(toolResponse);
}
function supervisionToolNames(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const v=value as Record<string,unknown>, parts:unknown[]=[];
    if (Array.isArray(v.content)) parts.push(...v.content);
    if (v.type==='content_block_start'&&v.content_block&&typeof v.content_block==='object')
        parts.push(v.content_block);
    if (v.type==='message_start'&&v.message&&typeof v.message==='object'&&
        Array.isArray((v.message as Record<string,unknown>).content))
        parts.push(...((v.message as Record<string,unknown>).content as unknown[]));
    return parts.flatMap(part=>{
        if(!part||typeof part!=='object')return [];
        const block=part as Record<string,unknown>;
        return block.type==='tool_use'&&typeof block.name==='string'?[block.name]:[];
    });
}
// Anthropic Messages reports one request's usage on two frames and three disjoint input counters:
// input_tokens is the uncached remainder, cache_creation_input_tokens the writes that are billed at
// the miss price, and cache_read_input_tokens the hits. The ledger's NativeUsage wants ONE total
// input that already contains the reads, because NativeBudget.settle splits them back out with
// cacheHitTokens and prices only the remainder at the miss rate. So the three collapse to
// input = input_tokens + cache_creation + cache_read, cacheHit = cache_read — the same three-way
// normalization the Pi lane already applies to its own message_start/message_delta pair.
//
// The counters are not in one frame: message_start carries the input side (plus a placeholder output
// count), message_delta carries the cumulative output count and may repeat the rest. Reading either
// frame alone loses part of the charge; reading neither — this lane's previous behaviour — lost all
// of it and settled the whole 1 MiB input reservation instead (measured 9830x the real cost on the
// 2026-11-21 executor probe: 78 in / 8 out really cost 220 micros, the ledger charged 2162688).
//
// A counter that is present but not a non-negative safe integer poisons its side instead of being
// coerced to zero, and a frame with nothing billable leaves the meter untouched, so a garbled report
// can never masquerade as a cheap one. `seen` is the only thing standing between a KNOWN settlement
// and the reservation fallback: it records that the upstream reported at least one real counter.
type MessagesMeter = { inputTokens: number; cacheHitTokens: number; outputTokens: number | null; seen: boolean };
const emptyMessagesMeter = (): MessagesMeter => ({ inputTokens: 0, cacheHitTokens: 0, outputTokens: null, seen: false });
function meterMessagesUsage(raw: unknown, prior: MessagesMeter): MessagesMeter {
    if (!raw || typeof raw !== 'object') return prior;
    const value = raw as Record<string, unknown>;
    const count = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    // An absent input counter is a zero; a present-but-unreadable one disables the input side.
    const counter = (key: string): number | null => value[key] === undefined ? 0 : count(value[key]);
    const missed = counter('input_tokens'), read = counter('cache_read_input_tokens'), created = counter('cache_creation_input_tokens');
    const output = value.output_tokens === undefined ? null : count(value.output_tokens);
    const inputReported = value.input_tokens !== undefined || value.cache_read_input_tokens !== undefined || value.cache_creation_input_tokens !== undefined;
    const next = { ...prior };
    if (inputReported && missed !== null && read !== null && created !== null) {
        const inputTokens = missed + read + created;
        if (Number.isSafeInteger(inputTokens)) { next.inputTokens = inputTokens; next.cacheHitTokens = read; next.seen = true; }
    }
    // message_delta repeats the cumulative count, so the last frame that reported one wins.
    if (output !== null) { next.outputTokens = output; next.seen = true; }
    return next;
}

export function waitGatewayDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
    return new Promise((resolve,reject)=>{
        const cleanup=()=>{res.off('drain',drained);res.off('close',failed);res.off('error',failed);signal.removeEventListener('abort',failed);};
        const drained=()=>{cleanup();resolve();};
        const failed=()=>{cleanup();reject(new DomainError('MODEL_GATEWAY_DISCONNECTED',502));};
        res.once('drain',drained);res.once('close',failed);res.once('error',failed);
        signal.addEventListener('abort',failed,{once:true});
        if(signal.aborted || res.destroyed)failed();
    });
}

// Only the trusted controller may receive the ephemeral bearer. Generated code
// must have neither this listener's network reachability nor its bearer.
export class DeepSeekGateway {
    private token = randomBytes(32).toString('hex');
    private accepted = 0;
    private closing = false;
    private supervisionTool: 'submit_engineering_plan' | 'submit_review' | null = null;
    /** The translated outlet of a CLI executor leg, decided once in the constructor. */
    private cliExecutorTranslated = false;
    private readonly paidResponses: boolean;
    private evidence: Receipt[] = [];
    private controllers = new Set<AbortController>();
    private handlers = new Set<Promise<void>>();
    private server = createServer((req, res) => {
        const pending = this.handle(req, res).catch(() => { if (!res.destroyed) res.destroy(); });
        this.handlers.add(pending);
        void pending.finally(() => this.handlers.delete(pending));
    });
    constructor(private budget: NativeBudget, private quote: () => NativePrice, private apiKey: string,
        private maxOutputTokens: number, private maximumRequests: number, private transport: typeof fetch = fetch,
        private wire: 'chat-completions' | 'anthropic-messages' | 'responses' = 'chat-completions', private forbidTools = false,private probePermit?:ProbeBudgetPermit,
        private bindRequest?:(bodyHash:string)=>NativeRequestBinding,
        private engineering?:{permit:EngineeringBudgetPermit;assertCurrent:()=>void},private magpie?:MagpieDshRequestTransport,
        private customProbe?:{permit:CustomProbeBudgetPermit;assertCurrent:(binding:NativeRequestBinding)=>void},
        /** Exact model this gateway serves. Roles may pin different DM-approved
         *  models (each with its own price), so the served id is per instance
         *  instead of the historical single-role constant. */
        private servedModel: string = model, private includedTurn?:()=>CodexIncludedTurn) {
        if(typeof servedModel!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(servedModel))
            throw new DomainError('MODEL_GATEWAY_MODEL_BINDING_INVALID',409);
        const subscription=magpie?.concreteRoute?.authentication==='oauth';
        if(subscription!==!!includedTurn || subscription&&(wire!=='responses'||magpie?.role!=='planner2'||servedModel!=='gpt-6-luna'||maximumRequests!==1))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        const pi=magpie?.piNative;
        // Two Pi purposes on one wire. An executor turn carries the five desk tools (the write three
        // included) and is admitted by the transport's executor lane; a read-only turn is admitted
        // only while its session limits stay inside PI_READ_ONLY_TOOLS, so this gateway is the last
        // place a widened read-only tool set could be stopped and it refuses it as a different
        // purpose. A probe stays tool-free on both.
        // The read role is admitted only with the frozen read-only pair in its session limits; the
        // executor purpose is the only one that may carry a write tool. A pi session on a foreign
        // route, or a read-only purpose whose limits widened past desk_read/desk_search, is refused
        // here, which is the last point before a request body could be prepared.
        const piPurposeOk=magpie!==undefined?magpie.concreteRoute?.runtime==='pi'&&(magpie.role==='executor'||piReadOnlyToolsOnly(pi!.limits.tools)):false;
        if(pi&&(wire!==(pi.limits.protocol==='openai-responses'?'responses':'anthropic-messages')||!piPurposeOk||servedModel!==pi.limits.model||customProbe&&pi.limits.tools.length))throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        const official=magpie?.officialCliResponses===true;
        // Declared before any purpose guard reads it: a translated CLI executor outlet is a lane of
        // its own (its own ingress wire, its own build set) and must be distinguishable everywhere
        // the read-only and passthrough purposes are decided.
        const translatedExecutor=magpie?.cliExecutorTranslated===true;
        // The Codex executor's third outlet: the CLI still posts its Responses turn here and the
        // product renders the Messages body upstream (flow/cli-executor-wire.ts). It is a translated
        // outlet like the two OpenAI ones, and the only lane allowed to pair runtime codex with the
        // native Messages wire - the read-only Codex lane is the other one, and it carries no tools.
        const cliExecutorMessages=translatedExecutor&&magpie!.concreteRoute.runtime==='codex'&&magpie!.concreteRoute.protocol==='anthropic-messages';
        this.paidResponses=official||isPaidCodexResponsesRoute(magpie?.concreteRoute);
        // The DSH supervision lane posts Messages to this gateway and puts the declared Chat or
        // Responses dialect on the Magpie hop, so it is never a native Responses route.
        const dshSupervised=magpie?.dshSupervisorTranslated===true;
        if(dshSupervised&&(wire!=='anthropic-messages'||magpie!.role==='executor'||servedModel!==magpie!.concreteRoute.model||magpie!.concreteRoute.protocol==='anthropic-messages'))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        // The DSH executor lane is the same direction with tools: the SDK posts Messages here and
        // the transport replays the whole tool history onto the Chat or Responses upstream. It is
        // executor-only and never the native wire, so it can never be reached by a supervision role
        // or a native route.
        const dshExecutorLane=magpie?.dshExecutorTranslated===true;
        if(dshExecutorLane&&(wire!=='anthropic-messages'||magpie!.role!=='executor'||servedModel!==magpie!.concreteRoute.model||magpie!.concreteRoute.protocol==='anthropic-messages'))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        if(magpie?.claudeTranslated&&(wire!=='anthropic-messages'||magpie.role==='executor'||maximumRequests!==1||servedModel!==magpie.concreteRoute.model))throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        // The Codex read-only lane is the mirror image: Codex posts Responses here and the
        // transport sends Messages upstream. It is never a native Responses passthrough.
        const codexSupervised=magpie?.codexSupervisorTranslated===true;
        if(codexSupervised&&(wire!=='responses'||magpie!.role==='executor'||servedModel!==magpie!.concreteRoute.model||magpie!.concreteRoute.protocol!=='anthropic-messages'))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        if(!codexSupervised&&!cliExecutorMessages&&magpie?.concreteRoute?.runtime==='codex'&&magpie.concreteRoute.authentication==='api_key'&&magpie.concreteRoute.protocol==='anthropic-messages')
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        // A Codex executor keeps the Responses passthrough without being a paid or subscription
        // route: the CLI reads Responses locally and the lane is its own purpose above.
        if(!subscription&&!pi&&!magpie?.cliExecutor&&!translatedExecutor&&!magpie?.claudeTranslated&&!dshSupervised&&!dshExecutorLane&&magpie?.concreteRoute?.protocol==='openai-responses'&&(!this.paidResponses||wire!==(official?'chat-completions':'responses')||magpie.role==='executor'||official&&(maximumRequests!==1||servedModel!==magpie.concreteRoute.model)))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        if(subscription||this.paidResponses)this.forbidTools=true;
        if(customProbe){
            const d=Object.getOwnPropertyDescriptors(customProbe);
            if(Reflect.ownKeys(d).length!==2||!d.permit?.enumerable||!Object.hasOwn(d.permit,'value')||!d.assertCurrent?.enumerable||!Object.hasOwn(d.assertCurrent,'value')||typeof d.assertCurrent.value!=='function'||
                // A Custom qualification probe keeps the same one-request, permit-bound purpose for
                // every harness: DSH speaks anthropic-messages, Codex/independent speak chat-completions.
                !magpie||!['anthropic-messages','chat-completions','responses'].includes(wire)||
                // Both executor harnesses send their native wire directly to the frozen upstream route.
                magpie.role==='executor'&&!pi&&!(magpie.concreteRoute?.protocol===wire&&(
                    magpie.concreteRoute.runtime==='dsh'&&wire==='anthropic-messages'||
                    magpie.concreteRoute.runtime==='pi'&&wire==='chat-completions'))||
                apiKey!==''||!Number.isSafeInteger(maximumRequests)||maximumRequests<1||maximumRequests>4||magpie.role==='executor'&&maximumRequests!==1||probePermit!==undefined||bindRequest!==undefined||engineering!==undefined)throw new DomainError('CUSTOM_PROBE_GATEWAY_PURPOSE_INVALID',409);
            this.customProbe=Object.freeze({permit:customProbe.permit,assertCurrent:customProbe.assertCurrent});this.forbidTools=true;
        }
        if(magpie&&(!['anthropic-messages','chat-completions','responses'].includes(wire)||apiKey!==''||forbidTools&&magpie.role==='executor'&&!customProbe||probePermit!==undefined||bindRequest!==undefined||engineering!==undefined))throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        // Chat/Responses supervisors submit their result as text. Their runner exposes
        // no tools, so a model-emitted tool call is a protocol violation rather than
        // data to parse. Enforce that at the Gateway boundary for every caller.
        // A read-only Pi role is the one supervision purpose that is not text-only: it holds the
        // frozen read pair, so its tool call is the intent rather than a protocol violation.
        const piReadOnlyLane=pi!==undefined&&magpie!.role!=='executor'&&piReadOnlyToolsOnly(pi.limits.tools);
        if(magpie&&!customProbe&&magpie.role!=='executor'&&!piReadOnlyLane&&wire!=='anthropic-messages')this.forbidTools=true;
        // Only the Messages wire has a documented forced-named-tool shape for the
        // supervisor roles. Codex/independent speak chat or Responses and submit
        // their structured result as text validated by the controller.
        // One installed CLI, two Custom purposes. A read-only supervisor answers a single text
        // turn with no tools at all; an executor turn is the same CLI working through its own
        // edit/shell tools, so it keeps the native Messages wire and many requests. The
        // supervisor requirement below therefore binds the read-only purpose only; applying it
        // to the executor purpose is what made every Claude executor turn unbuildable before.
        const claudeExecutor=magpie?.claudeExecutor===true;
        if(magpie?.concreteRoute?.runtime==='claude'&&!magpie.claudeSupervisor&&!claudeExecutor&&!translatedExecutor)
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        if(claudeExecutor&&(wire!=='anthropic-messages'||magpie!.role!=='executor'||servedModel!==magpie!.concreteRoute.model||forbidTools||
            magpie!.concreteRoute.protocol!=='anthropic-messages'||maximumRequests<1||maximumRequests>200))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        if(magpie?.claudeSupervisor&&!claudeExecutor){
            if(wire!=='anthropic-messages')throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
            this.forbidTools=true;
        }
        // The other three CLI executor legs are one purpose shape: the harness's own tools, one
        // request per tool round, and the native wire the CLI speaks. OpenCode and Cline post
        // Messages; Codex posts Responses. None of them is a translated lane or a supervision lane,
        // so a foreign wire, a supervisor-shaped channel, a tool-forbidding purpose, a foreign model
        // or a ceiling above the per-run cap is refused before a byte is sent.
        // The translated outlet of the same four legs: the CLI speaks its own wire at this gateway
        // and the product replays that turn onto the OpenAI wire the model declares. It is the same
        // purpose shape (executor, its own tools, one request per tool round) on the other wire pair.
        const cliExecutorTranslated=this.cliExecutorTranslated=magpie?.cliExecutorTranslated===true;
        // The Messages protocol is admitted here for the Codex outlet only: for the three Messages
        // CLIs it is the native wire, which is a different purpose decided above, and the Codex
        // read-only lane keeps its own flag. The ingress wire never changes: Codex reads Responses.
        if(cliExecutorTranslated&&(magpie!.role!=='executor'||servedModel!==magpie!.concreteRoute.model||forbidTools||
            (magpie!.concreteRoute.protocol==='anthropic-messages'&&!cliExecutorMessages)||
            wire!==(magpie!.concreteRoute.runtime==='codex'?'responses':'anthropic-messages')||maximumRequests<1||maximumRequests>200))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        const cliExecutor=magpie?.cliExecutor;
        const cliNativeWire=cliExecutor==='codex'?'openai-responses':'anthropic-messages';
        if(cliExecutor&&(wire!==(cliExecutor==='codex'?'responses':'anthropic-messages')||magpie!.role!=='executor'||servedModel!==magpie!.concreteRoute.model||forbidTools||
            magpie!.concreteRoute.protocol!==cliNativeWire||maximumRequests<1||maximumRequests>200))
            throw new DomainError('MAGPIE_GATEWAY_PURPOSE_INVALID',409);
        // A read-only text CLI on the Messages wire declares no tools; it must not be handed the
        // DSH named supervision tool, and a model-emitted tool call stays a protocol violation.
        // The same CLI as an executor is the opposite purpose and keeps its tools.
        const readonlyMessagesCli=!cliExecutor&&!!magpie?.concreteRoute&&['opencode','cline'].includes(magpie.concreteRoute.runtime)&&wire==='anthropic-messages';
        if(readonlyMessagesCli)this.forbidTools=true;
        if(magpie&&!magpie.claudeSupervisor&&!customProbe&&!readonlyMessagesCli&&magpie.role!=='executor'&&wire==='anthropic-messages')
            this.supervisionTool=magpie.role==='planner2'?'submit_engineering_plan':'submit_review';
        if(engineering&&(forbidTools||probePermit!==undefined||bindRequest!==undefined||maximumRequests>8))throw new DomainError('ENGINEERING_GATEWAY_PURPOSE_INVALID',409);
        if ((!apiKey&&!magpie) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 16000 ||
            // The per-run request ceiling is a resource bound, not a protocol constant. It was 30, and a real
            // executor turn spends one model request per tool call, so run_286dac8d258e7a25a38e died at
            // done=0/8 with MODEL_GATEWAY_LIMITS_INVALID the moment the caller asked for the raise it needed.
            // 200 keeps it finite and stays below the lifetime operator ceiling, which is validated separately.
            !Number.isSafeInteger(maximumRequests) || maximumRequests < 1 || maximumRequests > 200)
            throw new DomainError('MODEL_GATEWAY_LIMITS_INVALID');
        this.server.headersTimeout = 5000;
        this.server.requestTimeout = 10000;
    }
    async start() {
        this.server.listen(0, '127.0.0.1');
        await once(this.server, 'listening');
        const address = this.server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new DomainError('MODEL_GATEWAY_BINDING_INVALID');
        return { url: `http://127.0.0.1:${address.port}/${this.includedTurn?'backend-api/codex':'v1'}`, token: this.token };
    }
    confirmedPiOutput(model:string,text:string,requestId:string|undefined):Receipt {
        const last=this.evidence.at(-1);
        if(!this.magpie?.piNative||model!==this.servedModel||!last||last.id!==requestId||!text.trim()||
            this.evidence.some(r=>r.outcome!=='COMPLETE'||!r.responseModelMatched||r.observedModel!==model||!r.completionObserved||!r.responseId||!r.responseSha256)||
            !['stop','end_turn'].includes(last.finishReason??'')||last.outputTextHash!==hash(text.trim()))
            throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
        return {...last};
    }
    confirmedSupervisorOutput(model:string,text:string):Receipt {
        const rows=this.evidence, last=rows.at(-1);
        if(!this.magpie||this.magpie.role==='executor'||model!==this.servedModel||!last||
            !text.trim()||rows.some(r=>r.outcome!=='COMPLETE'||!r.responseModelMatched||r.observedModel!==model||
            !r.completionObserved||!r.responseId||!r.responseSha256)||last.outputTextHash!==hash(text.trim()))
            throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
        return structuredClone(last);
    }
    receipts(): Receipt[] { return structuredClone(this.evidence); }
    private assertProbeCurrent(binding:NativeRequestBinding):void {
        if(!this.customProbe)return;
        const result:unknown=this.customProbe.assertCurrent(binding);
        if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw new DomainError('CUSTOM_PROBE_CURRENT_RESULT_INVALID',409);}
    }
    private error(res: ServerResponse, status: number, code: string) {
        if (!res.headersSent && !res.destroyed) {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: { code } }));
        } else if (!res.destroyed) res.destroy();
    }
    private usage(value: unknown): NativeUsage | null {
        if (!value || typeof value !== 'object') return null;
        const v = value as Record<string, unknown>;
        if (![v.prompt_tokens, v.completion_tokens].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null;
        const cache = v.prompt_cache_hit_tokens === undefined ? 0 : v.prompt_cache_hit_tokens;
        if (typeof cache !== 'number' || !Number.isSafeInteger(cache) || cache < 0 || cache > Number(v.prompt_tokens)) return null;
        return { inputTokens: Number(v.prompt_tokens), outputTokens: Number(v.completion_tokens), cacheHitTokens: cache };
    }
    /**
     * Fold this lane's two-frame Messages meter into the ledger's NativeUsage.
     *
     * An output count must have been reported by SOME frame: a turn whose stream carries input only
     * is not a zero-output turn, and pricing it as one would under-bill a real answer. Input counters
     * settle when they were reported, and a partner that reports only one half is billed for that
     * half — the alternative is charging the whole reservation for a turn whose cost the upstream did
     * report in part. The receipt keeps the exact numbers, so any such gap stays auditable.
     * Returning null is the reservation fallback: it means no real usage reached this lane at all.
     */
    private messagesUsage(meter: MessagesMeter): NativeUsage | null {
        return meter.seen && meter.outputTokens !== null
            ? { inputTokens: meter.inputTokens, outputTokens: meter.outputTokens, cacheHitTokens: meter.cacheHitTokens }
            : null;
    }
    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.closing) return this.error(res, 503, 'MODEL_GATEWAY_CLOSING');
        const messages = this.wire === 'anthropic-messages';
        const responses = this.wire === 'responses';
        const pi=this.magpie?.piNative;
        const nativeKey = req.headers['x-api-key'];
        const subscription=!!this.includedTurn,paidResponses=this.paidResponses,nativeResponses=subscription||paidResponses;
        if(pi&&((req.headersDistinct[messages?'x-api-key':'authorization']?.length!==1)||req.headersDistinct[messages?'authorization':'x-api-key']||req.headersDistinct['x-dm-gateway']||req.headersDistinct['chatgpt-account-id']))return this.error(res,401,'MODEL_GATEWAY_UNAUTHORIZED');
        if(paidResponses&&(req.headersDistinct.authorization?.length!==1||req.headersDistinct['x-dm-gateway']||req.headersDistinct['chatgpt-account-id']))
            return this.error(res,401,'MODEL_GATEWAY_UNAUTHORIZED');
        if(subscription&&['x-dm-gateway','authorization','chatgpt-account-id'].some(k=>(req.headersDistinct[k]?.length??0)>(k==='chatgpt-account-id'?1:0)&&req.headersDistinct[k]?.length!==1))return this.error(res,401,'MODEL_GATEWAY_UNAUTHORIZED');
        const actual = subscription?Buffer.from('Bearer '+(req.headers['x-dm-gateway']??'')):Buffer.from(req.headers.authorization ?? (messages && typeof nativeKey === 'string' ? 'Bearer ' + nativeKey : ''));
        const expected = Buffer.from('Bearer ' + this.token);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return this.error(res, 401, 'MODEL_GATEWAY_UNAUTHORIZED');
        const path = subscription?'/backend-api/codex/responses':messages ? '/v1/messages' : responses ? '/v1/responses' : '/v1/chat/completions';
        // Claude Code 2.1.318 appends this literal flag. The admitted upstream path is still fixed.
        // The executor arm of the same CLI keeps this literal flag too: one installed binary sends
        // the same query string whether it is reviewing or executing, and the admitted upstream
        // path is fixed either way.
        const claudeMessages = messages && (pi||this.magpie?.claudeSupervisor||this.magpie?.claudeExecutor||!!this.magpie?.cliExecutor||this.cliExecutorTranslated) && req.url === '/v1/messages?beta=true';
        if (req.method !== 'POST' || (req.url !== path && !claudeMessages) ||
            !req.headers['content-type']?.startsWith('application/json')) return this.error(res, 400, 'MODEL_GATEWAY_ROUTE_DENIED');
        const codexSupervised=this.magpie?.codexSupervisorTranslated===true;
        // The three new CLI executor legs pass their own native body straight through: OpenCode and
        // Cline on Messages, Codex on Responses. A CLI executor's Responses document is a Responses
        // document, not a Chat request to translate, so it joins the native passthrough set.
        const cliExecutorResponses=this.magpie?.cliExecutor==='codex';
        // The Claude/DSH lanes read a Messages request here; the Codex lane reads Responses.
        const cliTranslated=this.cliExecutorTranslated;
        const translated=!codexSupervised&&(this.magpie?.supervisorTranslated===true||cliTranslated);
        // The Anthropic header shape belongs to a Messages ingress only. A Codex ingress on the
        // translated outlet is an ordinary Responses client and is admitted by the bearer rule below.
        if(translated&&messages&&((req.headersDistinct.authorization?.length??0)+(req.headersDistinct['x-api-key']?.length??0)!==1||
            req.headersDistinct['anthropic-version']?.length!==1||req.headersDistinct['content-type']?.length!==1))return this.error(res,400,'MODEL_GATEWAY_ROUTE_DENIED');
        // A translated Codex turn sends its own bearer and no Anthropic header, exactly like the
        // native Codex passthrough it replaces.
        if(cliTranslated&&responses&&(req.headersDistinct.authorization?.length!==1||
            (req.headersDistinct['x-api-key']?.length??0)!==0||(req.headersDistinct['anthropic-version']?.length??0)!==0))
            return this.error(res,400,'MODEL_GATEWAY_ROUTE_DENIED');
        // Codex sends its own bearer and no Anthropic headers; only the exact bearer is admitted.
        if(codexSupervised&&(req.headersDistinct.authorization?.length!==1||req.headersDistinct['content-type']?.length!==1||
            (req.headersDistinct['x-api-key']?.length??0)!==0||(req.headersDistinct['anthropic-version']?.length??0)!==0||(req.headersDistinct['x-dm-gateway']?.length??0)!==0))
            return this.error(res,400,'MODEL_GATEWAY_ROUTE_DENIED');
        let rawMessages='';
        let body: Record<string, unknown>;
        let responsesStream = false;
        let chatPayload: Record<string, unknown> | null = null;
        let officialResult: NonNullable<ReturnType<CodexPlannerStream['observe']>> | undefined;
        try {
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > maxBodyBytes) throw new DomainError('MODEL_GATEWAY_BODY_LIMIT');
                chunks.push(chunk);
            }
            const bytes=Buffer.concat(chunks);
            if(translated||codexSupervised)rawMessages=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes);
            const inbound = JSON.parse(translated||codexSupervised?rawMessages:bytes.toString('utf8'));
            if (inbound && typeof inbound === 'object' && !Array.isArray(inbound) && inbound.store !== undefined && inbound.store !== false)
                throw new DomainError('RESPONSES_REQUEST_INVALID', 400);
            body = (pi||nativeResponses||codexSupervised||cliExecutorResponses||cliTranslated)?inbound:responses ? (() => {
                const translated = responsesRequestToChat(inbound, { model: this.servedModel, maxOutputTokens: this.maxOutputTokens });
                responsesStream = translated.stream;
                return translated.chat as unknown as Record<string, unknown>;
            })() : inbound;
            // codex exec sets its output budget by configuration, not in the request. The lane's
            // ceiling is the frozen per-run one, so the Gateway states it instead of leaving the
            // body without the limit the ledger reserves against.
            if (cliExecutorResponses && body && !Array.isArray(body) && body.max_output_tokens === undefined) body.max_output_tokens = this.maxOutputTokens;
            // Cline 3.0.74 states the bound of its own model table in every request (measured:
            // max_tokens 38400 for claude-sonnet-5 on the installed binary) and exposes no flag,
            // provider setting or catalog entry that lowers it — the provider `maxTokens` field is
            // validated and then unused as the request bound. The run ceiling is the product's, so
            // the request it forwards is clamped to it. Clamping can only LOWER the CLI's own
            // preference; it never widens the operator's allowance, and the ledger reserves against
            // exactly the number left here. Scoped to this one leg: no other lane's body changes.
            if (this.magpie?.cliExecutor === 'cline' && body && !Array.isArray(body) &&
                typeof body.max_tokens === 'number' && body.max_tokens > this.maxOutputTokens)
                body.max_tokens = this.maxOutputTokens;
            try{logInboundRequest(this.servedModel,this.maxOutputTokens,body);}catch{/* Diagnostics must never change the result. */}
            if (!pi&&!translated&&!cliTranslated&&!codexSupervised&&!nativeResponses&&!cliExecutorResponses&&(!body || Array.isArray(body) || body.model !== this.servedModel || !Array.isArray(body.messages) || !body.messages.length ||
                !Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1 || Number(body.max_tokens) > this.maxOutputTokens ||
                ('max_completion_tokens' in body) || ('n' in body && body.n !== 1) || ('stream' in body && typeof body.stream !== 'boolean')))
                throw new DomainError('MODEL_GATEWAY_MODEL_OR_LIMIT_DENIED');
        } catch { return this.error(res, 400, 'MODEL_GATEWAY_MODEL_OR_LIMIT_DENIED'); }
        if(!translated&&this.magpie?.claudeSupervisor&&(body.tool_choice!==undefined||body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.length!==0)))
            return this.error(res,400,'CUSTOM_SUPERVISION_TOOLSET_INVALID');
        if (!pi&&!translated&&!cliTranslated&&!codexSupervised&&!nativeResponses&&this.forbidTools) { body.tools = []; delete body.tool_choice; }
        if (this.supervisionTool) {
            const tools=body.tools;
            if(!Array.isArray(tools)||tools.length!==1||!tools[0]||typeof tools[0]!=='object'||Array.isArray(tools[0])||
                (tools[0] as Record<string,unknown>).name!==this.supervisionTool)
                return this.error(res,400,'CUSTOM_SUPERVISION_TOOLSET_INVALID');
            // The official Messages wire supports forcing one named tool. Keep the
            // supervision turn read-only while exposing its only terminal submission.
            body.tool_choice={type:'tool',name:this.supervisionTool};
            // DeepSeek rejects forced named tools while thinking is enabled. The
            // supervision roles already have reasoningEffort=off, so make that
            // routing decision explicit on the Anthropic Messages wire as well.
            body.thinking={type:'disabled'};
        }
        // Diagnostic only: DeepSeek's Messages wire defaults thinking to ENABLED when the field is absent, and an
        // enabled request that replays assistant tool turns without their thinking blocks is rejected with
        // 400 INVALID_REQUEST ("content[].thinking ... must be passed back"). That is what surfaced as
        // RUNNER_RPC_ERROR after eleven successful executor dispatches. Naming the value on stderr tells the
        // operator whether the caller already disabled it. No secrets, no prompt text.
        process.stderr.write('GATEWAY_THINKING '+JSON.stringify({thinking:(body as {thinking?:unknown}).thinking??null,stream:!!body.stream,tools:Array.isArray(body.tools)?body.tools.length:null,translated:!!translated,supervision:!!this.supervisionTool})+'\n');
        if (!pi&&!nativeResponses&&!codexSupervised&&!translated&&!messages&&body.stream) body.stream_options = { include_usage: true };
        let upstreamBody=translated||codexSupervised?rawMessages:JSON.stringify(body);
        const abort=new AbortController();
        const claudeDeadline=translated||codexSupervised?AbortSignal.any([abort.signal,AbortSignal.timeout(upstreamDeadlineMs())]):undefined;
        const safeResponse=(value:string)=>{
            if(this.apiKey&&value.includes(this.apiKey)||hasSecret(value)||translated&&value.includes(this.token))throw new DomainError('MODEL_GATEWAY_SECRET_IN_RESPONSE',502);
            this.magpie?.assertSafeResponse(value);
        };
        if (res.destroyed) return;
        let reservation,prepared:PreparedMagpieModelRequest|undefined;
        let piBegan=false;
        let paidOutputTokens:number|undefined,paidMaxInputTokens:number|undefined;
        let credentials:{turn:CodexIncludedTurn;authorization:string;accountId?:string}|undefined;
        try {
            if (this.accepted >= this.maximumRequests) throw new DomainError('NATIVE_INNER_REQUEST_LIMIT', 409);
            const price = subscription?undefined:this.quote();
            if (price&&(price.provider !== (this.magpie?.provider??'deepseek-official') || price.model !== this.servedModel)) throw new DomainError('NATIVE_PRICE_ROUTE_MISMATCH', 409);
            this.engineering?.assertCurrent();
            if(pi){
                if(price?.maxInputTokens!==pi.limits.maxInputTokens)throw new DomainError('NATIVE_PRICE_ROUTE_MISMATCH',409);
                pi.begin();piBegan=true;
            }
            if(cliTranslated){
                if(!price)throw new DomainError('NATIVE_PRICE_UNKNOWN',409);
                prepared=this.magpie!.prepareCliExecutor(
                    messages
                        ? {method:req.method!,path:req.url!,contentType:String(req.headers['content-type']),version:String(req.headers['anthropic-version']),body:rawMessages}
                        : {method:req.method!,path:req.url!,contentType:String(req.headers['content-type']),body:rawMessages},
                    price.maxInputTokens,this.maxOutputTokens,claudeDeadline!,safeResponse);
                upstreamBody=prepared.body;
                paidOutputTokens=prepared.maxOutputTokens;
            }else if(translated){
                if(!price)throw new DomainError('NATIVE_PRICE_UNKNOWN',409);
                prepared=this.magpie!.prepareClaude({method:req.method!,path:req.url!,contentType:req.headers['content-type']!,version:String(req.headers['anthropic-version']),body:rawMessages},price.maxInputTokens,this.maxOutputTokens,claudeDeadline!,safeResponse);
                upstreamBody=prepared.body;
                paidOutputTokens=prepared.maxOutputTokens;
            }else if(codexSupervised){
                if(!price)throw new DomainError('NATIVE_PRICE_UNKNOWN',409);
                prepared=this.magpie!.prepareCodexSupervisor({method:req.method!,path:req.url!,contentType:req.headers['content-type'] as string,body:rawMessages},price.maxInputTokens,this.maxOutputTokens,claudeDeadline!,safeResponse);
                upstreamBody=prepared.body;
                paidOutputTokens=prepared.maxOutputTokens;
            }else if(this.magpie){prepared=this.magpie.prepare(upstreamBody);upstreamBody=prepared.body;}
            if(pi){const payload=object(JSON.parse(upstreamBody));paidOutputTokens=Number(messages?payload.max_tokens:payload.max_output_tokens);}
            // The codex executor lane is a Responses client like the paid planner one: the request it
            // sent declares its own output ceiling and asks for a stream, so the same three members are
            // the only shape the reply is measured against.
            if(paidResponses||cliExecutorResponses){
                const wire=object(JSON.parse(upstreamBody)),limit=wire.max_output_tokens;
                if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>this.maxOutputTokens||wire.stream!==true||wire.store!==false)
                    throw new DomainError('MODEL_GATEWAY_MODEL_OR_LIMIT_DENIED',409);
                paidOutputTokens=limit;paidMaxInputTokens=price?.maxInputTokens;
                // The executor arm of the same wire reserves against the same price, so its reply is
                // measured against the same input ceiling.
                if(cliExecutorResponses)paidMaxInputTokens??=price?.maxInputTokens;
            }
            if(this.customProbe)this.assertProbeCurrent(prepared!.binding);
            if(subscription){
                const authorization=req.headers.authorization,accountId=req.headers['chatgpt-account-id'];
                if(!prepared||typeof authorization!=='string'||!/^Bearer [a-zA-Z0-9._~+/=-]{1,16384}$/.test(authorization)||accountId!==undefined&&(typeof accountId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,170}$/.test(accountId)))throw new DomainError('CODEX_SUBSCRIPTION_GATEWAY_REQUIRED',409);
                credentials={turn:this.includedTurn!(),authorization,accountId};
                reservation=this.budget.reserveIncludedPlanner(credentials.turn,prepared.binding,this.magpie!.concreteRoute,Number(JSON.parse(prepared.body).max_output_tokens),this.customProbe?.permit);
            }else if(!price)throw new DomainError('NATIVE_PRICE_UNKNOWN',409);
            else {
                const outputTokens=paidOutputTokens??Number(body.max_tokens);
                reservation = this.customProbe?this.budget.reserveCustomProbe(this.customProbe.permit,price,outputTokens,prepared!.binding,this.servedModel,this.magpie!.concreteRoute):this.engineering?this.budget.reserveEngineering(this.engineering.permit,price,outputTokens,hash(upstreamBody)):
                    this.budget.reserve(prepared?.binding.role??'executor', price, outputTokens,this.probePermit,prepared?.binding??this.bindRequest?.(hash(upstreamBody)));
            }
            this.accepted++;
        } catch (e) { if(piBegan)pi!.close();return this.error(res, 409, e instanceof DomainError ? e.code : 'NATIVE_PRICE_UNKNOWN'); }
        // Per-upstream-request ceiling. It was a hard 30s, which is shorter than a reasoning turn that
        // emits a tool_use block: 13 of 41 executor requests were cut mid-stream and reported as
        // FAILED_OR_DISCONNECTED (DOMException 'This operation was aborted') even though the model had
        // already produced its tool call. 120s is still a finite ceiling, stays below the bridge deadline
        // (limits.stepTimeoutMs) and can be tightened by the operator via DM_GATEWAY_DEADLINE_MS.
        const deadline=claudeDeadline??AbortSignal.any([abort.signal,AbortSignal.timeout(upstreamDeadlineMs())]);
        this.controllers.add(abort);
        const startedAt = Date.now();
        const monotonicStart=performance.now();
        let abortedBy = '';
        const disconnected = () => { if (!res.writableFinished) { abortedBy = 'client-close'; abort.abort(); } };
        res.on('close', disconnected);
        let usage: NativeUsage | null = null, outcome = 'UNKNOWN', responseModelMatched = false;
        // The Messages lane spreads one request's usage over message_start and message_delta; it is
        // metered across the whole turn and only folded into `usage` once it is billable.
        const messagesMeter = emptyMessagesMeter();
        let usageLimitExceeded=false,settleExceededUsage=false;
        let settledChatBody:string|undefined,settledMessages:string|undefined,translatedTextHash:string|undefined,piReply:PiNativeReply|undefined;
        // The executor arm of the codex lane is answered in the other direction: the CLI asked for
        // tools and has to read the calls back as Responses items, exactly as Go admitted them.
        let executorCalls:readonly {itemId:string;callId:string;name:string;arguments:string}[]|undefined,
            executorText='',executorId:string|undefined,executorUsage:NativeUsage|null=null;
        let upstreamHttpStatus:number|null=null,upstreamContentType:string|null=null;
        let protocolEventCount=0,protocolLastEventType:string|null=null,protocolLastEventDetail:string|null=null,protocolFailureStage:string|null=null;
        let toolArgumentFailureDetail:string|null=null;
        let upstreamBodyShape:string|null=null,upstreamBodyBytes:number|null=null,upstreamBodySha256:string|null=null,upstreamBodyCode:string|null=null;
        let upstreamRequestIdSha256:string|null=null,transportErrorCode:string|null=null;
        let networkFailureClass:NetworkFailureClass|null=null,automaticRetryAllowed=false;
        let responseId:string|null=null,observedModel:string|null=null,finishReason:string|null=null;
        let responseSha256:string|null=null;
        let contentSeen=false,toolsSeen=false,toolsReleased=false;
        let responseText='';
        const recordBodyDiagnostic=(value:string)=>{
            upstreamBodyShape=diagnosticBodyShape(value);
            upstreamBodyBytes=Buffer.byteLength(value);
            upstreamBodySha256=hash(value);
            upstreamBodyCode=diagnosticBodyCode(value);
        };
        const toolArguments=new GatewayToolArguments(safeResponse);
        const observeText=(value:unknown)=>{
            if(typeof value!=='string')return;
            responseText+=value;safeResponse(responseText);
            if(value.trim())contentSeen=true;
        };
        const identity=(value:Record<string,unknown>)=>{
            // Magpie may expose its exact provider-qualified route to the upstream. Accept
            // that spelling only for the prepared Magpie request, and keep the receipt's
            // observed identity normalized to DM's bare fixed model ID.
            const magpieCanonical=this.magpie?.responseModel??null;
            if(value.model!==this.servedModel&&(!magpieCanonical||value.model!==magpieCanonical))
                throw new DomainError('MODEL_GATEWAY_RESPONSE_MODEL_MISMATCH',502);
            if(typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(value.id)||hasSecret(value.id)||this.apiKey&&value.id.includes(this.apiKey))
                throw new DomainError('MODEL_GATEWAY_RESPONSE_ID_INVALID',502);
            if(responseId&&responseId!==value.id)throw new DomainError('MODEL_GATEWAY_RESPONSE_ID_CHANGED',502);
            responseId=value.id;observedModel=this.servedModel;responseModelMatched=true;
        };
        const finish=(reason:unknown)=>{
            if(reason==null)return;
            const allowed=messages?['end_turn','tool_use','max_tokens','stop_sequence']:['stop','tool_calls','function_call','length','content_filter'];
            if(typeof reason!=='string'||!allowed.includes(reason))throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
            if(finishReason)throw new DomainError('MODEL_GATEWAY_EVENT_AFTER_COMPLETION',502);
            finishReason=reason;
        };
        const complete=()=>{
            toolArguments.complete();
            if(!responseId||!finishReason||(!contentSeen&&!toolsSeen))throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
            if(this.forbidTools&&!(messages?['end_turn','stop_sequence']:['stop']).includes(finishReason))
                throw new DomainError(this.customProbe?'CUSTOM_PROBE_OUTPUT_INCOMPLETE':this.magpie&&this.magpie.role!=='executor'?'CUSTOM_SUPERVISION_OUTPUT_INCOMPLETE':'MINIMAL_PROBE_OUTPUT_INCOMPLETE',502);
            if(this.customProbe)this.assertProbeCurrent(prepared!.binding);
        };
        const observe=(raw:unknown,streaming:boolean)=>{
            const value=object(raw);
            safeResponse(JSON.stringify(value));
            const tools=toolResponse(value);toolsSeen ||= tools;
            if(this.supervisionTool&&supervisionToolNames(value).some(name=>name!==this.supervisionTool))
                throw new DomainError('CUSTOM_SUPERVISION_TOOL_RESPONSE_DENIED',502);
            if(this.forbidTools&&tools)throw new DomainError(this.customProbe?'CUSTOM_PROBE_TOOL_RESPONSE_DENIED':this.magpie&&this.magpie.role!=='executor'?'CUSTOM_SUPERVISION_TOOL_RESPONSE_DENIED':'MINIMAL_PROBE_TOOL_RESPONSE_DENIED',502);
            if(!messages){
                identity(value);
                if(!Array.isArray(value.choices)||value.choices.length>1)throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
                if(value.choices.length){
                    const choice=object(value.choices[0]);
                    if(finishReason)throw new DomainError('MODEL_GATEWAY_EVENT_AFTER_COMPLETION',502);
                    if(choice.index!=null&&choice.index!==0)throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
                    const output=object((streaming?choice.delta:choice.message)??{});
                    toolArguments.chatOutput(output,streaming);
                    observeText(output.content);
                    finish(choice.finish_reason);
                }else if(!streaming||!value.usage)throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
                return;
            }
            if(!streaming){
                identity(value);
                if(!Array.isArray(value.content))throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
                for(const c of value.content){const part=object(c);toolArguments.messagesContent(part);if(part.type==='text')observeText(part.text);}
                Object.assign(messagesMeter,meterMessagesUsage(value.usage,messagesMeter));
                finish(value.stop_reason);return;
            }
            if(value.type==='ping')return;
            if(value.type==='message_start'){
                if(responseId)throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
                const message=object(value.message??{});identity(message);Object.assign(messagesMeter,meterMessagesUsage(message.usage,messagesMeter));if(Array.isArray(message.content))for(const raw of message.content)toolArguments.messagesContent(object(raw));return;
            }
            if(!responseId)throw new DomainError('MODEL_GATEWAY_RESPONSE_ID_INVALID',502);
            if(value.type==='message_stop'){complete();return;}
            if(finishReason)throw new DomainError('MODEL_GATEWAY_EVENT_AFTER_COMPLETION',502);
            if(value.type==='message_delta'){Object.assign(messagesMeter,meterMessagesUsage(value.usage,messagesMeter));finish(object(value.delta??{}).stop_reason);return;}
            if(typeof value.type!=='string'||!['content_block_start','content_block_delta','content_block_stop'].includes(value.type))throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
            toolArguments.messagesEvent(value);
            const content=object((value.type==='content_block_delta'?value.delta:value.content_block)??{});
            observeText(content.text);
        };
        const upstream = this.magpie?.upstream??(messages ? messagesUpstream : chatUpstream);
        try {
            // Opt-in, redacted diagnostic: how many tools the harness actually declared, and which top-level keys
        // the request carried. This is the cheapest way to tell "the model ignored its tools" apart from
        // "the harness never sent any" without dumping prompts or secrets.
        if (process.env.DM_GATEWAY_TRACE === '1')
            console.error('GATEWAY_TRACE ' + JSON.stringify({ keys: Object.keys(body), toolCount: Array.isArray(body.tools) ? body.tools.length : -1, stream: !!body.stream }));
            const response = this.magpie?await this.magpie.send(prepared!,reservation.id,deadline,credentials):await this.transport(upstream, { method: 'POST', redirect: 'error',
                headers: { 'content-type': 'application/json', ...(messages ? { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + this.apiKey }) },
                body: upstreamBody, signal: deadline });
            try{const status=response.status;upstreamHttpStatus=typeof status==='number'&&Number.isSafeInteger(status)&&status>=100&&status<=599?status:null;}catch{/* Optional observation only. */}
            try{upstreamContentType=normalizedMediaType(response.headers.get('content-type'));}catch{/* Malformed diagnostic headers cannot alter the model result. */}
            try{const upstreamRequestId=response.headers.get('x-request-id')??response.headers.get('request-id');
                if(typeof upstreamRequestId==='string'&&upstreamRequestId.length>0&&upstreamRequestId.length<=512)upstreamRequestIdSha256=hash(upstreamRequestId);
            }catch{/* Malformed diagnostic headers cannot alter the model result. */}
            if (!response.ok) {
                const verified=await this.magpie?.consumeVerifiedOverage(response,prepared!,reservation.id);
                if(verified){usage=verified;settleExceededUsage=true;throw new DomainError('NATIVE_USAGE_BOUND_EXCEEDED',502);}
                let requestId:string|null=null;
                try{requestId=response.headers.get('x-request-id')??response.headers.get('request-id');}catch{/* Optional diagnostics only. */}
                const failureBody=response.bodyUsed?'':await boundedResponseText(response,64*1024);
                // Keep the exact rejected request so an upstream refusal can be replayed and bisected instead of
                // guessed at. Local instance data only; never returned to a client and never printed.
                try{writeFileSync(resolve(process.cwd(),'.runtime','upstream-'+String(response.status)+'-'+Date.now()+'.json'),typeof upstreamBody==='string'?upstreamBody:JSON.stringify(upstreamBody));}catch{/* Diagnostics must never change the result. */}
                // The runner only ever reported "DeepSeek Messages request failed (400)", which made a real
                // upstream rejection indistinguishable from a transport fault. Naming the upstream status and a
                // redacted excerpt on stderr keeps that diagnosable without logging prompts or credentials.
                process.stderr.write('GATEWAY_UPSTREAM_ERROR '+JSON.stringify({status:response.status,body:redact(String(failureBody)).slice(0,400)})+'\n');
                const failure=classifyNetworkResponse({
                    status:response.status,
                    body:failureBody,
                    requestId
                });
                networkFailureClass=failure.classification;
                automaticRetryAllowed=failure.automaticRetryAllowed;
                throw networkFailureError(failure,'MODEL_GATEWAY_UPSTREAM_FAILURE');
            }
            if(prepared?.completeClaude){
                let result;
                try{result=await prepared.completeClaude(response);}catch(error){
                    if(error instanceof DomainError&&error.code==='NATIVE_USAGE_BOUND_EXCEEDED'&&'usage' in error&&'responseSha256' in error){
                        usage=error.usage as NativeUsage;responseSha256=String(error.responseSha256);settleExceededUsage=true;
                    }
                    throw error;
                }
                if(deadline.aborted||res.destroyed)throw new DomainError('MODEL_GATEWAY_DISCONNECTED',502);
                if(this.customProbe)this.assertProbeCurrent(prepared.binding);
                this.magpie!.assertPreparedCurrent(prepared);
                usage=result.usage;responseId=result.responseId;observedModel=result.model;responseModelMatched=true;
                finishReason=result.finishReason;responseSha256=result.responseSha256;translatedTextHash=result.outputTextHash;
                settledMessages=result.sse;outcome='COMPLETE';return;
            }
            if (!response.body) {
                const failure=classifyNetworkFailure({error:{code:'MODEL_GATEWAY_STREAM_INCOMPLETE'},context:'RESPONSE'});
                networkFailureClass=failure.classification;
                automaticRetryAllowed=failure.automaticRetryAllowed;
                throw networkFailureError(failure,'MODEL_GATEWAY_UPSTREAM_FAILURE');
            }
            const contentType = response.headers.get('content-type') ?? '';
            // A Codex executor reads real Responses events, so the same stream parser the paid
            // Codex lane uses reassembles its answer; it carries no paid limits, so no plan document
            // is invented for it.
            const nativeStream=(nativeResponses||cliExecutorResponses)?new CodexPlannerStream(this.servedModel,paidResponses||cliExecutorResponses?
                {qualifiedModel:this.magpie?.responseModel??this.servedModel,maxInputTokens:paidMaxInputTokens??this.maxOutputTokens,maxOutputTokens:paidOutputTokens??this.maxOutputTokens}:undefined,
                // Only the codex CLI executor lane is answered with function_call items; the paid
                // planner lane keeps the single-message transcript it has always been given.
                cliExecutorResponses===true):undefined;
            const streaming = nativeResponses||cliExecutorResponses||!!body.stream;
            if (streaming ? !contentType.startsWith('text/event-stream') : !contentType.startsWith('application/json')) {
                try{
                    const diagnostic=await boundedResponseText(response,64*1024);
                    recordBodyDiagnostic(diagnostic);
                }catch{/* The type error remains authoritative when the bounded body cannot be inspected. */}
                if(upstreamHttpStatus!==null&&upstreamHttpStatus>=200&&upstreamHttpStatus<300){
                    const failure=classifyNetworkResponse({status:upstreamHttpStatus});
                    networkFailureClass=failure.classification;
                    automaticRetryAllowed=failure.automaticRetryAllowed;
                    throw networkFailureError(failure,'MODEL_GATEWAY_UPSTREAM_TYPE');
                }
                throw new DomainError('MODEL_GATEWAY_UPSTREAM_TYPE', 502);
            }
            if(pi){
                piReply=await readPiNativeSse(response.body,pi.limits,deadline);
                usage=piReply.usage;
                if(piReply.usageLimitExceeded){settleExceededUsage=true;throw new DomainError('NATIVE_USAGE_BOUND_EXCEEDED',502);}
                assertPiNativeReplySafe(piReply,safeResponse);identity({id:piReply.id,model:piReply.model});
                observeText(piReply.text);toolsSeen=!!piReply.toolCall;
                finish(messages?(toolsSeen?'tool_use':'end_turn'):(toolsSeen?'tool_calls':'stop'));
                if(this.forbidTools&&toolsSeen)throw new DomainError('CUSTOM_PROBE_OUTPUT_INCOMPLETE',502);
                responseSha256=hash(piReply.sse);outcome='COMPLETE';
            }else{
            const reader = response.body.getReader(), decoder = new TextDecoder('utf8', { fatal: true }),digest=createHash('sha256');
            let size = 0, pending = '', raw = '', eventRaw = '', bufferedProbe = '', bufferedTools = '', doneSeen = false, dataLines: string[] = [];
            if (streaming && !this.forbidTools) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
            try {
                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    size += chunk.value.length;
                    if (size > maxResponseBytes) throw new DomainError('MODEL_GATEWAY_RESPONSE_LIMIT', 502);
                    digest.update(chunk.value);
                    const text = decoder.decode(chunk.value, { stream: true });
                    if (!streaming) { raw += text; continue; }
                    pending += text;
                    let boundary;
                    while ((boundary = pending.indexOf('\n')) >= 0) {
                        eventRaw += pending.slice(0, boundary + 1);
                        const line = pending.slice(0, boundary).replace(/\r$/, ''); pending = pending.slice(boundary + 1);
                        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
                        if (line) continue;
                        const data = dataLines.join('\n'); dataLines = [];
                        if(data&&doneSeen)throw new DomainError('MODEL_GATEWAY_EVENT_AFTER_COMPLETION',502);
                        if (data === '[DONE]') {
                            if(messages||nativeStream)throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
                            complete();doneSeen = true;
                        }
                        else if (data) {
                            protocolFailureStage='PARSE';
                            const parsed = parseUpstreamEnvelope(data,safeResponse,'MODEL_GATEWAY_STREAM_DATA_INVALID') as Record<string,unknown>;
                            if(nativeStream){
                                protocolFailureStage='OBSERVE';
                                protocolEventCount=nativeStream.eventCount;
                                let result;
                                try{result=nativeStream.observe(parsed);}
                                catch(error){
                                    protocolEventCount=nativeStream.eventCount;
                                    protocolLastEventType=nativeStream.lastEventType;
                                    protocolLastEventDetail=nativeStream.lastEventDetail;
                                    throw error;
                                }
                                protocolEventCount=nativeStream.eventCount;
                                protocolLastEventType=nativeStream.lastEventType;
                                protocolLastEventDetail=nativeStream.lastEventDetail;
                                if(result){
                                    protocolFailureStage='COMPLETE_ASSEMBLY';
                                    executorCalls=result.calls;executorText=result.text;executorId=result.id;executorUsage=result.usage;
                                    // A call round is an answered turn on this lane: the CLI reads the
                                    // items back instead of a text delta, so the answer is present even
                                    // when the turn carried no text at all.
                                    if(executorCalls&&executorCalls.length)toolsSeen=true;
                                    identity({model:this.servedModel,id:result.id});observeText(result.text);finish('stop');complete();doneSeen=true;
                                    usage=result.usage;usageLimitExceeded=result.usageLimitExceeded;
                                    if(this.magpie?.officialCliResponses)officialResult=result;
                                }
                                if(paidResponses&&['response.created','response.in_progress','response.completed'].includes(String(parsed.type)))
                                    object(parsed.response).model=this.servedModel;
                                eventRaw='event: '+parsed.type+'\n'+'data: '+JSON.stringify(parsed)+'\n\n';
                            }else observe(parsed,true);
                            if (messages && parsed.type === 'message_stop') doneSeen = true;
                            // The Messages lane reports its usage across two frames, so its meter is
                            // folded after every event and settles only once it is billable. The Chat
                            // lane repeats one usage chunk and keeps assigning on sight.
                            if (!nativeStream) {
                                if (messages) usage = this.messagesUsage(messagesMeter);
                                else if (parsed.usage) usage = this.usage(parsed.usage);
                            }
                        }
                        // Never forward a partial or unvalidated event to a tool-capable SDK.
                        if(nativeStream&&!data)eventRaw='';
                        protocolFailureStage='RESPONSE_SAFETY';
                        safeResponse(eventRaw);
                        if (res.destroyed || deadline.aborted) throw new DomainError('MODEL_GATEWAY_DISCONNECTED', 502);
                        // The SDK may close as soon as it sees end_turn. Minimum probes require the
                        // full validated upstream transcript and its digest before anything is delivered.
                        // size above bounds this buffer to maxResponseBytes; tool turns keep streaming.
                        // The codex executor lane is not a passthrough: its transcript is rebuilt from the
                        // validated items below, because the CLI has to read function_call items back, not
                        // the raw upstream frames the paid planner lane forwards.
                        if(cliExecutorResponses){/* rebuilt at completion */}
                        else if(this.forbidTools)bufferedProbe+=eventRaw;
                        else if(toolsSeen)bufferedTools+=eventRaw;
                        else if (!res.write(eventRaw)) await waitGatewayDrain(res,deadline);
                        eventRaw = '';
                        protocolFailureStage=null;
                    }
                }
                const tail = decoder.decode();
                if (streaming) {
                    if (!doneSeen || dataLines.length || eventRaw || (pending + tail).trim()) throw new DomainError('MODEL_GATEWAY_STREAM_INCOMPLETE', 502);
                } else {
                    raw += tail;
                    protocolFailureStage='PARSE';
                    let parsed:Record<string,unknown>;
                    try{parsed=parseUpstreamEnvelope(raw,safeResponse,'MODEL_GATEWAY_UPSTREAM_JSON_INVALID') as Record<string,unknown>;}
                    catch(error){recordBodyDiagnostic(raw);throw error;}
                    protocolFailureStage='OBSERVE';
                    observe(parsed,false);complete();
                    chatPayload = parsed;
                    usage = messages ? this.messagesUsage(messagesMeter) : this.usage(parsed.usage);
                }
                if (deadline.aborted || res.destroyed) throw new DomainError('MODEL_GATEWAY_DISCONNECTED', 502);
                if(this.customProbe)this.assertProbeCurrent(prepared!.binding);
                if(paidResponses||codexSupervised)this.magpie!.assertPreparedCurrent(prepared!);
                responseSha256=digest.digest('hex');
                if(usageLimitExceeded){
                    // A fully verified overage blocks the output but still settles actual reported usage.
                    settleExceededUsage=true;
                    throw new DomainError('NATIVE_USAGE_BOUND_EXCEEDED',502);
                }
                const officialChat=this.magpie?.officialCliResponses&&officialResult?chatSupervisorCompletion(officialResult,this.servedModel):undefined;
                if(this.magpie?.officialCliResponses&&!officialChat)throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);
                outcome = 'COMPLETE';
                if(officialChat){
                    settledChatBody=JSON.stringify(officialChat);
                }else if(cliExecutorResponses&&streaming&&executorId){
                    // The Go lane proved this transcript whole before it released a byte; the CLI now
                    // gets the same items the paid planner lane would have received, calls included.
                    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
                    res.end(codexExecutorResponsesEvents({id:executorId,model:this.servedModel,text:executorText,
                        calls:executorCalls??[],usage:executorUsage??{inputTokens:0,outputTokens:0}}));
                }else if(streaming&&this.forbidTools){
                    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
                    res.end(bufferedProbe);
                }else if(!streaming){
                    // Cancellation and final controller currentness above must win before
                    // the first success header or byte can escape a buffered response.
                    if(responses){
                        const result=chatResult(chatPayload!,this.servedModel);
                        if(responsesStream){
                            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
                            res.end(responsesEvents(result));
                        }else{
                            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                            res.end(JSON.stringify(responsesDocument(result)));
                        }
                    }else{
                        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });res.end(raw);
                    }
                }else if(toolsSeen){toolsReleased=true;res.end(bufferedTools);}else res.end();
            } finally { await reader.cancel().catch(() => {}); }
            }
            if(settledChatBody||piReply){
                if(deadline.aborted||res.destroyed)throw new DomainError('MODEL_GATEWAY_DISCONNECTED',502);
                if(this.customProbe)this.assertProbeCurrent(prepared!.binding);
                this.magpie!.assertPreparedCurrent(prepared!);
            }
        } catch (e) {
            if(!settleExceededUsage)usage = null;
            if(e instanceof GatewayToolArgumentError)toolArgumentFailureDetail=e.detail;
            transportErrorCode=allowedTransportError(e);
            const classified=(e as {networkFailure?:{classification:NetworkFailureClass;automaticRetryAllowed:boolean}})?.networkFailure;
            if(classified){networkFailureClass=classified.classification;automaticRetryAllowed=classified.automaticRetryAllowed;}
            else if(!(e instanceof DomainError)&&!(e instanceof Error&&e.name==='AbortError')){
                const failure=classifyNetworkFailure({error:e,context:'RESPONSE',httpStatus:upstreamHttpStatus});
                networkFailureClass=failure.classification;automaticRetryAllowed=failure.automaticRetryAllowed;
            }
            // A tool_use answer is COMPLETE the moment the client stops reading: the harness closes the
            // connection as soon as it has the tool call (10/10 on run_bdff6947245af4e0122d, elapsed
            // 0.9-5.3s, finishReason=tool_use, contentSeen||toolsSeen). Recording that as a failure burned
            // the repair budget and told the SDK an already-answered turn had broken. Success is only
            // claimed when the completion itself was observed, never on a bare disconnect.
            const answeredBeforeClose = !pi&&!this.forbidTools && abortedBy === 'client-close' && finishReason !== null && (contentSeen || toolsSeen)&&(!toolsSeen||toolsReleased);
            outcome = answeredBeforeClose ? 'COMPLETE' : (e instanceof DomainError ? e.code : 'FAILED_OR_DISCONNECTED');
            // Redacted diagnostic: the failing exception's TYPE and a short message only — never the body,
            // the prompt or a key. Without this, a truncated upstream stream looks identical to a bug here.
            if (process.env.DM_GATEWAY_TRACE === '1')
                console.error('GATEWAY_FAIL ' + JSON.stringify({ type: e instanceof Error ? e.constructor.name : typeof e, message: redact(String((e as Error)?.message ?? e)).slice(0, 160), outcome, toolArgumentFailureDetail, source: abortedBy || (abort.signal.aborted ? 'abort-controller' : 'deadline-or-upstream'), elapsedMs: Date.now() - startedAt, responseId: responseId || null, finishReason: finishReason || null, contentSeen, toolsSeen }));
            if (!answeredBeforeClose && !res.writableEnded && !res.destroyed) this.error(res, 502, outcome);
        } finally {
            res.off('close', disconnected);
            this.controllers.delete(abort);
            if(pi&&outcome!=='COMPLETE')pi.close();
            try { this.budget.settle(reservation.id, usage, outcome); }
            catch (error) { pi?.close(); throw error; }
            if(pi&&piReply&&outcome==='COMPLETE'){
                try {
                    this.magpie!.assertPreparedCurrent(prepared!);
                    if(this.customProbe)this.assertProbeCurrent(prepared!.binding);
                    if(deadline.aborted||res.destroyed)throw new DomainError('MODEL_GATEWAY_DISCONNECTED',502);
                    pi.settle(piReply.toolCall);
                } catch(error) {
                    pi.close();outcome=error instanceof DomainError?error.code:'PI_TURN_RELEASE_FAILED';
                    if(!res.destroyed&&!res.writableEnded)this.error(res,502,outcome);
                }
            }
            if(settledMessages){
                try{
                    if(deadline.aborted||res.destroyed)throw new DomainError('MODEL_GATEWAY_DISCONNECTED',502);
                    this.magpie!.assertPreparedCurrent(prepared!);
                    if(this.customProbe)this.assertProbeCurrent(prepared!.binding);
                }catch(error){
                    outcome=error instanceof DomainError?error.code:'NATIVE_REQUEST_BINDING_STALE';
                    settledMessages=undefined;
                    if(!res.destroyed)this.error(res,502,outcome);
                }
            }
            const elapsed=Math.floor(Math.max(0,performance.now()-monotonicStart));
            this.evidence.push({ id: reservation.id, upstream, requestedModel: this.servedModel, responseModelMatched,
                responseId,observedModel,finishReason,responseSha256,outputTextHash:outcome==='COMPLETE'?(translatedTextHash??hash(responseText.trim())):null,completionObserved:outcome==='COMPLETE',
                minimalResponseVerified:(!this.magpie||!!this.customProbe)&&this.forbidTools&&outcome==='COMPLETE',
                protocolEventCount,protocolLastEventType,protocolLastEventDetail,protocolFailureStage,
                toolArgumentFailureDetail,
                upstreamHttpStatus,upstreamContentType,upstreamBodyShape,upstreamBodyBytes,upstreamBodySha256,upstreamBodyCode,
                upstreamRequestIdSha256,transportErrorCode,elapsedMs:Math.min(300000,elapsed),elapsedMsCapped:elapsed>300000,
                networkFailureClass,automaticRetryAllowed,
                outcome, usage, reservedMicros: reservation.reservedMicros, recordedAt: new Date().toISOString() });
            if(pi&&piReply&&outcome==='COMPLETE'){
                res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.end(piReply.sse);
            }
            if(settledMessages&&outcome==='COMPLETE'){
                res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
                res.end(settledMessages);
            }else if(settledChatBody&&outcome==='COMPLETE'){
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(settledChatBody);
            }
        }
    }
    async close() {
        this.closing = true;
        for (const c of this.controllers) c.abort();
        this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
        await Promise.all(this.handlers);
        await this.magpie?.close();
        this.apiKey = ''; this.token = '';
    }
}
