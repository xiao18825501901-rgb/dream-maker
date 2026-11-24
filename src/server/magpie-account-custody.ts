import type {CustomFlowConfigSnapshot} from '../shared/flow-configuration.js';
import {assertCustomSnapshot} from './flow-configuration.js';
import {customAccountReferences,validateAccountSourceList,type ControllerAccountSource} from './custom-account-sources.js';
import {DomainError,hash,hasSecret,withExplicitSecretInspection} from './security.js';
import {additionalMagpieRoute} from './magpie-route.js';
import {customRoleConfiguration} from './flow/custom-role-identity.js';
import {customMagpieCapabilityProtocol} from './flow/custom-magpie-catalog.js';

declare const custodyBrand:unique symbol;
/** Runtime identity lives only in the controller WeakMap; JSON is never authority. */
export interface MagpieAccountCustody {readonly[custodyBrand]:true}
export interface MagpieCustodyBinding {flowConfigHash:string;sourceBindingHash:string}
export interface CustodiedMagpieAccount {provider:ControllerAccountSource['provider'];authRef:string;accountRef:string;key:string;model?:string;models?:string[];endpoint?:ControllerAccountSource['endpoint'];capabilities?:ControllerAccountSource['capabilities']}
interface CustodyState {
 bridgeBinaryHash?:string;
 binding:MagpieCustodyBinding;snapshot:CustomFlowConfigSnapshot;sources:ControllerAccountSource[];
 getSecret:(name:string)=>string|undefined;assertCurrent:()=>MagpieCustodyBinding;
 expiresAt:number;timer:ReturnType<typeof setTimeout>;signal?:AbortSignal;abort:()=>void;
}
const pending=new WeakMap<object,CustodyState>();
const fail=(code='MAGPIE_ACCOUNT_CUSTODY_INVALID'):never=>{throw new DomainError(code,409);};
function binding(raw:unknown):MagpieCustodyBinding {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const d=Object.getOwnPropertyDescriptors(raw),keys=['flowConfigHash','sourceBindingHash'];
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')||typeof d[k].value!=='string'||!/^[a-f0-9]{64}$/.test(d[k].value)))return fail();
 return{flowConfigHash:d.flowConfigHash.value,sourceBindingHash:d.sourceBindingHash.value};
}
export function revokeMagpieAccountCustody(ticket:MagpieAccountCustody):void {
 const state=pending.get(ticket);if(!state)return;pending.delete(ticket);clearTimeout(state.timer);state.signal?.removeEventListener('abort',state.abort);
}
export function magpieAccountCustodyPending(ticket:MagpieAccountCustody):boolean {
 const state=pending.get(ticket);if(!state)return false;if(performance.now()>=state.expiresAt||state.signal?.aborted){revokeMagpieAccountCustody(ticket);return false;}return true;
}
/** Called only by the original NativeOwner after resolving approved Store references.
 * This prepares a capability, not an authenticated account or dispatch permission. */
export function createMagpieAccountCustody(input:{snapshot:CustomFlowConfigSnapshot;binding:MagpieCustodyBinding;sources:ControllerAccountSource[];dshKeyEnv:string;getSecret:(name:string)=>string|undefined;assertCurrent:()=>MagpieCustodyBinding;signal?:AbortSignal;maxAgeMs?:number;bridgeCandidateHash?:()=>string}):MagpieAccountCustody {
 const bound=binding(input.binding),snapshot=structuredClone(input.snapshot);assertCustomSnapshot(snapshot);
 const maxAge=input.maxAgeMs??30000;if(!Number.isSafeInteger(maxAge)||maxAge<10||maxAge>30000||input.signal?.aborted||typeof input.getSecret!=='function'||typeof input.assertCurrent!=='function')return fail();
 if(bound.flowConfigHash!==hash(snapshot))return fail('MAGPIE_ACCOUNT_CUSTODY_STALE');
 const catalog=validateAccountSourceList(input.sources,input.dshKeyEnv),{magpie}=customAccountReferences(snapshot);
 const roles=[{role:'planner2' as const,selected:snapshot.roles.planner2},...snapshot.roles.executors.map(selected=>({role:'executor' as const,selected})),{role:'reviewer' as const,selected:snapshot.roles.reviewer}];
 let bridgeBinaryHash:string|undefined;
 for(const {role,selected} of roles.filter(entry=>entry.selected.transport==='magpie')){
  const actor=customRoleConfiguration(snapshot,role,role==='executor'?selected.id:undefined);
  // Custody checks the wire required by each frozen role before resolving any key.
  if(role==='planner2'&&actor.runtime==='codex'&&actor.provider==='openai'&&actor.authentication==='oauth')continue;
  const source=catalog.find(s=>s.authRef===actor.authRef&&s.accountRef===actor.accountRef&&s.provider===actor.provider&&s.authentication===actor.authentication);
  if(!source)return fail('MAGPIE_ACCOUNT_SOURCE_REQUIRED');
  if(source.capabilities){
   if(!customMagpieCapabilityProtocol(role,actor,source.capabilities)){
    const candidate={runtime:actor.runtime,authentication:actor.authentication,model:actor.model.id,protocol:'openai-responses' as const};
    const extra=additionalMagpieRoute(role,candidate,source.capabilities);
    if(actor.model.kind!=='model'||!extra)return fail('MAGPIE_ACCOUNT_MODEL_UNSUPPORTED');
    bridgeBinaryHash??=input.bridgeCandidateHash?.();
    if(!bridgeBinaryHash||!extra.supportsBuild(bridgeBinaryHash))return fail('MAGPIE_ACCOUNT_MODEL_UNSUPPORTED');
   }
   continue;
  }
  const supported=actor.provider==='deepseek-official'&&['codex','dsh','independent','pi','opencode','cline'].includes(actor.runtime)||
   actor.provider==='string'&&actor.runtime==='claude'&&role==='reviewer';
  if(!supported||actor.authentication!=='api_key')return fail('MAGPIE_ACCOUNT_ROUTE_UNSUPPORTED');
  const allowed=source.models??(source.model?[source.model]:['deepseek-flash']);
  if(!allowed.includes(actor.model.id))return fail('MAGPIE_ACCOUNT_MODEL_UNSUPPORTED');
 }
 const sources=snapshot.accounts.filter(a=>magpie.has(a.authRef)).map(account=>{
  const source=catalog.find(s=>s.authRef===account.authRef);
  if(!source||source.accountRef!==account.accountRef||source.provider!==account.provider||source.authentication!==account.authentication)return fail('MAGPIE_ACCOUNT_SOURCE_REQUIRED');return{...source};
 });
 if(!sources.length||sources.length>8)return fail('MAGPIE_ACCOUNT_SOURCE_REQUIRED');
 const ticket=Object.freeze(Object.create(null)) as MagpieAccountCustody,abort=()=>revokeMagpieAccountCustody(ticket);
 const timer=setTimeout(abort,maxAge);timer.unref();
 pending.set(ticket,{bridgeBinaryHash,binding:bound,snapshot,sources,getSecret:input.getSecret,assertCurrent:input.assertCurrent,expiresAt:performance.now()+maxAge,timer,signal:input.signal,abort});
 input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();return ticket;
}
/** One attempt only, including failures. The owned launcher must pin its binary before
 * consuming, then send values only through its inherited pipe and clear its copies. */
export function consumeMagpieAccountCustody(ticket:MagpieAccountCustody,expected:MagpieCustodyBinding,verifiedBinaryHash?:string):CustodiedMagpieAccount[] {
 if(!ticket||typeof ticket!=='object'||!magpieAccountCustodyPending(ticket))return fail();const state=pending.get(ticket)!;revokeMagpieAccountCustody(ticket);
 const current=()=>{try{if(state.signal?.aborted||performance.now()>=state.expiresAt||hash(binding(state.assertCurrent()))!==hash(state.binding))return fail('MAGPIE_ACCOUNT_CUSTODY_STALE');}catch{return fail('MAGPIE_ACCOUNT_CUSTODY_STALE');}};
 if(hash(binding(expected))!==hash(state.binding))return fail('MAGPIE_ACCOUNT_CUSTODY_STALE');current();
 if(state.bridgeBinaryHash!==undefined&&verifiedBinaryHash!==state.bridgeBinaryHash)return fail('MAGPIE_ACCOUNT_CUSTODY_STALE');
 const result:CustodiedMagpieAccount[]=[];
 try{
  for(const source of state.sources){
   let value:unknown;try{value=state.getSecret(source.secretEnv);}catch{return fail('MAGPIE_ACCOUNT_SOURCE_UNAVAILABLE');}
   if(typeof value!=='string'||!/^[\x21-\x7e]{8,512}$/.test(value))return fail('MAGPIE_ACCOUNT_SECRET_INVALID');
   if(result.some(a=>a.key===value))return fail('MAGPIE_ACCOUNT_DUPLICATE_SOURCE');
   result.push({provider:source.provider,authRef:source.authRef,accountRef:source.accountRef,key:value,...(source.capabilities?{capabilities:structuredClone(source.capabilities)}:{}),...(source.model?{model:source.model}:{}),...(source.models?{models:[...source.models]}:{}),...(source.endpoint?{endpoint:{...source.endpoint}}:{})});
  }
  current();if(withExplicitSecretInspection(result.map(a=>a.key),()=>hasSecret(JSON.stringify({binding:state.binding,snapshot:state.snapshot,capabilities:state.sources.map(s=>s.capabilities)}))))return fail('MAGPIE_ACCOUNT_SECRET_IN_METADATA');
  return result;
 }catch(error){for(const account of result)account.key='';throw error;}
}
