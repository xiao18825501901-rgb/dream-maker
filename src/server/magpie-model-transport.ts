import type {CodexIncludedTurn} from './providers/codex.js';
import {isPaidCodexResponsesRoute,type PaidCodexResponsesLimits} from './flow/paid-codex-responses.js';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {NativeBudget,NativeUsage} from './native-budget.js';
import {parseGatewayJson} from './gateway-tool-arguments.js';
import type {NativeRequestBinding} from '../shared/native-request.js';
import type {OwnedMagpieControl,MagpieModelPayload,MagpieTranslatedExchange} from './magpie-owned.js';
import type {MagpieControlDraft} from './magpie-control.js';
import type {ClaudeMessagesIngress,ClaudeReadOnlyContext} from './flow/claude-readonly-wire.js';
import type {CodexResponsesIngress,CodexSupervisorContext} from './flow/codex-supervisor-wire.js';
import type {DshSupervisorContext} from './flow/dsh-supervisor-wire.js';
import type {DshExecutorContext} from './flow/dsh-executor-wire.js';
import type {CliExecutorContext,CliExecutorIngress} from './flow/cli-executor-wire.js';
import type {PiNativeSession} from './flow/pi-native-session.js';
import {piReadOnlyToolsOnly} from './flow/pi-native-wire.js';
import {supportsClaudeReadOnlyBuild,claudeReadOnlyProtocol,supportsClaudeExecutorBuild,claudeExecutorProtocol,supportsClaudeExecutorTranslatedBuild,supportsClineExecutorBuild,clineExecutorProtocol,supportsClineExecutorTranslatedBuild,supportsCodexExecutorBuild,codexExecutorProtocol,supportsCodexExecutorTranslatedBuild,cliExecutorTranslatedBuildSet,supportsOpencodeExecutorBuild,opencodeExecutorProtocol,supportsOpencodeExecutorTranslatedBuild,isCliExecutorNativeWire,supportsCodexSupervisorBuild,codexSupervisorProtocol,supportsDshExecutorBuild,dshExecutorProtocol,supportsDshSupervisorBuild,dshSupervisorProtocol,supportsPiExecutorNativeBuild,piExecutorNativeProtocol,supportsPiReadOnlyBuild,piReadOnlyProtocol,isOfficialCliResponsesRoute,concreteMagpieRoute,magpieRouteHash,magpieRoutePath,type MagpieConcreteRoute} from './magpie-route.js';
import {nativeRequestBinding} from './native-request-binding.js';
import {DomainError,hash,networkFailureError,object} from './security.js';
import {classifyNetworkFailure} from './network-failure.js';

const loopbackFetch=globalThis.fetch;
const overageMedia='application/vnd.dream-maker.overage+json';
const overageSchema='dream-maker.overage.v1';

export interface PreparedMagpieModelRequest {readonly body:string;readonly binding:NativeRequestBinding;readonly maxOutputTokens:number;readonly completeClaude?:MagpieTranslatedExchange['complete']}
// Only a prepared qualification binding from this transport can authorize the exact ledger and route.
const officialProbeBindings=new WeakMap<NativeRequestBinding,{budget:NativeBudget;routeHash:string;maxOutputTokens:number}>();
export function isPreparedOfficialProbe(binding:NativeRequestBinding,budget:NativeBudget,routeHash:string,maxOutputTokens:number):boolean {
 const proof=officialProbeBindings.get(binding);
 return proof?.budget===budget&&proof.routeHash===routeHash&&proof.maxOutputTokens===maxOutputTokens;
}
interface Context {
 session:OwnedMagpieControl;budget:NativeBudget;route:MagpieConcreteRoute;
 role?:'planner2'|'executor'|'reviewer';
 claude?:{prompt:string;instructions:string;assertCurrent():void;signal:AbortSignal};
 /** The Codex read-only lane: Responses ingress, Messages upstream. The prompt is deferred
  * because the CLI binds its thread before it posts the frozen turn. */
 codexSupervisor?:{prompt:()=>string;instructions:string;assertCurrent():void;signal:AbortSignal};
 /** Trusted controller declaration: this DSH supervision route is not the native Messages wire. */
 supervisor?:true;
 /** Trusted controller declaration: this DSH executor route is the translated Chat lane. */
 dshExecutor?:true;
 pi?:PiNativeSession;
 planner?:PaidCodexResponsesLimits|(()=>PaidCodexResponsesLimits);
 bindRequest:(payload:Readonly<MagpieModelPayload>)=>NativeRequestBinding;
 /** Original Engine/Store revalidation, never a browser-supplied proof callback. */
 assertCurrent:(binding:NativeRequestBinding)=>void;transport?:typeof fetch;
}
/** One bounded model transport underneath the original Gateway. It neither reserves
 * nor settles, schedules, approves, retries, or certifies an account/Custom Flow. */
export class MagpieDshRequestTransport {
 readonly upstream:string;
 declare readonly responseModel:string;
 declare readonly role:'planner2'|'executor'|'reviewer';
 private route:MagpieConcreteRoute;
 declare readonly piNative:PiNativeSession|undefined;
 get provider(){return this.route.provider;}
 get concreteRoute(){return this.route;}
 /** The read-only Claude translation. An executor turn on the same runtime is the CLI outlet
  *  below instead: same wire pair, different ingress, different build evidence. */
 get claudeTranslated(){return this.route.runtime==='claude'&&this.route.protocol!=='anthropic-messages'&&this.role!=='executor';}
 private readonly claude?:Readonly<NonNullable<Context['claude']>>;
 private readonly codex?:Readonly<NonNullable<Context['codexSupervisor']>>;
 private claudeUsed=false;
 readonly claudeSupervisor:boolean;
 /** True only for the tool-bearing executor arm of the Claude runtime (native Messages). */
 readonly claudeExecutor:boolean;
 /** The same arm for the other three CLI harnesses, each on its own native wire. Declared so the
  *  Gateway can apply one purpose shape to all four legs without re-reading the route. */
 readonly cliExecutor:'claude'|'opencode'|'cline'|'codex'|undefined;
 /** True only for a CLI executor served by the product's translated outlet. The four harnesses keep
  *  their own wire as the passthrough; a model that declares only an OpenAI wire is translated, and
  *  that outlet is gated by its own (still empty) build set. */
 declare readonly cliExecutorTranslated:boolean;
 /** Which CLI a translated turn belongs to; the native outlets name themselves in `cliExecutor`. */
 declare readonly cliExecutorRuntime:'claude'|'opencode'|'cline'|'codex'|undefined;
 /** True only for the Codex read-only lane: Responses ingress, Messages upstream. The same
  *  runtime+protocol pair worn by an executor is the third outlet of the CLI executor leg instead -
  *  its own ingress, its own preparation hook and its own build set - so the role decides which of
  *  the two this transport is serving. */
 get codexSupervisorTranslated(){return this.route.runtime==='codex'&&this.route.protocol==='anthropic-messages'&&this.role!=='executor';}
 /** True only for the DSH supervision lane; the native Messages route keeps this false. */
 declare readonly dshSupervisorTranslated:boolean;
 /** True only for the DSH executor lane; every other DSH route keeps this false. */
 declare readonly dshExecutorTranslated:boolean;
 get supervisorTranslated(){return this.claudeTranslated||this.dshSupervisorTranslated||this.dshExecutorTranslated||this.codexSupervisorTranslated;}
 declare readonly officialCliResponses:boolean;
 private path:string;
 private planner?:PaidCodexResponsesLimits;
 private readonly deferredPaidPlanner?:()=>PaidCodexResponsesLimits;
 private prepared=new WeakMap<PreparedMagpieModelRequest,{payload:Readonly<MagpieModelPayload>;recheck:()=>Readonly<MagpieModelPayload>;used:boolean}>();
 private overageResponses=new WeakMap<Response,{prepared:PreparedMagpieModelRequest;draft:MagpieControlDraft;maxInput:number;maxOutput:number}>();
 private reservations=new Set<string>();private secrets=new Set<string>();private closed=false;
 constructor(private context:Context){
  const role=context.role===undefined?'executor':context.role;
  if(!['planner2','executor','reviewer'].includes(role))throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  Object.defineProperty(this,'role',{value:role,enumerable:true,writable:false,configurable:false});
  const address=context.session.observation.address;
  if(typeof address!=='string'||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(address)||Number(address.split(':')[1])>65535)throw new DomainError('MAGPIE_MODEL_ADDRESS_INVALID',409);
  this.route=Object.freeze(concreteMagpieRoute(context.route));this.path=magpieRoutePath(this.route);this.upstream='http://'+address+this.path;
  if(this.claudeTranslated!==!!context.claude)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  if(this.claudeTranslated){
   const accounts=this.matchingAccounts();
   if(!supportsClaudeReadOnlyBuild(context.session.observation.binaryHash)||accounts.length!==1||claudeReadOnlyProtocol(role,this.route,accounts[0].capabilities)!==this.route.protocol)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
   this.claude=Object.freeze({...context.claude!});
  }
  // Protocol dispatch for DSH. The controller declares the translated supervisor lane; every
  // other route keeps the historical behaviour of this transport byte for byte, including the
  // native Messages passthrough. A declared lane that is not exactly planner2/reviewer DSH off
  // the native wire fails closed.
  const dshSupervisor=context.supervisor===true;
  if(dshSupervisor&&(this.route.runtime!=='dsh'||this.route.protocol==='anthropic-messages'||(role!=='planner2'&&role!=='reviewer')))throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  if(dshSupervisor){
   const accounts=this.matchingAccounts();
   if(!supportsDshSupervisorBuild(context.session.observation.binaryHash)||accounts.length!==1||dshSupervisorProtocol(role,this.route,accounts[0].capabilities)!==this.route.protocol)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  }
  Object.defineProperty(this,'dshSupervisorTranslated',{value:dshSupervisor,enumerable:true,writable:false,configurable:false});
  // The executor lane is the same trusted declaration on the tool-calling side. It carries no
  // terminal tool, so it is a different gate and a different ingress shape: a multi-round tool
  // transcript on either OpenAI wire, dispatched by the resolved protocol inside the exchange.
  const dshExecutor=context.dshExecutor===true;
  if(dshSupervisor&&dshExecutor)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  if(dshExecutor&&(this.route.runtime!=='dsh'||this.route.protocol==='anthropic-messages'||role!=='executor'))throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  if(dshExecutor){
   const accounts=this.matchingAccounts();
   if(!supportsDshExecutorBuild(context.session.observation.binaryHash)||accounts.length!==1||dshExecutorProtocol(role,this.route,accounts[0].capabilities)!==this.route.protocol)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  }
  Object.defineProperty(this,'dshExecutorTranslated',{value:dshExecutor,enumerable:true,writable:false,configurable:false});
  // Protocol dispatch for Codex: Codex reads Responses locally, so a Messages route is this
  // lane and needs its own preparation hook. Both directions fail closed.
  if(this.codexSupervisorTranslated!==!!context.codexSupervisor)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  if(this.codexSupervisorTranslated){
   const accounts=this.matchingAccounts();
   if(!supportsCodexSupervisorBuild(context.session.observation.binaryHash)||accounts.length!==1||codexSupervisorProtocol(role,this.route,accounts[0].capabilities)!==this.route.protocol)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
   this.codex=Object.freeze({...context.codexSupervisor!});
  }
  this.claudeSupervisor=this.claudeTranslated||this.isClaudeSupervisor();
 // The executor arm of the Claude runtime: the installed CLI's own edit/shell tools over the
 // native Messages wire. It is not a supervisor lane, and it is deliberately NOT single
 // consumption. One executor turn is many Messages requests (one per tool round), and each
 // of them is already bounded three times over without a used latch: prepare() returns a
 // fresh prepared payload, send() consumes that payload exactly once and refuses a repeated
 // reservation id, and the Gateway's maximumRequests bounds the whole turn. Adding the
 // read-only supervisor's claudeUsed latch here would kill every turn after its first tool
 // call, which is exactly how the translated read-only lane must behave and must never be
 // how this one does.
 const claudeExecutor=this.route.runtime==='claude'&&this.route.protocol==='anthropic-messages'&&role==='executor';
 if(claudeExecutor&&this.claude!==undefined)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
 if(claudeExecutor){
  const accounts=this.matchingAccounts();
  if(!supportsClaudeExecutorBuild(context.session.observation.binaryHash)||accounts.length!==1||claudeExecutorProtocol(role,this.route,accounts[0].capabilities)!==this.route.protocol)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
 }
 this.claudeExecutor=claudeExecutor;
  // The three remaining CLI executor legs share the Claude arm's shape: the harness owns its
  // tools, so the model leg is a native passthrough, and one executor turn is many requests. The
  // single-use latch of the read-only lanes must therefore not apply here either; what bounds a
  // turn is the prepared-payload/ reservation pair plus the Gateway's maximumRequests.
  const cliRuntime=this.route.runtime;
  const cliLeg=role!=='executor'?undefined:cliRuntime==='claude'?('claude' as const):cliRuntime==='opencode'?('opencode' as const):cliRuntime==='cline'?('cline' as const):cliRuntime==='codex'?('codex' as const):undefined;
  // Which outlet this route is: the harness's own wire is the passthrough, everything else the
  // product translates. The two are decided here once so no later check can read the wrong one.
  const cliNativeWire=cliLeg===undefined?undefined:isCliExecutorNativeWire(cliLeg,this.route.protocol);
  const cliExecutor=cliLeg!==undefined&&cliLeg!=='claude'&&cliNativeWire===true?cliLeg:undefined;
  if(cliExecutor){
   if(cliExecutor==='codex'&&this.route.authentication!=='api_key')throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
   if(this.claude!==undefined||this.claudeSupervisor)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
   const accounts=this.matchingAccounts();
   const supported=cliExecutor==='codex'?supportsCodexExecutorBuild:cliExecutor==='opencode'?supportsOpencodeExecutorBuild:supportsClineExecutorBuild;
   const protocol=cliExecutor==='codex'?codexExecutorProtocol(role,this.route,accounts[0]?.capabilities):cliExecutor==='opencode'?opencodeExecutorProtocol(role,this.route,accounts[0]?.capabilities):clineExecutorProtocol(role,this.route,accounts[0]?.capabilities);
   if(!supported(context.session.observation.binaryHash)||accounts.length!==1||protocol!==this.route.protocol)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  }
  // Publish the purpose, not just gate on it. The Gateway reads the cliExecutor member off this
 // channel to admit the tool-bearing executor shape; without this assignment a Cline or OpenCode
 // native executor turn was gated correctly here and then reached the Gateway as a channel with no
 // purpose at all, so its request was judged by the strict non-executor body rule and denied for
 // the output bound its own model table states. Defined once, here, and undefined for every other
 // role and for the translated outlet below.
 Object.defineProperty(this,'cliExecutor',{value:cliExecutor,enumerable:true,writable:false,configurable:false});
 // A CLI executor whose model declares no native wire is served by the translated outlet: the
  // product builds the upstream body and rebuilds the CLI's own dialect from the answer. The two
  // outlets never share evidence - the translated set was earned by a translated turn, the native
  // set by a native one - so this branch tests its own selector and its own digest set.
  // Every outlet that is not the harness's own wire is a translated one: Chat for any leg, Responses
  // for the three Messages CLIs, and - for Codex alone - the native Messages wire itself, which the
  // product renders in the Anthropic dialect and rebuilds as the Responses items the CLI reads.
  const cliRuntimeName=cliLeg;
  const cliTranslated=cliLeg!==undefined&&cliNativeWire===false&&
   (this.route.protocol==='chat-completions'||(cliLeg==='codex'&&this.route.protocol==='anthropic-messages')||
    (cliLeg!=='codex'&&this.route.protocol==='openai-responses'));
  if(cliTranslated){
   if(this.claude!==undefined||this.claudeSupervisor||this.dshSupervisorTranslated||this.dshExecutorTranslated)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
   const accounts=this.matchingAccounts();
   // Each translated outlet answers its own evidence set; Codex's Messages outlet has a third one.
   const supports=cliExecutorTranslatedBuildSet(cliRuntimeName!,this.route.protocol);
   const protocol=cliRuntimeName==='claude'?claudeExecutorProtocol(role,this.route,accounts[0]?.capabilities):
    cliRuntimeName==='opencode'?opencodeExecutorProtocol(role,this.route,accounts[0]?.capabilities):
    cliRuntimeName==='cline'?clineExecutorProtocol(role,this.route,accounts[0]?.capabilities):codexExecutorProtocol(role,this.route,accounts[0]?.capabilities);
   if(!supports(context.session.observation.binaryHash)||accounts.length!==1||protocol!==this.route.protocol)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
   // The native field stays undefined: `cliExecutor` names the passthrough purpose, and a
   // translated turn is a different purpose on a different ingress wire. `cliExecutorRuntime`
   // states which CLI is speaking so the Gateway can check the ingress wire against it.
   Object.defineProperty(this,'cliExecutorRuntime',{value:cliRuntimeName,enumerable:true,writable:false,configurable:false});
  }
  Object.defineProperty(this,'cliExecutorTranslated',{value:cliTranslated,enumerable:true,writable:false,configurable:false});
  // A CLI executor on the Responses wire is the harness's own tool turn, not the paid one-shot
  // planner envelope that the same runtime+protocol pair denotes for a read role.
  const subscription=this.path==='/backend-api/codex/responses',paidResponses=isPaidCodexResponsesRoute(this.route)&&!cliExecutor;
  const official=this.route.protocol==='openai-responses'&&(this.route.runtime==='opencode'||this.route.runtime==='cline');
  const piRoute=this.route.runtime==='pi'&&this.route.protocol!=='chat-completions';
  // Pi has two lanes on the same wire and they never share evidence: the executor's tool turn is
  // piExecutorNativeBuilds, a read role's single supervision answer is piReadOnlyBuilds. The role
  // decides which build set and which selector gate this route, and a read-only lane is admitted
  // only with the frozen read tool set in its session limits - a widened set is a different lane
  // and is refused here before any byte is prepared for upstream.
  const piReadOnly=piRoute&&role!=='executor';
  const accounts=official||piRoute?this.matchingAccounts():[];
  const piSupported=piReadOnly
   ?supportsPiReadOnlyBuild(context.session.observation.binaryHash)&&piReadOnlyProtocol(role,this.route,accounts[0]?.capabilities)===this.route.protocol&&piReadOnlyToolsOnly(context.pi?.limits.tools??[])
   :supportsPiExecutorNativeBuild(context.session.observation.binaryHash)&&piExecutorNativeProtocol(role,this.route,accounts[0]?.capabilities)===this.route.protocol;
  if(piRoute!==!!context.pi||piRoute&&(!piSupported||accounts.length!==1||context.pi!.limits.protocol!==this.route.protocol||context.pi!.limits.model!==this.route.model))throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  Object.defineProperty(this,'piNative',{value:context.pi,enumerable:true,writable:false,configurable:false});
  const verifiedOfficial=official&&accounts.length===1&&isOfficialCliResponsesRoute(context.session.observation.binaryHash,role,this.route,accounts[0].capabilities);
  Object.defineProperty(this,'officialCliResponses',{value:verifiedOfficial,enumerable:true,writable:false,configurable:false});
  if(official&&!this.officialCliResponses)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  const planner=context.planner,deferred=typeof planner==='function';
  if(subscription&&(role!=='planner2'||!planner||deferred)||paidResponses&&(role==='executor'||!deferred&&planner?.model!==this.route.model)||
     this.officialCliResponses&&(!planner||deferred||planner.model!==this.route.model)||
     !subscription&&!paidResponses&&!official&&!this.codexSupervisorTranslated&&planner)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  this.deferredPaidPlanner=deferred?planner:undefined;
  this.planner=deferred?undefined:paidResponses||official?structuredClone(planner):planner;
  Object.defineProperty(this,'responseModel',{value:subscription||piRoute?this.route.model:this.route.provider+'/'+this.route.model,enumerable:true,writable:false,configurable:false});
 }
 private matchingAccounts() {
  const route=this.route;
  return this.context.session.observation.accounts?.filter(account=>account.authentication===route.authentication&&account.provider===route.provider&&
   account.authRef===route.authRef&&account.accountRef===route.accountRef&&account.upstreamAccountRef===route.upstreamAccountRef)??[];
 }
 private isClaudeSupervisor():boolean {
  const route=this.route;
  if(this.role==='executor'||route.runtime!=='claude'||route.authentication!=='api_key'||route.protocol!=='anthropic-messages')return false;
  const matches=this.matchingAccounts();
  if(matches.length!==1)return false;
  const account=matches[0],capabilities=account.capabilities;
  if(capabilities===undefined)return route.provider==='string'&&this.role==='reviewer'&&(account.model===route.model||!!account.models?.includes(route.model));
  return capabilities.some(cap=>cap.model===route.model&&cap.protocol===route.protocol);
 }
 prepareClaude(ingress:ClaudeMessagesIngress,maxInputTokens:number,maxOutputTokens:number,deadline:AbortSignal,assertSafe:(text:string)=>void):PreparedMagpieModelRequest {
  if(this.dshExecutorTranslated){
   // One executor turn is many Messages requests: every tool round asks again. Single use is
   // already enforced per prepared payload (the prepared map plus send's entry.used) and per
   // reservation, while the gateway's maximumRequests bounds the whole turn.
   if(this.closed)throw new DomainError('MAGPIE_MODEL_REQUEST_ALREADY_USED',409);
   // The DSH executor sends its whole tool transcript in every Messages request; the lane
   // replays it verbatim, and only the model bounds are controller data.
   const executorCurrent=()=>{if(this.closed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);};
   const executorContext:Omit<DshExecutorContext,'accounts'>=Object.freeze({route:this.route,role:this.role,limits:Object.freeze({model:this.route.model,maxInputTokens,maxOutputTokens}),signal:deadline,assertCurrent:executorCurrent,assertSafe});
   const executorIngress=Object.freeze({...ingress});
   const prepareExecutor=()=>this.context.session.prepareDshExecutorPayload(executorContext,executorIngress);
   const executorPrepared=prepareExecutor();
   return this.bindPayload(executorPrepared.payload,()=>prepareExecutor().payload,executorPrepared.complete);
  }
  if(this.dshSupervisorTranslated){
   if(this.closed||this.claudeUsed)throw new DomainError('MAGPIE_MODEL_REQUEST_ALREADY_USED',409);
   this.claudeUsed=true;
   // The DSH host froze the prompt and the system text into its Messages request; only the
   // model bounds are controller data, so this lane never re-authors either string.
   // The exact payload binding is revalidated by bindPayload immediately below and again before
   // every hop in send(); this prepare-time check only refuses a closed owner.
   const assertCurrent=()=>{if(this.closed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);};
   const context:Omit<DshSupervisorContext,'accounts'>=Object.freeze({route:this.route,role:this.role,limits:Object.freeze({model:this.route.model,maxInputTokens,maxOutputTokens}),signal:deadline,assertCurrent,assertSafe});
   const frozen=Object.freeze({...ingress});
   const prepare=()=>this.context.session.prepareDshSupervisorPayload(context,frozen);
   const {payload,complete}=prepare();
   return this.bindPayload(payload,()=>prepare().payload,complete);
  }
  const spec=this.claude;
  if(!spec||!this.claudeTranslated||this.closed||this.claudeUsed)throw new DomainError('MAGPIE_MODEL_REQUEST_ALREADY_USED',409);
  this.claudeUsed=true;
  const limits=Object.freeze({prompt:spec.prompt,instructions:spec.instructions,model:this.route.model,maxInputTokens,maxOutputTokens});
  const context:Omit<ClaudeReadOnlyContext,'accounts'>={route:this.route,role:this.role,limits,signal:AbortSignal.any([spec.signal,deadline]),assertCurrent:spec.assertCurrent,assertSafe};
  const frozen=Object.freeze({...ingress});
  const prepare=()=>this.context.session.prepareClaudePayload(context,frozen);
  const {payload,complete}=prepare();
  return this.bindPayload(payload,()=>prepare().payload,complete);
 }
 /** The translated CLI executor outlet: the CLI's own request is validated, replayed onto the
  *  OpenAI wire the model declares, and its answer is rebuilt in the CLI's dialect. One executor
  *  turn is many requests (one per tool round), so no single-use latch applies here: the prepared
  *  payload, its reservation and the Gateway's request ceiling bound the turn instead. */
 prepareCliExecutor(ingress:CliExecutorIngress,maxInputTokens:number,maxOutputTokens:number,deadline:AbortSignal,assertSafe:(text:string)=>void):PreparedMagpieModelRequest {
  if(!this.cliExecutorTranslated)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  if(this.closed)throw new DomainError('MAGPIE_MODEL_REQUEST_ALREADY_USED',409);
  const executorCurrent=()=>{if(this.closed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);};
  const context:Omit<CliExecutorContext,'accounts'>=Object.freeze({route:this.route,role:this.role,
   limits:Object.freeze({model:this.route.model,maxInputTokens,maxOutputTokens}),signal:deadline,assertCurrent:executorCurrent,assertSafe});
  const frozen=Object.freeze({...ingress});
  const prepare=()=>this.context.session.prepareCliExecutorPayload(context,frozen);
  const {payload,complete}=prepare();
  return this.bindPayload(payload,()=>prepare().payload,complete);
 }
 /** The Codex read-only lane: the CLI's frozen Responses turn becomes one Messages request. */
 prepareCodexSupervisor(ingress:CodexResponsesIngress,maxInputTokens:number,maxOutputTokens:number,deadline:AbortSignal,assertSafe:(text:string)=>void):PreparedMagpieModelRequest {
  const spec=this.codex;
  if(!spec||!this.codexSupervisorTranslated||this.closed||this.claudeUsed)throw new DomainError('MAGPIE_MODEL_REQUEST_ALREADY_USED',409);
  this.claudeUsed=true;
  const limits=Object.freeze({model:this.route.model,instructions:spec.instructions,maxInputTokens,maxOutputTokens});
  const context:Omit<CodexSupervisorContext,'accounts'>=Object.freeze({route:this.route,role:this.role,limits,prompt:spec.prompt,signal:AbortSignal.any([spec.signal,deadline]),assertCurrent:spec.assertCurrent,assertSafe});
  const frozen=Object.freeze({...ingress});
  const prepare=()=>this.context.session.prepareCodexSupervisorPayload(context,frozen);
  const {payload,complete}=prepare();
  return this.bindPayload(payload,()=>prepare().payload,complete);
 }
 prepare(raw:string):PreparedMagpieModelRequest {
  if(this.claudeTranslated||this.codexSupervisorTranslated||this.cliExecutorTranslated)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
  if(this.closed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
  if(this.deferredPaidPlanner&&!this.planner){
   // The Codex runner finishes assembling the review prompt after its thread is bound.
   const planner=this.deferredPaidPlanner();
   if(planner?.model!==this.route.model||!planner.prompt)throw new DomainError('MAGPIE_MODEL_ROLE_INVALID',409);
   this.planner=structuredClone(planner);
  }
  const prepare=()=>this.context.session.prepareModelPayload(this.route,raw,this.planner,this.role,this.piNative);
  return this.bindPayload(prepare(),prepare);
 }
 private bindPayload(payload:Readonly<MagpieModelPayload>,recheck:()=>Readonly<MagpieModelPayload>,completeClaude?:PreparedMagpieModelRequest['completeClaude']) {
  const binding=nativeRequestBinding(this.context.bindRequest(payload),this.role);
  if(binding.engineeringMode!=='custom')throw new DomainError('CLASSIC_MAGPIE_FORBIDDEN',409);
  if(binding.bodyHash!==payload.bodyHash||binding.routeHash!==payload.routeHash||payload.path!==this.path||payload.method!=='POST'||hash(payload.body)!==payload.bodyHash)throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
  this.context.assertCurrent(binding);Object.freeze(binding.work);Object.freeze(binding);
  if((this.officialCliResponses||this.piNative?.limits.tools.length===0||this.claudeTranslated||this.codexSupervisorTranslated)&&binding.work.kind==='QUALIFICATION')officialProbeBindings.set(binding,{budget:this.context.budget,routeHash:magpieRouteHash(this.route),maxOutputTokens:payload.maxOutputTokens});
  const prepared=Object.freeze({body:payload.body,binding,maxOutputTokens:payload.maxOutputTokens,...(completeClaude?{completeClaude}:{})});this.prepared.set(prepared,{payload,recheck,used:false});return prepared;
 }
 async send(prepared:PreparedMagpieModelRequest,reservationId:string,signal:AbortSignal,subscription?:{turn:CodexIncludedTurn;authorization:string;accountId?:string}):Promise<Response>{
  if(this.closed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
  const entry=this.prepared.get(prepared);if(!entry||entry.used||this.reservations.has(reservationId))throw new DomainError('MAGPIE_MODEL_REQUEST_ALREADY_USED',409);
  if(this.reservations.size>=200)throw new DomainError('MAGPIE_MODEL_REQUEST_LIMIT',409);
  if(signal.aborted)throw new DomainError('MAGPIE_CONTROL_CANCELLED',409);
  const {binding}=prepared,{payload}=entry,{budget,session}=this.context;
  this.context.assertCurrent(binding);
  const hold=budget.pendingBoundRequest(reservationId,binding);
  if(hold.routerAdmission||hold.price.provider!==payload.route.provider||hold.price.model!==payload.route.model||hold.maxOutputTokens!==payload.maxOutputTokens)throw new DomainError('MAGPIE_CONTROL_BUDGET_MISMATCH',409);
  // Consume before touching the child: unknown issue/grant/send results are never retried here.
  entry.used=true;this.reservations.add(reservationId);
  // Go applies this expiry to the upstream stream, not only to initial admission.
  // Keep its existing 120s protocol ceiling and the original price deadline.
  const subscriptionRoute=this.path==='/backend-api/codex/responses';
  if(subscriptionRoute!==!!subscription)throw new DomainError('CODEX_SUBSCRIPTION_GATEWAY_REQUIRED',409);
  let credentialHash:string|undefined,checkSubscription:(()=>void)|undefined;
  subscription=subscription?{...subscription}:undefined;
  if(subscription){
   if(typeof subscription.authorization!=='string'||!/^Bearer [a-zA-Z0-9._~+/=-]{1,16384}$/.test(subscription.authorization)||
      subscription.accountId!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,170}$/.test(subscription.accountId))throw new DomainError('CODEX_SUBSCRIPTION_GATEWAY_REQUIRED',409);
   checkSubscription=budget.includedPlannerCheck(reservationId,subscription.turn);
   credentialHash=hash(subscription.authorization+'\0'+(subscription.accountId??''));
  }
  const expiresAtMs=Math.min(Date.now()+120000,Date.parse(hold.price.expiresAt));
  const draft:MagpieControlDraft={token:randomBytes(32).toString('hex'),id:'admission_'+randomBytes(10).toString('hex'),epoch:session.observation.epoch,
   projectId:binding.projectId,flowId:binding.runId,configurationHash:binding.configurationHash,bindingHash:hash(binding),routeHash:binding.routeHash,roleId:binding.roleId,role:binding.role,
   ...(credentialHash?{subscriptionRequestHash:credentialHash}:{}),reservationId,...payload.route,method:payload.method,path:payload.path,bodyHash:payload.bodyHash,expiresAtMs};
  this.secrets.add(draft.token);
  const issued=await session.control.prepare(reservationId,binding,draft,signal);this.secrets.add(issued.upstreamKey);
  this.context.assertCurrent(binding);
  const ack=await session.control.grant(reservationId,binding,issued,signal);
  if(ack.status!=='ACKNOWLEDGED')throw new DomainError('MAGPIE_MODEL_ADMISSION_DENIED',409);
  this.context.assertCurrent(binding);budget.pendingBoundRequest(reservationId,binding);
  if(signal.aborted||Date.now()>=expiresAtMs)throw new DomainError('MAGPIE_CONTROL_CANCELLED',409);
  // The owned session must still admit the identical account/model bytes immediately before send.
  const current=entry.recheck();
  if(current.bodyHash!==payload.bodyHash||current.routeHash!==payload.routeHash)throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
  const headers:Record<string,string>={ 'content-type':'application/json',authorization:'Bearer '+draft.token };
  if(subscription){
   checkSubscription!();
   this.secrets.add(subscription.authorization.slice(7));
   headers.authorization=subscription.authorization;
   headers['X-DM-Gateway']=draft.token;
   headers.accept='text/event-stream';
   if(subscription.accountId)headers['ChatGPT-Account-ID']=subscription.accountId;
  }
  if(this.route.protocol==='anthropic-messages')headers['anthropic-version']='2023-06-01';
  // The supervision lanes read a settled Chat JSON answer or a Responses stream; the executor
  // lane always reads an SSE stream - Chat or Responses - because its answer and every tool call
  // are reconstructed from deltas.
  if(this.supervisorTranslated||this.cliExecutorTranslated)headers.accept=this.dshExecutorTranslated||this.cliExecutorTranslated||this.route.protocol!=='chat-completions'?'text/event-stream':'application/json';
  if(this.piNative||this.officialCliResponses||isPaidCodexResponsesRoute(this.route))headers.accept='text/event-stream';
  const send=this.context.transport??loopbackFetch;
  try{
   const response=await send(this.upstream,{method:'POST',redirect:'error',headers,body:payload.body,signal});
   if(send===loopbackFetch&&response.status===502&&response.url===this.upstream&&!response.redirected&&
      response.headers.get('content-type')===overageMedia&&response.headers.get('cache-control')==='no-store'){
    if(this.piNative||this.supervisorTranslated)this.overageResponses.set(response,{prepared,draft,maxInput:hold.price.maxInputTokens,maxOutput:hold.maxOutputTokens});
   }
   return response;
  }
  catch(error){
   // Classify before wrapping: the wrapper's own code must not hide a nested TLS,
   // deliberate cancellation or already-classified policy refusal from the Gateway.
   // DIRECT describes this controller-to-owned-loopback hop; do not invent proof
   // of the Magpie child's external proxy route from an environment variable.
   const safe=networkFailureError(classifyNetworkFailure({error,context:'DIRECT'}),'MAGPIE_MODEL_TRANSPORT_LOST');
   // Preserve only allowlisted scalar codes. Never retain an original exception,
   // proxy message, address, header or credentials in the safe error's cause.
   let current=error;
   try{for(let depth=0;depth<5&&current&&typeof current==='object';depth++){
    const fields=Object.getOwnPropertyDescriptors(current),code=fields.code?.value;
    if(typeof code==='string'&&['ECONNRESET','ECONNREFUSED','ECONNABORTED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','ENOTFOUND','ABORT_ERR','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'].includes(code)){
     Object.defineProperty(safe,'cause',{value:{code}});break;
    }
    current=fields.cause?.value;
   }}catch{/* Diagnostics cannot replace or disclose the original failure. */}
   throw safe;
  }
 }
 async consumeVerifiedOverage(response:Response,prepared:PreparedMagpieModelRequest,reservationId:string):Promise<NativeUsage|null>{
  const issued=this.overageResponses.get(response);
  this.overageResponses.delete(response);
  if(!issued||issued.prepared!==prepared||issued.draft.reservationId!==reservationId)return null;
  const mac=response.headers.get('x-dm-overage-mac');
  if(!mac||!/^[a-f0-9]{64}$/.test(mac)||!response.body)return null;
  const reader=response.body.getReader();
  try{
   const chunks:Uint8Array[]=[];let size=0;
   for(;;){
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>2048)return null;
    chunks.push(value);
   }
   const raw=Buffer.concat(chunks,size),{draft}=issued;
   const expected=createHmac('sha256',draft.token).update(overageSchema+'\n').update(raw).digest();
   if(!timingSafeEqual(expected,Buffer.from(mac,'hex')))return null;
   const record=object(parseGatewayJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw),()=>{}));
   if(Object.keys(record).length!==8||record.schema!==overageSchema||record.admissionId!==draft.id||record.reservationId!==reservationId||
      record.routeHash!==draft.routeHash||record.bodyHash!==draft.bodyHash)return null;
   const {inputTokens,cacheHitTokens,outputTokens}=record;
   const count=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
   if(!count(inputTokens)||!count(cacheHitTokens)||!count(outputTokens)||cacheHitTokens>inputTokens||
      inputTokens<=issued.maxInput&&outputTokens<=issued.maxOutput)return null;
   return {inputTokens,cacheHitTokens,outputTokens};
  }catch{return null;}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 assertPreparedCurrent(prepared:PreparedMagpieModelRequest):void {
  if(this.closed)throw new DomainError('MAGPIE_CONTROL_CLOSED',409);
  if(!this.prepared.get(prepared)?.used)throw new DomainError('MAGPIE_MODEL_BINDING_MISMATCH',409);
  this.context.assertCurrent(prepared.binding);
 }
 assertSafeResponse(text:string):void {if([...this.secrets].some(secret=>text.includes(secret)))throw new DomainError('MODEL_GATEWAY_SECRET_IN_RESPONSE',502);}
 async close():Promise<void>{this.closed=true;try{await this.context.session.close();}finally{this.secrets.clear();}}
}
