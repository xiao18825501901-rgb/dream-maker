import {get} from 'node:http';
import {customMagpieProtocol} from '../../shared/custom-magpie-protocol.js';
import type {CustomFlowProfile,CustomRoleProfile} from '../../shared/flow-profile.js';
import {customFlowProfile} from '../flow-profiles.js';
import type {MagpieControlObservation} from '../magpie-owned.js';
import {additionalMagpieRoute,concreteMagpieRoute,magpieRouteHash,supportsClaudeExecutorBuild,supportsClaudeExecutorTranslatedBuild,supportsClaudeReadOnlyBuild,supportsClineExecutorBuild,supportsClineExecutorTranslatedBuild,supportsCodexExecutorBuild,supportsCodexExecutorMessagesBuild,supportsCodexExecutorTranslatedBuild,supportsDshExecutorBuild,supportsDshSupervisorBuild,supportsOpencodeExecutorBuild,supportsOpencodeExecutorTranslatedBuild,supportsPiExecutorNativeBuild,supportsPiReadOnlyBuild,supportsCodexSupervisorBuild,supportsOfficialCliMessagesBuild,supportsOfficialCliResponsesBuild,type MagpieConcreteRoute} from '../magpie-route.js';
import {DomainError,hash} from '../security.js';

type Role='planner2'|'executor'|'reviewer';
type Protocol=MagpieConcreteRoute['protocol'];
const paths=new Map<string,Protocol>([['/v1/chat/completions','chat-completions'],['/v1/responses','openai-responses'],['/v1/messages','anthropic-messages']]);
const fail=(code:string):never=>{throw new DomainError(code,409);};
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value)&&!value.includes('://');
export interface DesktopMagpieModel {id:string;provider:string;kind:'provider'|'alias';protocols:Protocol[]}
export function parseDesktopMagpieCatalog(raw:unknown){
 const invalid=()=>fail('CUSTOM_MAGPIE_CATALOG_INVALID');
 if(!raw||typeof raw!=='object'||!('object' in raw)||raw.object!=='list'||!('data' in raw)||!Array.isArray(raw.data)||raw.data.length>8192||('has_more' in raw&&raw.has_more!==false))return invalid();
 const models:DesktopMagpieModel[]=[];
 const seen=new Set<string>();
 for(const row of raw.data){
  if(!row||row.object!=='model'||!identifier(row.id)||!identifier(row.owned_by)||row.owned_by.includes('/')||seen.has(row.id))return invalid();
  const endpoints:unknown=row.native_endpoints??[];
  if(!Array.isArray(endpoints)||endpoints.length>32||endpoints.some(p=>typeof p!=='string'))return invalid();
  const protocols=new Set<Protocol>();
  for(const endpoint of endpoints){const protocol=paths.get(endpoint);if(protocol)protocols.add(protocol);}
  seen.add(row.id);
  models.push({id:row.id,provider:row.owned_by,kind:row.id.startsWith(row.owned_by+'/')?'provider':'alias',protocols:[...protocols]});
 }
 return {scope:'DESKTOP_METADATA_ONLY' as const,models};
}

/** Only the controller chooses the observed local listener. HTTP requests carry no credentials. */
export function readDesktopMagpieCatalog(port:number,signal?:AbortSignal):Promise<ReturnType<typeof parseDesktopMagpieCatalog>>{
 if(!Number.isInteger(port)||port<1||port>65535)return Promise.reject(new DomainError('CUSTOM_MAGPIE_CATALOG_PORT_INVALID',400));
 return new Promise((resolve,reject)=>{
  const req=get({hostname:'127.0.0.1',port,path:'/v1/models',agent:false,headers:{accept:'application/json'},signal},res=>{
   if(res.statusCode!==200||!/^application\/json(?:;|$)/i.test(res.headers['content-type']??'')){reject(new DomainError('CUSTOM_MAGPIE_CATALOG_UNAVAILABLE',503));req.destroy();return;}
   const chunks:Buffer[]=[];let size=0;
   res.on('error',reject);
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4*1024*1024){reject(new DomainError('CUSTOM_MAGPIE_CATALOG_TOO_LARGE',413));req.destroy();return;}chunks.push(chunk);});
   res.on('end',()=>{try{resolve(parseDesktopMagpieCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8'))));}catch{reject(new DomainError('CUSTOM_MAGPIE_CATALOG_INVALID',502));}});
  });
  const timer=setTimeout(()=>req.destroy(new DomainError('CUSTOM_MAGPIE_CATALOG_TIMEOUT',504)),5000);
  req.once('close',()=>clearTimeout(timer));
   req.once('error',error=>reject(error instanceof DomainError||signal?.aborted?error:new DomainError('CUSTOM_MAGPIE_CATALOG_UNAVAILABLE',503)));
 });
}

// Replaced only with a verified digest of the offline-tested physical transport build.
const cliReviewerProBinary='940711059f87125f893dc009f0146d4f065ea6448384e168554024790c113e79';
// Only physical regressions against a v5-capable build may add a digest here.
const explicitCapabilityBuilds:ReadonlySet<string>=new Set(['15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8']);
/** Selects a declared wire protocol only. The caller verifies the binary and owned account. */
export function customMagpieCapabilityProtocol(role:Role,actor:CustomRoleProfile,capabilities:NonNullable<MagpieControlObservation['accounts'][number]['capabilities']>):Protocol|undefined {
 if(actor.authentication!=='api_key'||actor.model.kind!=='model')return;
 const protocols=capabilities.filter(cap=>cap.model===actor.model.id).map(cap=>cap.protocol);
 return customMagpieProtocol(role,actor.runtime,protocols);
}
function physicalProtocol(role:Role,actor:CustomRoleProfile,binaryHash:string):Protocol|undefined {
 const {provider,runtime,authentication,model}=actor;
 if(provider==='openai'&&runtime==='codex'&&role==='planner2'&&authentication==='oauth'&&model.id==='gpt-6-luna')return 'openai-responses';
 if(authentication!=='api_key')return;
 if(provider==='string'&&runtime==='claude'&&role==='reviewer'&&model.id==='claude-sonnet-5')return 'anthropic-messages';
 if(provider!=='deepseek-official')return;
 if(model.id==='deepseek-v4-pro'&&role==='reviewer'&&(runtime==='independent'||['cline','opencode'].includes(runtime)&&/^[a-f0-9]{64}$/.test(binaryHash)&&binaryHash===cliReviewerProBinary))return 'chat-completions';
 if(model.id!=='deepseek-flash')return;
 if(runtime==='dsh')return 'anthropic-messages';
 if(runtime==='pi'&&role==='executor'||role!=='executor'&&['codex','independent','opencode','cline'].includes(runtime))return 'chat-completions';
}

/** Resolves a frozen actor inside a trusted owned session. Subscription fingerprint and grants remain caller-owned. */
export function resolveCustomMagpieRoute(observation:Readonly<MagpieControlObservation>,role:Role,actor:CustomRoleProfile):MagpieConcreteRoute {
 if(actor.transport!=='magpie'||actor.nativeException||actor.model.kind!=='model'||!actor.permissions.includes('source_read')||role!=='executor'&&actor.permissions.includes('source_write')||!['planner2','executor','reviewer'].includes(role)||(role==='executor'?['planner2','reviewer'].includes(actor.id):actor.id!==role))return fail('CUSTOM_MAGPIE_ROUTE_UNSUPPORTED');
 if(observation.scope!=='LOCAL_CONTROL_PROCESS_ONLY'||observation.accountCount!==observation.accounts.length)return fail('CUSTOM_MAGPIE_OBSERVATION_INVALID');
 const {runtime,provider,authRef,accountRef,authentication}=actor;
 const matches=observation.accounts.filter(a=>a.provider===provider&&a.authRef===authRef&&a.accountRef===accountRef&&a.authentication===authentication);
 if(matches.length>1)return fail('CUSTOM_ACCOUNT_SOURCE_MISMATCH');
 const account=matches[0],capabilities=account?.capabilities;
 // Any registered lane opens the capability table; which lane a role then resolves is the
 // protocol matrix's business, and the translated CLI outlets keep their own (still empty) sets so
 // naming one here opens nothing by itself.
 if(capabilities!==undefined&&!explicitCapabilityBuilds.has(observation.binaryHash)&&!supportsOfficialCliResponsesBuild(observation.binaryHash)&&!supportsPiExecutorNativeBuild(observation.binaryHash)&&!supportsPiReadOnlyBuild(observation.binaryHash)&&!supportsClaudeReadOnlyBuild(observation.binaryHash)&&!supportsClaudeExecutorBuild(observation.binaryHash)&&!supportsOpencodeExecutorBuild(observation.binaryHash)&&!supportsClineExecutorBuild(observation.binaryHash)&&!supportsCodexExecutorBuild(observation.binaryHash)&&!supportsDshSupervisorBuild(observation.binaryHash)&&!supportsDshExecutorBuild(observation.binaryHash)&&!supportsOfficialCliMessagesBuild(observation.binaryHash)&&!supportsCodexSupervisorBuild(observation.binaryHash)&&!supportsClaudeExecutorTranslatedBuild(observation.binaryHash)&&!supportsOpencodeExecutorTranslatedBuild(observation.binaryHash)&&!supportsClineExecutorTranslatedBuild(observation.binaryHash)&&!supportsCodexExecutorTranslatedBuild(observation.binaryHash)&&!supportsCodexExecutorMessagesBuild(observation.binaryHash))return fail('CUSTOM_MAGPIE_ROUTE_UNSUPPORTED');
 const protocol=capabilities===undefined
  ?physicalProtocol(role,actor,observation.binaryHash)
  :customMagpieCapabilityProtocol(role,actor,capabilities);
 if(!protocol){
  if(account&&capabilities){
   // The placeholder protocol is not a decision: additionalMagpieRoute reads the declared
   // capabilities, so it resolves the harness's own wire, a translated outlet or nothing at all.
   const candidate={runtime,provider,authRef,accountRef,authentication,protocol:'openai-responses' as const,model:actor.model.id,upstreamAccountRef:account.upstreamAccountRef};
   const extra=additionalMagpieRoute(role,candidate,capabilities);
   if(extra?.supportsBuild(observation.binaryHash))return concreteMagpieRoute({...candidate,protocol:extra.protocol});
  }
  return fail('CUSTOM_MAGPIE_ROUTE_UNSUPPORTED');
 }
 if(!account||capabilities===undefined&&account.model!==actor.model.id&&!account.models?.includes(actor.model.id))return fail('CUSTOM_ACCOUNT_SOURCE_MISMATCH');
 return concreteMagpieRoute({runtime,provider,authRef,accountRef,authentication,protocol,model:actor.model.id,upstreamAccountRef:account.upstreamAccountRef});
}

export interface MagpieSelectionBinding {profileHash:string;roleId:string;routeHash:string;currency:'CNY'|'USD'}
export interface MagpieSelectionEstimate extends MagpieSelectionBinding {reserveMicros:number;roleRemainingMicros:number;flowRemainingMicros:number;expiresAtMs:number}
type EstimateLookup=(binding:Readonly<MagpieSelectionBinding>,route:Readonly<MagpieConcreteRoute>)=>MagpieSelectionEstimate|undefined;

/** Read-only pre-confirmation recommendation. Dispatch always reserves again for the frozen member. */
export function selectCustomMagpieMember(input:CustomFlowProfile,role:Role,roleId:string,observation:Readonly<MagpieControlObservation>,budgetLookup:EstimateLookup,previousMemberId?:string){
 const profile=customFlowProfile(input),profileHash=hash(profile);
 const actor=role==='executor'?profile.roles.executors.find(r=>r.id===roleId):profile.roles[role];
 if(!actor||actor.id!==roleId||actor.transport!=='magpie'||actor.model.kind!=='group'||profile.privacy.deniedDataLabels.length)return fail('CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID');
 const group=profile.groups.find(g=>g.id===actor.model.id)!;
 const preferred=previousMemberId??actor.selectedMemberId;
 if(preferred!==undefined&&!group.members.some(m=>m.id===preferred))return fail('CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID');
 const candidates=[];
 let matchedRoute=false,matchedEstimate=false;
 for(const [index,m] of group.members.entries()){
  const account=profile.accounts.find(a=>a.provider===m.provider&&a.authRef===m.authRef&&a.accountRef===m.accountRef)!;
  let route:MagpieConcreteRoute;
  try{route=resolveCustomMagpieRoute(observation,role,{...actor,...account,permissions:m.permissions,model:{kind:'model',id:m.model}});}catch(e){
   if(e instanceof DomainError&&(e.code==='CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'||e.code==='CUSTOM_ACCOUNT_SOURCE_MISMATCH'))continue;
   throw e;
  }
  matchedRoute=true;
  const binding={profileHash,roleId,routeHash:magpieRouteHash(route),currency:actor.budget.currency};
  const estimate=budgetLookup(Object.freeze(binding),Object.freeze(route));
  if(!estimate||estimate.profileHash!==profileHash||estimate.roleId!==roleId||estimate.routeHash!==binding.routeHash||estimate.currency!==binding.currency||!Number.isSafeInteger(estimate.expiresAtMs)||estimate.expiresAtMs<=Date.now())continue;
  const {reserveMicros,roleRemainingMicros,flowRemainingMicros}=estimate;
  if(![reserveMicros,roleRemainingMicros,flowRemainingMicros].every(n=>Number.isSafeInteger(n)&&n>=0)||route.authentication==='api_key'&&reserveMicros===0)continue;
  matchedEstimate=true;
  if(reserveMicros>Math.min(actor.budget.maxMicros,profile.budget.maxMicros,roleRemainingMicros,flowRemainingMicros))continue;
  candidates.push({memberId:m.id,binding,reserveMicros,index});
 }
 if(!candidates.length)return fail(matchedEstimate?'CUSTOM_MAGPIE_BUDGET_EXHAUSTED':matchedRoute?'CUSTOM_MAGPIE_ESTIMATE_UNAVAILABLE':'CUSTOM_MAGPIE_NO_ELIGIBLE_MEMBER');
 const current=candidates.find(c=>c.memberId===preferred);
 let selected=candidates[0];
 if(group.strategy==='rotate'&&previousMemberId!==undefined){
  const previous=group.members.findIndex(m=>m.id===previousMemberId);
  selected=candidates.find(c=>c.index>previous)??selected;
 }else if(group.strategy==='cost'||group.strategy==='smart'&&!current){
  selected=candidates.reduce((best,c)=>c.reserveMicros<best.reserveMicros?c:best);
 }else selected=current??selected;
 return {scope:'CONFIGURATION_ONLY' as const,groupId:group.id,memberId:selected.memberId,binding:selected.binding,reserveMicros:selected.reserveMicros};
}
