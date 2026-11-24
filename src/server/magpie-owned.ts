import {codexPlannerResponsesBody} from './flow/responses-wire.js';
import {chatSupervisorResponsesBody} from './flow/chat-supervisor-responses.js';
import {isPaidCodexResponsesRoute,paidCodexResponsesBody} from './flow/paid-codex-responses.js';
import {constants,copyFileSync,lstatSync,mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {accountCapabilities,stringMessagesEndpoint,type AccountCapability} from './custom-account-sources.js';
import {own,type Owned} from './process.js';
import {MagpieAdmissionPipe} from './magpie-control.js';
import type {NativeBudget,NativeUsage} from './native-budget.js';
import {childEnv,DomainError,hash,object,within} from './security.js';
import {piNativeRequestBody,piReadOnlyToolsOnly} from './flow/pi-native-wire.js';
import type {PiNativeSession} from './flow/pi-native-session.js';
import {createClaudeReadOnlyExchange,type ClaudeMessagesIngress,type ClaudeReadOnlyContext} from './flow/claude-readonly-wire.js';
import {createDshSupervisorExchange,type DshSupervisorContext,type DshSupervisorIngress} from './flow/dsh-supervisor-wire.js';
import {createDshExecutorExchange,type DshExecutorContext,type DshExecutorIngress} from './flow/dsh-executor-wire.js';
import {createCliExecutorExchange,type CliExecutorContext,type CliExecutorIngress} from './flow/cli-executor-wire.js';
import {createCodexSupervisorExchange,type CodexResponsesIngress,type CodexSupervisorContext} from './flow/codex-supervisor-wire.js';
import {claudeReadOnlyProtocol,supportsClaudeReadOnlyBuild,codexSupervisorProtocol,supportsCodexSupervisorBuild,dshExecutorProtocol,supportsDshExecutorBuild,dshSupervisorProtocol,supportsDshSupervisorBuild,supportsPiExecutorNativeBuild,piExecutorNativeProtocol,supportsPiReadOnlyBuild,piReadOnlyProtocol,isOfficialCliResponsesRoute,concreteMagpieRoute,magpieRouteHash,magpieRoutePath,claudeExecutorProtocol,opencodeExecutorProtocol,clineExecutorProtocol,codexExecutorProtocol,supportsClaudeExecutorTranslatedBuild,supportsOpencodeExecutorTranslatedBuild,supportsClineExecutorTranslatedBuild,supportsCodexExecutorTranslatedBuild,cliExecutorTranslatedBuildSet,isCliExecutorNativeWire,type MagpieConcreteRoute} from './magpie-route.js';
import {consumeMagpieAccountCustody,type MagpieAccountCustody,type MagpieCustodyBinding} from './magpie-account-custody.js';

const commit='1aca55909ff94f5c23091ce35f73cb4b7bc46658';
const controlledProxyKeys=['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy'] as const;
export interface MagpieExecutableRef {path:string;sha256:string}
/**
 * The one reviewed DM-owned Magpie build the private operator may select.
 *
 * History: 96bd5dc8… (pre dual-auth), 12de8b32… (v2-only M74 build). The current build adds the
 * reviewed `dm_accounts.go`/`control.go` overlay change that lets one credential declare a model
 * set, rebuilt with the pinned toolchain and covered by the Go control/provider tests. A new build
 * requires updating this constant together with the operator and the private binary; accepting an
 * operator-declared digest would remove the anti-substitution guard.
 */
export const REVIEWED_MAGPIE_BUILD_SHA256='f8d942811cd1dcb5aa5d48e2adb04d24dee031f0002d63c66a3716ccaf260cf6';
/*
 * Why this build replaced 63347fa6: that one is a v1-v4 control plane whose ExplicitRouteAllowed
 * has no executor+claude row, so the Claude executor lane was refused at issuance
 * (MAGPIE_ISSUANCE_DENIED) no matter which candidate was installed. This build adds exactly that
 * row plus the executor body shape (tools, adaptive thinking, tool_use/tool_result blocks) and
 * nothing else: a 120-cell matrix regression shows one cell flips false->true and the other 119 are
 * unchanged, so dsh, codex, pi, planner2 and reviewer keep their previous verdicts.
 */
/**
 * Custom-only build reviewed for the E: isolated instance. It carries the exact SSE
 * `Accept: text/event-stream` forwarding fix, normalizes only a verified SSE body
 * received with `text/plain`, and admits DeepSeek V4 Pro solely for the independent
 * Reviewer text route.
 */
// Physically accepted on 2026-11-24 for the claude / opencode / cline executor lanes:
// scripts/accept-claude-executor.mjs produced pass=true for each of the three, two upstream
// requests per turn against a loopback TLS fixture and zero paid calls.
export const REVIEWED_EXECUTOR_CLI_BUILD_SHA256='5a2b952cca3ed12345b985eb2832a73a1a9ecd945bc01d0e32121d232a4f8195';
export const REVIEWED_CUSTOM_MAGPIE_BUILD_SHA256='80db8d25fae1b73556b92700fb9c72388475bf717ede8580a9e8ade2f5272510';
/** Controller-private, explicit pipe input. Never accepted by HTTP/profile JSON. */
export interface MagpieBootstrapAccount {
 provider:string;authRef:string;accountRef:string;key:string;capabilities?:AccountCapability[];
 model?:string;models?:string[];authentication:'api_key';
 chat?:'https://api.deepseek.com/v1'|'';responses?:'';anthropic?:string;
}
/** `model` is data, not a constant: Stage B needs several distinct models behind one DM-owned
 * Magpie, and the route check below already compares it per request. */
export interface MagpieSubscriptionScope {
 projectId:string;flowId:string;configurationHash:string;accountFingerprint:string;authRef:string;accountRef:string;
}
function subscriptionScope(raw:unknown):Readonly<MagpieSubscriptionScope>{
 const fields=['projectId','flowId','configurationHash','accountFingerprint','authRef','accountRef'] as const;
 const descriptors=Object.getOwnPropertyDescriptors(object(raw));
 if(Reflect.ownKeys(descriptors).length!==fields.length)throw new DomainError('MAGPIE_SUBSCRIPTION_SCOPE_INVALID',409);
 for(const key of fields){
  const d=descriptors[key],value=d?.value;
  const pattern=key==='configurationHash'||key==='accountFingerprint'?/^[a-f0-9]{64}$/:/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
  if(!d?.enumerable||typeof value!=='string'||!pattern.test(value)||['UNKNOWN','NOT_VERIFIED'].includes(value.toUpperCase()))throw new DomainError('MAGPIE_SUBSCRIPTION_SCOPE_INVALID',409);
 }
 return Object.freeze(Object.fromEntries(fields.map(key=>[key,descriptors[key].value])) as unknown as MagpieSubscriptionScope);
}
export interface MagpieRegisteredAccount {provider:MagpieBootstrapAccount['provider']|'openai';authRef:string;accountRef:string;upstreamAccountRef:string;authentication:'api_key'|'oauth';model:string;models?:readonly string[];capabilities?:ReadonlyArray<Readonly<AccountCapability>>}
export interface MagpieControlObservation {
 scope:'LOCAL_CONTROL_PROCESS_ONLY';qualification:'NOT_VERIFIED';pid:number;address:string;
 epoch:string;binaryHash:string;runtimeDirectory:string;accountCount:number;credentialsAccepted:boolean;
 accounts:ReadonlyArray<Readonly<MagpieRegisteredAccount>>;realCredentialsPermitted:boolean;
}
export interface OwnedMagpieControl {
 control:MagpieAdmissionPipe;observation:Readonly<MagpieControlObservation>;close:()=>Promise<void>;
 prepareClaudePayload:(context:Omit<ClaudeReadOnlyContext,'accounts'>,ingress:ClaudeMessagesIngress)=>ReturnType<typeof prepareOwnedClaudePayload>;
 prepareDshSupervisorPayload:(context:Omit<DshSupervisorContext,'accounts'>,ingress:DshSupervisorIngress)=>ReturnType<typeof prepareOwnedDshSupervisorPayload>;
 prepareDshExecutorPayload:(context:Omit<DshExecutorContext,'accounts'>,ingress:DshExecutorIngress)=>ReturnType<typeof prepareOwnedDshExecutorPayload>;
 prepareCodexSupervisorPayload:(context:Omit<CodexSupervisorContext,'accounts'>,ingress:CodexResponsesIngress)=>ReturnType<typeof prepareOwnedCodexSupervisorPayload>;
 prepareCliExecutorPayload:(context:Omit<CliExecutorContext,'accounts'>,ingress:CliExecutorIngress)=>ReturnType<typeof prepareOwnedCliExecutorPayload>;
 prepareModelPayload:(route:unknown,body:string,planner?:Parameters<typeof codexPlannerResponsesBody>[1],role?:string,pi?:PiNativeSession)=>Readonly<MagpieModelPayload>;
}
/** Final wire bytes only; original Store/Dispatch and budget still authorize every request. */
export interface MagpieModelPayload {
 schema:'dream-maker.magpie-model-payload.v1';route:Readonly<MagpieConcreteRoute>;routeHash:string;
 body:string;bodyHash:string;method:'POST';path:string;maxOutputTokens:number;executionGranted:false;
}
/** One translated supervisor completion: a text answer or the single terminal tool call. */
export interface MagpieTranslatedCompletion {responseId:string;model:string;observedUpstreamModel:string;usage:Readonly<NativeUsage>;responseSha256:string;outputTextHash:string;finishReason:'end_turn'|'tool_use';sse:string}
export type MagpieTranslatedExchange={payload:Readonly<MagpieModelPayload>;complete:(response:Response)=>Promise<MagpieTranslatedCompletion>};
/** Called again by the same owned process before send to revalidate the frozen wire. */
export function prepareOwnedClaudePayload(binaryHash:string,accounts:readonly MagpieRegisteredAccount[],context:Omit<ClaudeReadOnlyContext,'accounts'>,ingress:ClaudeMessagesIngress) {
 const route=Object.freeze(concreteMagpieRoute(context.route));
 const matches=accounts.filter(a=>a.provider===route.provider&&a.authentication===route.authentication&&a.authRef===route.authRef&&a.accountRef===route.accountRef&&a.upstreamAccountRef===route.upstreamAccountRef);
 if(!supportsClaudeReadOnlyBuild(binaryHash)||matches.length!==1||claudeReadOnlyProtocol(context.role,route,matches[0].capabilities)!==route.protocol)throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
 const exchange=createClaudeReadOnlyExchange({...context,route,accounts}).prepare(ingress);
 const {body,path,maxOutputTokens}=exchange;
 if(path!==magpieRoutePath(route))throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
 const payload:Readonly<MagpieModelPayload>=Object.freeze({schema:'dream-maker.magpie-model-payload.v1',route,routeHash:magpieRouteHash(route),body,bodyHash:hash(body),method:'POST',path,maxOutputTokens,executionGranted:false});
 return {payload,complete:exchange.complete};
}
/**
 * The DSH supervision lane. Same owned-account and binary-hash gate as the read-only CLI lane,
 * but the frozen payload carries the single terminal tool instead of an empty tool set.
 */
export function prepareOwnedDshSupervisorPayload(binaryHash:string,accounts:readonly MagpieRegisteredAccount[],context:Omit<DshSupervisorContext,'accounts'>,ingress:DshSupervisorIngress):MagpieTranslatedExchange {
 const route=Object.freeze(concreteMagpieRoute(context.route));
 const matches=accounts.filter(a=>a.provider===route.provider&&a.authentication===route.authentication&&a.authRef===route.authRef&&a.accountRef===route.accountRef&&a.upstreamAccountRef===route.upstreamAccountRef);
 if(!supportsDshSupervisorBuild(binaryHash)||matches.length!==1||dshSupervisorProtocol(context.role,route,matches[0].capabilities)!==route.protocol)throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
 const exchange=createDshSupervisorExchange({...context,route,accounts}).prepare(ingress);
 const {body,path,maxOutputTokens}=exchange;
 if(path!==magpieRoutePath(route))throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
 const payload:Readonly<MagpieModelPayload>=Object.freeze({schema:'dream-maker.magpie-model-payload.v1',route,routeHash:magpieRouteHash(route),body,bodyHash:hash(body),method:'POST',path,maxOutputTokens,executionGranted:false});
 return {payload,complete:exchange.complete};
}
/**
 * The DSH executor lane. Same owned-account and binary-hash gate as the supervision lane, but
 * the frozen payload carries every declared executor tool and the replayed tool history
 * instead of one terminal tool.
 */
export function prepareOwnedDshExecutorPayload(binaryHash:string,accounts:readonly MagpieRegisteredAccount[],context:Omit<DshExecutorContext,'accounts'>,ingress:DshExecutorIngress):MagpieTranslatedExchange {
 const route=Object.freeze(concreteMagpieRoute(context.route));
 const matches=accounts.filter(a=>a.provider===route.provider&&a.authentication===route.authentication&&a.authRef===route.authRef&&a.accountRef===route.accountRef&&a.upstreamAccountRef===route.upstreamAccountRef);
 // A native Messages capability keeps the passthrough: this lane serves only the OpenAI outlets,
 // and the resolved protocol is the one the exchange then builds.
 if(!supportsDshExecutorBuild(binaryHash)||matches.length!==1||dshExecutorProtocol(context.role,route,matches[0].capabilities)!==route.protocol)throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
 const exchange=createDshExecutorExchange({...context,route,accounts}).prepare(ingress);
 const {body,path,maxOutputTokens}=exchange;
 if(path!==magpieRoutePath(route))throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
 const payload:Readonly<MagpieModelPayload>=Object.freeze({schema:'dream-maker.magpie-model-payload.v1',route,routeHash:magpieRouteHash(route),body,bodyHash:hash(body),method:'POST',path,maxOutputTokens,executionGranted:false});
 return {payload,complete:exchange.complete};
}
/**
 * The translated CLI executor lane: the CLI's own request comes in on the wire it speaks and the
 * product replays it onto the OpenAI wire the model declares, then rebuilds the CLI's dialect from
 * the answer. Same owned-account gate as every other lane, and its own digest set: a build that
 * proved a native tool turn says nothing about a body and a transcript this product authored, so
 * the set starts empty and the lane stays closed until a translated turn is observed end to end.
 */
export function prepareOwnedCliExecutorPayload(binaryHash:string,accounts:readonly MagpieRegisteredAccount[],context:Omit<CliExecutorContext,'accounts'>,ingress:CliExecutorIngress):MagpieTranslatedExchange {
 const route=Object.freeze(concreteMagpieRoute(context.route));
 const matches=accounts.filter(a=>a.provider===route.provider&&a.authentication===route.authentication&&a.authRef===route.authRef&&a.accountRef===route.accountRef&&a.upstreamAccountRef===route.upstreamAccountRef);
 // The native wire was rejected by every caller before this point; a route that still resolves to
 // it here is a lane mix-up, and the exchange refuses it again below.
 const translated=isCliExecutorNativeWire(route.runtime,route.protocol)===false;
 const protocol=route.runtime==='claude'?claudeExecutorProtocol(context.role,route,matches[0]?.capabilities):
  route.runtime==='opencode'?opencodeExecutorProtocol(context.role,route,matches[0]?.capabilities):
  route.runtime==='cline'?clineExecutorProtocol(context.role,route,matches[0]?.capabilities):
  codexExecutorProtocol(context.role,route,matches[0]?.capabilities);
 // Which evidence this resolved outlet answers: Codex's Messages outlet is a lane of its own and
 // keeps its own set, so it can never be opened by the OpenAI replay's digest.
 const supports=cliExecutorTranslatedBuildSet(route.runtime,route.protocol);
 if(!translated||!supports(binaryHash)||matches.length!==1||protocol!==route.protocol||context.role!=='executor')throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
 const exchange=createCliExecutorExchange({...context,route,accounts}).prepare(ingress);
 const {body,path,maxOutputTokens}=exchange;
 if(path!==magpieRoutePath(route))throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
 const payload:Readonly<MagpieModelPayload>=Object.freeze({schema:'dream-maker.magpie-model-payload.v1',route,routeHash:magpieRouteHash(route),body,bodyHash:hash(body),method:'POST',path,maxOutputTokens,executionGranted:false});
 return {payload,complete:exchange.complete};
}
/**
 * The Codex read-only lane: Responses ingress from the CLI, Messages wire upstream. Same
 * owned-account and binary-hash gate as the Claude lane, and the same digest-gated build set.
 */
export function prepareOwnedCodexSupervisorPayload(binaryHash:string,accounts:readonly MagpieRegisteredAccount[],context:Omit<CodexSupervisorContext,'accounts'>,ingress:CodexResponsesIngress):MagpieTranslatedExchange {
 const route=Object.freeze(concreteMagpieRoute(context.route));
 const matches=accounts.filter(a=>a.provider===route.provider&&a.authentication===route.authentication&&a.authRef===route.authRef&&a.accountRef===route.accountRef&&a.upstreamAccountRef===route.upstreamAccountRef);
 if(!supportsCodexSupervisorBuild(binaryHash)||matches.length!==1||codexSupervisorProtocol(context.role,route,matches[0].capabilities)!==route.protocol)throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);
 const exchange=createCodexSupervisorExchange({...context,route,accounts}).prepare(ingress);
 const {body,path,maxOutputTokens}=exchange;
 if(path!==magpieRoutePath(route))throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
 const payload:Readonly<MagpieModelPayload>=Object.freeze({schema:'dream-maker.magpie-model-payload.v1',route,routeHash:magpieRouteHash(route),body,bodyHash:hash(body),method:'POST',path,maxOutputTokens,executionGranted:false});
 return {payload,complete:exchange.complete};
}
function modelPayload(binaryHash:string,accounts:ReadonlyArray<MagpieRegisteredAccount>,rawRoute:unknown,rawBody:string,planner?:Parameters<typeof codexPlannerResponsesBody>[1],role?:string,pi?:PiNativeSession):Readonly<MagpieModelPayload> {
 const unavailable=():never=>{throw new DomainError('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE',409);},invalid=():never=>{throw new DomainError('MAGPIE_PAYLOAD_INVALID',400);};
 const route=concreteMagpieRoute(rawRoute);
 const account=accounts.find(a=>a.authentication===route.authentication&&a.provider===route.provider&&a.authRef===route.authRef&&a.accountRef===route.accountRef&&a.upstreamAccountRef===route.upstreamAccountRef);
 if(!account||(account.capabilities?!account.capabilities.some(c=>c.model===route.model&&c.protocol===route.protocol):!accountAllowsModel(account,route.model)||route.provider==='string'&&route.protocol!=='anthropic-messages'))return unavailable();
 // The read-only Claude shape is the supervisor turn only. The same runtime as an executor keeps
 // its tools and its tool history, which is a different body grammar on the same wire.
 const claudeSupervisor=role!=='executor'&&route.runtime==='claude'&&route.protocol==='anthropic-messages'&&(route.provider==='string'||!!account.capabilities);
 // The executor arm of the same CLI: same wire, same tools, different body grammar and no client hints.
 const cliExecutorMessages=role==='executor'&&(route.runtime==='claude'||route.runtime==='opencode'||route.runtime==='cline')&&route.protocol==='anthropic-messages';
 if(!claudeSupervisor&&!['claude','dsh','codex','independent','kimi','pi','opencode','cline'].includes(route.runtime))return unavailable();
 const subscription=magpieRoutePath(route)==='/backend-api/codex/responses';
 // The paid one-shot planner envelope is a read-role shape; the same runtime+protocol pair as an
 // executor is the CLI's own tool turn on the Responses wire.
 const nativePaid=role!=='executor'&&!!account.capabilities&&isPaidCodexResponsesRoute(route);
 const official=route.protocol==='openai-responses'&&(route.runtime==='opencode'||route.runtime==='cline');
 if(official&&!isOfficialCliResponsesRoute(binaryHash,role??'',route,account.capabilities))return unavailable();
 // Pi owns two lanes on this wire: an executor's tool turn and a read role's single supervision
 // answer. The role selects the build set and the selector, so a read-only body can never ride the
 // executor's evidence, and a read-only session whose limits widened past the frozen read pair is
 // refused here rather than being rebuilt into an upstream body.
 const nativePi=route.runtime==='pi'&&route.protocol!=='chat-completions',piReadOnly=role!=='executor';
 const piAdmitted=piReadOnly
  ?supportsPiReadOnlyBuild(binaryHash)&&piReadOnlyProtocol(role??'',route,account.capabilities)===route.protocol&&piReadOnlyToolsOnly(pi!.limits.tools)
  :supportsPiExecutorNativeBuild(binaryHash)&&piExecutorNativeProtocol(role??'',route,account.capabilities)===route.protocol;
 if(nativePi!==!!pi||nativePi&&(!piAdmitted||pi!.limits.protocol!==route.protocol||pi!.limits.model!==route.model))return unavailable();
 if(subscription||nativePaid||official){
  if(!planner||planner.model!==route.model||subscription&&route.model!=='gpt-6-luna')return unavailable();
 }else if(planner!==undefined||route.authentication!=='api_key')return unavailable();
 if(typeof rawBody!=='string'||Buffer.byteLength(rawBody)>262144)return invalid();
 let body:Record<string,unknown>;try{body=object(JSON.parse(rawBody));}catch{return invalid();}
 const text=(v:unknown)=>{if(!v||typeof v!=='object'||Array.isArray(v))return false;const b=v as Record<string,unknown>;return b.type==='text'&&typeof b.text==='string';};
 const textContent=(v:unknown)=>typeof v==='string'||Array.isArray(v)&&v.every(text);
 let maxOutputTokens:number;
 if(pi){
  body=piNativeRequestBody(body,pi.limits,pi.history());maxOutputTokens=Number(route.protocol==='openai-responses'?body.max_output_tokens:body.max_tokens);
 }else if((subscription||nativePaid||official)&&planner){
  body=official?chatSupervisorResponsesBody(body,planner):nativePaid?paidCodexResponsesBody(body,planner):codexPlannerResponsesBody(body,planner);
  maxOutputTokens=Number(body.max_output_tokens);
 }else if(route.protocol==='anthropic-messages'){
  // The executor arm of an owned CLI sends the same four tool-bearing turns the read-only arm
  // sends text through, plus the client-side hints 2.1.x attaches to every request. Those hints are
  // validated here and then dropped before the Magpie hop: the frozen lane carries the model, the
  // tools and the tool history, never a client device id or an effort/caching instruction that the
  // upstream hop has no agreed meaning for.
  const allowed=['model','max_tokens','messages','system','tools','tool_choice','temperature','top_p','top_k','stop_sequences','stream','metadata','thinking'];
  if(cliExecutorMessages)allowed.push('output_config','context_management');
  if((claudeSupervisor||cliExecutorMessages)&&body.context_management!==undefined){
   const management=body.context_management;
   if(!management||typeof management!=='object'||Array.isArray(management)||Object.keys(management).length!==1||!Array.isArray((management as Record<string,unknown>).edits)||
       ((management as Record<string,unknown>).edits as unknown[]).length!==1)return invalid();
   const edit=((management as Record<string,unknown>).edits as unknown[])[0];
   if(!edit||typeof edit!=='object'||Array.isArray(edit)||Object.keys(edit).length!==2||(edit as Record<string,unknown>).type!=='clear_thinking_20251015'||
       (edit as Record<string,unknown>).keep!=='all')return invalid();
  }
  if(claudeSupervisor&&body.output_config!==undefined){
   const output=body.output_config;
   if(!output||typeof output!=='object'||Array.isArray(output)||Object.keys(output).length!==1||(output as Record<string,unknown>).effort!=='high')return invalid();
   allowed.push('output_config');
  }
  if(Object.keys(body).some(k=>!allowed.includes(k))||body.model!==route.model||!Number.isSafeInteger(body.max_tokens)||Number(body.max_tokens)<1||Number(body.max_tokens)>16000||!Array.isArray(body.messages)||!body.messages.length||body.stream!==undefined&&typeof body.stream!=='boolean')return invalid();
  if(body.system!==undefined&&!textContent(body.system))return invalid();
  if(claudeSupervisor&&(body.tool_choice!==undefined||body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.length!==0)))return invalid();
  for(const raw of body.messages){
   if(!raw||typeof raw!=='object'||Array.isArray(raw))return invalid();const message=raw as Record<string,unknown>;
   // 2.1.x appends a trailing system-role message carrying cached system text on the beta path.
   // It is text only; the executor arm admits it and no read-only arm ever sends it.
   if(message.role==='system'&&cliExecutorMessages){
    const systemContent=message.content;
    if(typeof systemContent==='string')continue;
    if(!Array.isArray(systemContent)||!systemContent.length||!systemContent.every(text))return invalid();
    continue;
   }
   if(message.role!=='user'&&message.role!=='assistant')return invalid();const content=message.content;
   if(typeof content==='string')continue;if(!Array.isArray(content)||!content.length)return invalid();
   if(claudeSupervisor&&!content.every(text))return invalid();
   for(const rawBlock of content){if(text(rawBlock))continue;if(!rawBlock||typeof rawBlock!=='object'||Array.isArray(rawBlock))return invalid();const block=rawBlock as Record<string,unknown>;
    if(block.type==='tool_use'&&typeof block.id==='string'&&typeof block.name==='string'&&block.input&&typeof block.input==='object'&&!Array.isArray(block.input))continue;
    if(block.type==='tool_result'&&typeof block.tool_use_id==='string'&&(block.content===undefined||textContent(block.content))&&(block.is_error===undefined||typeof block.is_error==='boolean'))continue;
    return invalid();
   }
  }
  if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(raw=>!raw||typeof raw!=='object'||Array.isArray(raw)||(raw as Record<string,unknown>).type!==undefined&&(raw as Record<string,unknown>).type!=='custom')))return invalid();
  // The owned ingress refuses a tool_choice on the CLI executor row. 'auto' is the documented
  // default ("let the model choose"), so dropping it is lossless; anything else is refused rather
  // than silently reinterpreted as a free choice.
  // The owned ingress compares tool entries by their declaration shape. Clients attach transport
  // hints of their own ('eager_input_streaming' on 1.19.6); they are not model input, so the
  // executor arm forwards only name, description, input_schema and the custom type marker.
  if(cliExecutorMessages&&Array.isArray(body.tools)){
   body.tools=(body.tools as Record<string,unknown>[]).map(raw=>{
    const tool=raw as Record<string,unknown>;
    if(typeof tool.name!=='string')return invalid();
    const forwarded:Record<string,unknown>={name:tool.name};
    if(tool.description!==undefined)forwarded.description=tool.description;
    if(tool.input_schema!==undefined)forwarded.input_schema=tool.input_schema;
    if(tool.type!==undefined)forwarded.type=tool.type;
    return forwarded;
   });
  }
  if(cliExecutorMessages&&body.tool_choice!==undefined){
   // Two client spellings mean the same default: the string 'auto' and {type:'auto'}.
   const choice=body.tool_choice;
   const auto=choice==='auto'||!!choice&&typeof choice==='object'&&!Array.isArray(choice)&&Object.keys(choice).length===1&&(choice as Record<string,unknown>).type==='auto';
   if(!auto)return invalid();
   delete body.tool_choice;
  }
  if(body.thinking!==undefined){const thinking=body.thinking;
   if(!thinking||typeof thinking!=='object'||Array.isArray(thinking))return invalid();
   // A read-only supervisor turn keeps the documented disabled/effort-high pair; the executor arm
   // may also ask for adaptive display, which is dropped with the other client hints below.
   const adaptive=cliExecutorMessages&&Object.keys(thinking).length===2&&(thinking as Record<string,unknown>).type==='adaptive'&&(thinking as Record<string,unknown>).display==='updates';
   if(!adaptive&&(Object.keys(thinking).length!==1||(thinking as Record<string,unknown>).type!=='disabled'))return invalid();}
  maxOutputTokens=Number(body.max_tokens);
 }else if(route.protocol==='chat-completions'){
    const allowed=['model','messages','max_tokens','max_completion_tokens','temperature','top_p','stop','stream','stream_options','tools','tool_choice','n','user','response_format','seed','frequency_penalty','presence_penalty','reasoning_effort'];
  const budget=body.max_completion_tokens??body.max_tokens;
  // Streaming usage reporting is the only accepted stream_options shape; nothing else is forwarded.
  if(body.stream_options!==undefined&&(!body.stream_options||typeof body.stream_options!=='object'||Array.isArray(body.stream_options)||Object.keys(body.stream_options as Record<string,unknown>).length!==1||(body.stream_options as Record<string,unknown>).include_usage!==true))return invalid();
    if(Object.keys(body).some(k=>!allowed.includes(k))||body.model!==route.model||!Number.isSafeInteger(budget)||Number(budget)<1||Number(budget)>16000||!Array.isArray(body.messages)||!body.messages.length||body.stream!==undefined&&typeof body.stream!=='boolean'||body.n!==undefined&&body.n!==1||body.reasoning_effort!==undefined&&!['low','medium','high'].includes(String(body.reasoning_effort)))return invalid();
  for(const raw of body.messages){
   if(!raw||typeof raw!=='object'||Array.isArray(raw))return invalid();const message=raw as Record<string,unknown>;
   if(!['system','user','assistant','tool','developer'].includes(String(message.role)))return invalid();
   const content=message.content;
   if(typeof content==='string')continue;
   if(!Array.isArray(content)||!content.length||!content.every(part=>text(part)))return invalid();
  }
  if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(raw=>!raw||typeof raw!=='object'||Array.isArray(raw)||(raw as Record<string,unknown>).type!=='function')))return invalid();
  maxOutputTokens=Number(budget);
 }else{
  // `codex exec` posts the Responses wire with four client-side hints of its own: identifiers,
  // the extra fields it wants echoed, a cache key and the parallel-tool flag. They are validated
  // and then dropped for the executor arm; the forwarded body keeps the model, the input, the tools
  // and the turn's limits, which is what the owned row is written against.
  const cliExecutorResponses=role==='executor'&&route.runtime==='codex'&&route.protocol==='openai-responses';
  const allowed=['model','input','instructions','max_output_tokens','temperature','top_p','tools','tool_choice','stream','metadata','reasoning','store','previous_response_id'];
  if(cliExecutorResponses)allowed.push('client_metadata','include','prompt_cache_key','parallel_tool_calls');
  if(Object.keys(body).some(k=>!allowed.includes(k))||body.model!==route.model||!Number.isSafeInteger(body.max_output_tokens)||Number(body.max_output_tokens)<1||Number(body.max_output_tokens)>16000||body.input===undefined||body.stream!==undefined&&typeof body.stream!=='boolean')return invalid();
  if(typeof body.input!=='string'&&!Array.isArray(body.input))return invalid();
  if(body.instructions!==undefined&&typeof body.instructions!=='string')return invalid();
  // codex exec declares hosted tools of its own (namespace bundles, web_search) beside the function
  // tools the lane froze. A hosted tool cannot be audited as a call, so the executor arm drops them
  // before the declaration check below and forwards the function set only.
  if(cliExecutorResponses&&Array.isArray(body.tools))body.tools=(body.tools as Record<string,unknown>[]).filter(tool=>tool&&typeof tool==='object'&&!Array.isArray(tool)&&(tool as Record<string,unknown>).type==='function');
  if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(raw=>!raw||typeof raw!=='object'||Array.isArray(raw)||(raw as Record<string,unknown>).type!=='function')))return invalid();
  if(cliExecutorResponses){
   if(body.include!==undefined&&(!Array.isArray(body.include)||body.include.length>16||body.include.some(value=>typeof value!=='string')))return invalid();
   if(body.parallel_tool_calls!==undefined&&typeof body.parallel_tool_calls!=='boolean')return invalid();
   if(body.prompt_cache_key!==undefined&&typeof body.prompt_cache_key!=='string')return invalid();
   if(body.client_metadata!==undefined&&(!body.client_metadata||typeof body.client_metadata!=='object'||Array.isArray(body.client_metadata)))return invalid();
   delete body.client_metadata;delete body.include;delete body.prompt_cache_key;delete body.parallel_tool_calls;
   // `codex exec` 0.171.0 still writes three member classes the owned row has no slot for, and the
   // Go body check refuses the whole request over any one of them: dm_transport.go:1057 for the top
   // level, :1080 per declaration, :1142/:1160/:1169 per transcript item.
   //   - a reasoning summary request (`reasoning:{summary:"auto"}`): a display hint, not model input;
   //   - `strict:true` on every function declaration: a schema-enforcement hint. The declaration
   //     itself is forwarded unchanged, so the tool set the model sees is identical;
   //   - the CLI's own item `id`, and `status` on a replayed call: they address items of a stored
   //     response, and this lane runs `store:false` and replays the whole transcript. The call ids
   //     that carry the round trip are `call_id`, and those are kept.
   // Every piece of model input survives: every text part, every tool declaration, every call id with
   // its arguments and every output that answered it.
   delete body.reasoning;
   if(Array.isArray(body.tools))body.tools=(body.tools as Record<string,unknown>[]).map(raw=>{
    const declaration=raw as Record<string,unknown>,forwarded:Record<string,unknown>={};
    for(const key of ['type','name','description','parameters'])if(declaration[key]!==undefined)forwarded[key]=declaration[key];
    return forwarded;
   });
   if(Array.isArray(body.input))body.input=(body.input as unknown[]).map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
    const item=raw as Record<string,unknown>;
    if(item.type==='message')return {type:'message',role:item.role,content:item.content};
    if(item.type==='function_call')return {type:'function_call',call_id:item.call_id,name:item.name,arguments:item.arguments};
    if(item.type==='function_call_output')return {type:'function_call_output',call_id:item.call_id,output:item.output};
    return item;
   });
  }
  maxOutputTokens=Number(body.max_output_tokens);
 }
 // The owned ingress admits the frozen Messages shape: one system prompt, then the tool history.
 // 2.1.x carries its trailing <system-reminder> as a system-role MESSAGE instead, which the ingress
 // refuses on the executor row. Fold that text into the system prompt rather than dropping it: the
 // provider still sees every instruction, and the forwarded body stays the canonical shape.
 if(cliExecutorMessages&&Array.isArray(body.messages)&&body.messages.some(raw=>raw&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as Record<string,unknown>).role==='system')){
  const folded:(Record<string,unknown>)[]=[];
  for(const raw of body.messages){
   const message=raw as Record<string,unknown>;
   if(message.role!=='system')continue;
   const content=message.content;
   if(typeof content==='string')folded.push({type:'text',text:content});
   else if(Array.isArray(content))folded.push(...content as Record<string,unknown>[]);
  }
  const current=body.system===undefined?[]:typeof body.system==='string'?[{type:'text',text:body.system}]:body.system as unknown[];
  body.system=[...current,...folded];
  body.messages=(body.messages as Record<string,unknown>[]).filter(message=>message.role!=='system');
 }
 // Claude Code attaches client metadata. Review identity is already bound by the controller.
 if(claudeSupervisor)delete body.metadata;
 if(cliExecutorMessages){
  // Same reasoning, plus the two hints the lane deliberately does not forward.
  delete body.metadata;delete body.context_management;delete body.output_config;
  if(body.thinking!==undefined&&(body.thinking as Record<string,unknown>).type==='adaptive')delete body.thinking;
 }
 let wire:string;try{wire=JSON.stringify(subscription?body:{...body,model:route.provider+'/'+route.model});}catch{return invalid();}if(Buffer.byteLength(wire)>262144)return invalid();
 return Object.freeze({schema:'dream-maker.magpie-model-payload.v1',route:Object.freeze(route),routeHash:magpieRouteHash(route),body:wire,bodyHash:hash(wire),method:'POST',path:magpieRoutePath(route),maxOutputTokens,executionGranted:false});
}
/** The single-model shape stays valid; a model set is the same credential serving
 * the small, explicitly declared list of models a Flow froze for this account. */
function accountAllowsModel(account:MagpieRegisteredAccount,model:string):boolean {
 if(account.model===model)return true;
 return Array.isArray(account.models)&&account.models.includes(model);
}
function pinnedBinary(ref:MagpieExecutableRef):Buffer {
 const fail=():never=>{throw new DomainError('MAGPIE_EXECUTABLE_CHANGED',409);};
 if(!ref||Reflect.ownKeys(ref).length!==2||typeof ref.path!=='string'||!isAbsolute(ref.path)||!/^[a-f0-9]{64}$/.test(ref.sha256))return fail();
 try{
  let current=resolve(ref.path);while(true){if(lstatSync(current).isSymbolicLink())return fail();const parent=dirname(current);if(parent===current)break;current=parent;}
  const stat=lstatSync(ref.path);if(!stat.isFile()||stat.size<1||stat.size>128*1024**2)return fail();
  const bytes=readFileSync(ref.path);if(hash(bytes)!==ref.sha256)return fail();return bytes;
 }catch{return fail();}
}
/** A trusted callback may contribute the existing Clash proxy variables and nothing else.
 * Keeping the comparison against the pre-network environment prevents this seam from
 * becoming a second credential/config injection path. */
function controlledNetworkEnvironment(base:NodeJS.ProcessEnv,transform:(base:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 const fail=():never=>{throw new DomainError('MAGPIE_NETWORK_ENVIRONMENT_INVALID',409);};
 let raw:unknown;try{raw=transform({...base});}catch{return fail();}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();
 const descriptors=Object.getOwnPropertyDescriptors(raw),proxyKeys=new Set<string>(controlledProxyKeys),supplied:Record<string,unknown>={},observed:Record<string,string|undefined>={};
 for(const key of Reflect.ownKeys(descriptors)){
  if(typeof key!=='string')return fail();
  const descriptor=descriptors[key];
  if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))return fail();
  supplied[key]=descriptor.value;
  if(proxyKeys.has(key)){if(descriptor.value!==undefined&&typeof descriptor.value!=='string')return fail();observed[key]=descriptor.value;}
  else if(!Object.hasOwn(base,key)||descriptor.value!==base[key])return fail();
 }
 for(const [key,value] of Object.entries(base))if(!Object.hasOwn(supplied,key)||supplied[key]!==value)return fail();
 const values=controlledProxyKeys.slice(0,6).map(key=>observed[key]);
 if(!values[0]||values.some(value=>value!==values[0]))return fail();
 let proxy:URL;try{proxy=new URL(values[0]);}catch{return fail();}
 if(proxy.protocol!=='http:'||proxy.hostname!=='127.0.0.1'||!proxy.port||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash)return fail();
 const bypass='localhost,127.0.0.1,::1,[::1]';
 if(observed.NO_PROXY!==bypass||observed.no_proxy!==bypass)return fail();
 return {...base,HTTP_PROXY:proxy.href,http_proxy:proxy.href,HTTPS_PROXY:proxy.href,https_proxy:proxy.href,ALL_PROXY:proxy.href,all_proxy:proxy.href,NO_PROXY:bypass,no_proxy:bypass};
}
function timed<T>(promise:Promise<T>,ms:number,code:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>;
 return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DomainError(code,500)),ms);})]).finally(()=>clearTimeout(timer));
}
function memoryAccounts(raw:unknown,syntheticOnly=true):MagpieBootstrapAccount[] {
 const fail=():never=>{throw new DomainError('MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID',409);};
 try{
  if(!Array.isArray(raw))return fail();const descriptors=Object.getOwnPropertyDescriptors(raw as object),length=descriptors.length?.value;
  if(!Number.isSafeInteger(length)||length<0||length>8||Reflect.ownKeys(descriptors).length!==length+1)return fail();
  const result:MagpieBootstrapAccount[]=[],refs=new Set<string>(),aliases=new Set<string>(),ids=new Set<string>();
  const ref=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)&&!['UNKNOWN','NOT_VERIFIED'].includes(v.toUpperCase());
  for(let i=0;i<length;i++){
   const descriptor=descriptors[String(i)];if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))return fail();
   const fields=Object.getOwnPropertyDescriptors(object(descriptor.value)),keys=['provider','authRef','accountRef','key'],modelField=fields.model,modelsField=fields.models;
   const explicit=Object.hasOwn(fields,'capabilities');
   if(explicit){if(modelField||modelsField)return fail();keys.push('capabilities');}
   else if(fields.provider?.value==='string')keys.push('endpoint');
   if(Reflect.ownKeys(fields).length!==keys.length+(modelField?1:0)+(modelsField?1:0)||keys.some(k=>!fields[k]?.enumerable||!Object.hasOwn(fields[k],'value')))return fail();
   if(modelField&&(!modelField.enumerable||!Object.hasOwn(modelField,'value')))return fail();
   if(modelsField&&(!modelsField.enumerable||!Object.hasOwn(modelsField,'value')))return fail();
   const a=Object.fromEntries(keys.map(k=>[k,fields[k].value]));
   if(modelField&&(typeof modelField.value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(modelField.value)))return fail();
   if(modelField)a.model=modelField.value;
   if(modelsField){
    if(!Array.isArray(modelsField.value)||modelsField.value.length<1||modelsField.value.length>8)return fail();
    const seen=new Set<string>();
    for(const model of modelsField.value){
     if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model)||seen.has(model))return fail();
     seen.add(model);
    }
    (a as {models?:string[]}).models=[...modelsField.value] as string[];
   }
   if(typeof a.provider!=='string'||(!explicit&&a.provider!=='deepseek-official'&&a.provider!=='string')||!ref(a.authRef)||!ref(a.accountRef)||typeof a.key!=='string'||!/^[\x21-\x7e]{8,512}$/.test(a.key)||syntheticOnly&&!a.key.startsWith('DM_SYNTHETIC_'))return fail();
   const id=hash(a.key).slice(0,10);if(refs.has(String(a.authRef))||aliases.has(String(a.accountRef))||ids.has(id))return fail();
   refs.add(String(a.authRef));aliases.add(String(a.accountRef));ids.add(id);
   if(explicit){
    const capabilities=accountCapabilities(a.provider,a.capabilities);
    result.push({provider:a.provider,authRef:String(a.authRef),accountRef:String(a.accountRef),key:a.key,authentication:'api_key',capabilities});
    continue;
   }
   const models=a.models as string[]|undefined;
   const model=String(a.model??models?.[0]??'deepseek-flash');
   if(a.provider==='string'&&(!models?.includes(model)||models.some(m=>!/^claude-[A-Za-z0-9_.-]+$/.test(m))))return fail();
   result.push({provider:a.provider,authRef:String(a.authRef),accountRef:String(a.accountRef),key:a.key,
    model,...(models?{models}:{}),authentication:'api_key',responses:'',
    chat:a.provider==='string'?'':'https://api.deepseek.com/v1',
    anthropic:a.provider==='string'?stringMessagesEndpoint(a.endpoint).baseUrl:'https://api.deepseek.com/anthropic'});
  }
  return result;
 }catch{return fail();}
}
function checkReady(raw:unknown,epoch:string,pid:number|undefined,data:string,schema:string,accounts:ReadonlyArray<MagpieRegisteredAccount>):{pid:number;address:string} {
 const fail=():never=>{throw new DomainError('MAGPIE_READY_INVALID',502);};
 const v=object(raw),keys=['type','schema','epoch','controlSchema','pid','address','commit','configDir','accountDiscovery','accountCatalog','accountCount','accounts','issuedKeyStore','issuedKeyCount','qualification','runtimeAuthority'];
 if(Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))||v.type!=='ready'||v.schema!=='dream-maker.magpie-ingress-candidate.v1'||v.epoch!==epoch||v.controlSchema!==schema||!Number.isSafeInteger(pid)||Number(pid)<1||v.pid!==pid||v.commit!==commit||typeof v.address!=='string'||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(v.address)||Number(v.address.split(':')[1])>65535||typeof v.configDir!=='string'||resolve(v.configDir)!==resolve(data)||v.accountDiscovery!=='OFF'||v.accountCatalog!=='MEMORY_ONLY'||v.accountCount!==accounts.length||!Array.isArray(v.accounts)||hash(v.accounts)!==hash(accounts)||v.issuedKeyStore!=='MEMORY_ONLY'||v.issuedKeyCount!==0||v.qualification!=='NOT_VERIFIED'||v.runtimeAuthority!=='ORIGINAL_DREAMFLOW_ENGINE')return fail();
 return{pid:Number(pid),address:v.address};
}
/** Original-owner lifecycle building block. Explicit accounts use the inherited private
 * pipe only. Registration proves no real account/model or Custom dispatch readiness.
 * The launcher seam is for offline failure tests; production always uses original own(). */
export async function openOwnedMagpieControl(input:{root:string;binary:MagpieExecutableRef;budget:NativeBudget;signal?:AbortSignal;timeoutMs?:number;subscription?:Readonly<MagpieSubscriptionScope>;bootstrapAccounts?:MagpieBootstrapAccount[];accountCustody?:MagpieAccountCustody;custodyBinding?:MagpieCustodyBinding;networkEnvironment?:(base:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv},launch:typeof own=own):Promise<OwnedMagpieControl> {
 if(input.signal?.aborted)throw new DomainError('MAGPIE_START_CANCELLED',409);
 const accountInput=Object.getOwnPropertyDescriptor(input,'bootstrapAccounts');
 if(accountInput&&(!accountInput.enumerable||!Object.hasOwn(accountInput,'value')))throw new DomainError('MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID',409);
 const custodyInput=Object.getOwnPropertyDescriptor(input,'accountCustody'),bindingInput=Object.getOwnPropertyDescriptor(input,'custodyBinding');
 if(custodyInput&&(!custodyInput.enumerable||!Object.hasOwn(custodyInput,'value')||!bindingInput?.enumerable||!Object.hasOwn(bindingInput,'value')||accountInput)||bindingInput&&!custodyInput)throw new DomainError('MAGPIE_ACCOUNT_CUSTODY_INVALID',409);
 const networkInput=Object.getOwnPropertyDescriptor(input,'networkEnvironment');
 if(networkInput&&(!networkInput.enumerable||!Object.hasOwn(networkInput,'value')||typeof networkInput.value!=='function'))throw new DomainError('MAGPIE_NETWORK_ENVIRONMENT_INVALID',409);
 const subInput=Object.getOwnPropertyDescriptor(input,'subscription');
 if(subInput&&(!subInput.enumerable||!Object.hasOwn(subInput,'value')))throw new DomainError('MAGPIE_SUBSCRIPTION_SCOPE_INVALID',409);
 const sub=subInput?subscriptionScope(subInput.value):undefined;
 let accounts=accountInput?memoryAccounts(accountInput.value):[];
 const timeout=input.timeoutMs??15000;if(!Number.isSafeInteger(timeout)||timeout<50||timeout>30000)throw new DomainError('MAGPIE_START_LIMIT_INVALID',409);
 const root=resolve(input.root),ref={...input.binary};pinnedBinary(ref);
 const parent=within(root,'.runtime/magpie-controls');mkdirSync(parent,{recursive:true});within(root,'.runtime/magpie-controls');
 const runtime=mkdtempSync(join(parent,'owned-')),binary=join(runtime,'dream-maker-magpie.exe'),data=join(runtime,'data'),profile=join(runtime,'profile'),temp=join(runtime,'temp');
 for(const path of [data,profile,temp,join(profile,'AppData/Roaming'),join(profile,'AppData/Local')])mkdirSync(path,{recursive:true});
 copyFileSync(ref.path,binary,constants.COPYFILE_EXCL);if(hash(readFileSync(binary))!==ref.sha256)throw new DomainError('MAGPIE_EXECUTABLE_CHANGED',409);
 const system=resolve(process.env.SystemRoot??'C:/Windows','System32'),isolated=childEnv({PATH:system,Path:system,TEMP:temp,TMP:temp,TMPDIR:temp,HOME:profile,USERPROFILE:profile,APPDATA:join(profile,'AppData/Roaming'),LOCALAPPDATA:join(profile,'AppData/Local'),XDG_CONFIG_HOME:data,XDG_CACHE_HOME:join(data,'cache'),XDG_STATE_HOME:join(data,'state'),MAGPIE_NO_ACCOUNTS:'1'});
 const env=networkInput?controlledNetworkEnvironment(isolated,networkInput.value as (base:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv):isolated;
 const epoch='dm_'+randomBytes(16).toString('hex');let owned:Owned;
 if(custodyInput){const held=consumeMagpieAccountCustody(custodyInput.value,bindingInput!.value,ref.sha256);try{accounts=memoryAccounts(held,false);}finally{for(const a of held)a.key='';}}
 const schema=accounts.some(a=>a.capabilities)?'dream-maker.magpie-control.v5':sub?'dream-maker.magpie-control.v4':accountInput||custodyInput?'dream-maker.magpie-control.v3':'dream-maker.magpie-control.v1';
 // Eight active accounts with up to 64 explicit endpoint declarations apiece.
 const frameLimit=schema==='dream-maker.magpie-control.v5'?512*1024:16384;
 if(sub&&accounts.some(a=>a.authRef===sub.authRef||a.accountRef===sub.accountRef)){for(const a of accounts)a.key='';throw new DomainError('MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID',409);}
 const registeredKeys:MagpieRegisteredAccount[]=accounts.map(a=>Object.freeze({provider:a.provider,authRef:a.authRef,accountRef:a.accountRef,upstreamAccountRef:a.provider+'/'+hash(a.key).slice(0,10),authentication:'api_key' as const,model:a.capabilities?.[0].model??a.model??'deepseek-flash',...(a.models?{models:Object.freeze([...a.models])}:{}),...(a.capabilities?{capabilities:Object.freeze(a.capabilities.map(c=>Object.freeze({...c})))}:{})}));
 const registered=Object.freeze(sub?[...registeredKeys,Object.freeze({provider:'openai' as const,model:'gpt-6-luna',authentication:'oauth' as const,authRef:sub.authRef,accountRef:sub.accountRef,upstreamAccountRef:'openai/'+sub.accountFingerprint})]:registeredKeys);
 try{owned=launch(binary,[],{cwd:runtime,env,windowsJobRoot:process.platform==='win32'?root:undefined,windowsJobReadyMs:Math.min(timeout,15000)});}catch{for(const a of accounts)a.key='';throw new DomainError('MAGPIE_START_FAILED',502);}
 let stopping:Promise<void>|undefined;
 const stop=()=>stopping??=(async()=>{
  try{owned.child.stdin.end();}catch{/* Still join the same owned cleanup. */}
  // Give EOF a short graceful window, then always ask the original owner for its Job/group proof.
  await Promise.race([owned.closed,new Promise<void>(r=>{const timer=setTimeout(r,1500);void owned.closed.then(()=>clearTimeout(timer),()=>clearTimeout(timer));})]);
  try{await timed(owned.stop(),10000,'PROCESS_CLEANUP_UNPROVEN');}catch{throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);}
 })();
 let failure:DomainError|undefined,control:MagpieAdmissionPipe|undefined,starting=true,bootstrapSent=false,buffer=Buffer.alloc(0),bootstrapBytes:Buffer|undefined;
 let rejectFailure!:(e:Error)=>void;const failed=new Promise<never>((_,reject)=>{rejectFailure=reject;});
 const fail=(code:string)=>{failure??=new DomainError(code,502);rejectFailure(failure);if(!starting)void (control?.close()??stop()).catch(()=>{});};
 let accept!:(value:unknown)=>void;const readyFrame=new Promise<unknown>(r=>{accept=r;});
 const deadline=Date.now()+timeout;
 const onData=(chunk:Buffer)=>{
  if(Date.now()>=deadline){fail('MAGPIE_START_TIMEOUT');return;}
  if(!bootstrapSent||buffer.includes(10)){fail('MAGPIE_READY_INVALID');return;}
  if(buffer.length+chunk.length>frameLimit){fail('MAGPIE_START_OUTPUT_LIMIT');return;}
  buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf(10);if(end<0)return;
  if(end!==buffer.length-1){fail('MAGPIE_READY_INVALID');return;}
  try{const line=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,end)),value=JSON.parse(line);if(JSON.stringify(value)!==line)throw Error('NONCANONICAL_FRAME');accept(value);}catch{fail('MAGPIE_READY_INVALID');}
 };
 const ioError=()=>fail('MAGPIE_START_IO_FAILED'),stderr=(chunk:Buffer)=>{if(chunk.length)fail('MAGPIE_START_STDERR');};
 owned.child.stdout.on('data',onData);owned.child.stdout.on('error',ioError);owned.child.stdin.on('error',ioError);owned.child.stderr.on('data',stderr);owned.child.stderr.on('error',ioError);
 void owned.closed.then(()=>{if(starting)fail('MAGPIE_START_EXITED');},()=>fail('MAGPIE_START_EXITED'));
 const aborted=()=>fail('MAGPIE_START_CANCELLED');input.signal?.addEventListener('abort',aborted,{once:true});if(input.signal?.aborted)aborted();
 const timer=setTimeout(()=>fail('MAGPIE_START_TIMEOUT'),Math.max(1,deadline-Date.now()));
 try{
  const write=owned.ready.then(()=>new Promise<void>((resolveWrite,rejectWrite)=>{
   if(failure||Date.now()>=deadline){rejectWrite(failure??new DomainError('MAGPIE_START_TIMEOUT',502));return;}
   bootstrapBytes=Buffer.from(JSON.stringify({schema,epoch,...(sub||accountInput||custodyInput?{accounts}:{}),...(sub?{subscription:sub}:{})})+'\n');for(const a of accounts)a.key='';
   if(bootstrapBytes.length>frameLimit){rejectWrite(new DomainError('MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID',409));return;}
   bootstrapSent=true;owned.child.stdin.write(bootstrapBytes,error=>{bootstrapBytes?.fill(0);error?rejectWrite(new DomainError('MAGPIE_START_IO_FAILED',502)):resolveWrite();});
  }));
  const [raw]=await Promise.race([Promise.all([readyFrame,write]),failed]);
  if(failure)throw failure;if(Date.now()>=deadline)throw new DomainError('MAGPIE_START_TIMEOUT',502);
  const ready=checkReady(raw,epoch,owned.targetPid?.(),data,schema,registered);pinnedBinary(ref);if(hash(readFileSync(binary))!==ref.sha256)throw new DomainError('MAGPIE_EXECUTABLE_CHANGED',409);
  owned.child.stdout.off('data',onData);
  control=new MagpieAdmissionPipe({input:owned.child.stdin,output:owned.child.stdout,closed:owned.closed,stop},input.budget,{epoch,binaryHash:ref.sha256});
  starting=false;buffer=Buffer.alloc(0);
  let payloadClosed=false;void owned.closed.then(()=>{payloadClosed=true;},()=>{payloadClosed=true;});
  const close=()=>{payloadClosed=true;return control!.close().finally(()=>input.signal?.removeEventListener('abort',aborted));};
  const prepareModelPayload:OwnedMagpieControl['prepareModelPayload']=(route,body,planner,role,pi)=>{if(payloadClosed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);return modelPayload(ref.sha256,registered,route,body,planner,role,pi);};
  const prepareClaudePayload:OwnedMagpieControl['prepareClaudePayload']=(context,ingress)=>{
   if(payloadClosed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
   return prepareOwnedClaudePayload(ref.sha256,registered,context,ingress);
  };
  const prepareDshSupervisorPayload:OwnedMagpieControl['prepareDshSupervisorPayload']=(context,ingress)=>{
   if(payloadClosed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
   return prepareOwnedDshSupervisorPayload(ref.sha256,registered,context,ingress);
  };
  const prepareDshExecutorPayload:OwnedMagpieControl['prepareDshExecutorPayload']=(context,ingress)=>{
   if(payloadClosed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
   return prepareOwnedDshExecutorPayload(ref.sha256,registered,context,ingress);
  };
  const prepareCodexSupervisorPayload:OwnedMagpieControl['prepareCodexSupervisorPayload']=(context,ingress)=>{
   if(payloadClosed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
   return prepareOwnedCodexSupervisorPayload(ref.sha256,registered,context,ingress);
  };
  const prepareCliExecutorPayload:OwnedMagpieControl['prepareCliExecutorPayload']=(context,ingress)=>{
   if(payloadClosed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
   return prepareOwnedCliExecutorPayload(ref.sha256,registered,context,ingress);
  };
  return{control,close,prepareModelPayload,prepareClaudePayload,prepareDshSupervisorPayload,prepareDshExecutorPayload,prepareCodexSupervisorPayload,prepareCliExecutorPayload,observation:Object.freeze({scope:'LOCAL_CONTROL_PROCESS_ONLY',qualification:'NOT_VERIFIED',pid:ready.pid,address:ready.address,epoch,binaryHash:ref.sha256,runtimeDirectory:runtime,accountCount:registered.length,credentialsAccepted:registeredKeys.length>0,accounts:registered,realCredentialsPermitted:!!custodyInput})};
 }catch(error){
  await stop();if(error instanceof DomainError)throw error;throw new DomainError('MAGPIE_START_FAILED',502);
 }finally{
  clearTimeout(timer);owned.child.stdout.off('data',onData);buffer=Buffer.alloc(0);bootstrapBytes?.fill(0);for(const a of accounts)a.key='';
  if(starting)input.signal?.removeEventListener('abort',aborted);
 }
}
