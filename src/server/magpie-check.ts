import type {Store} from './store.js';
import type {MagpieCheckView} from '../shared/magpie-check.js';
import {DomainError,object} from './security.js';
import {accountChecksUncertain} from './magpie-account-check-state.js';
// Controller-only in-memory ownership, never a caller-supplied proof or persisted approval.
const activeChecks=new WeakMap<Store,string>();
const recoveredControllers=new WeakSet<Store>();
export function requireMagpieControllerReopen(store:Store):void{recoveredControllers.add(store);}
export function magpieControllerReopenRequired(store:Store):boolean{return recoveredControllers.has(store);}
const empty=(status:MagpieCheckView['status']='NOT_RUN'):MagpieCheckView=>({schema:'dream-maker.magpie-local-check.v1',status,checkedAt:null,reason:null,processClosed:null,accountVerified:false,modelVerified:false,customExecutionGranted:false});
/** A missing result after an Intent is uncertain, including after restart. Never show an older PASS. */
export function latestMagpieCheck(store:Store):MagpieCheckView {
 const intent=store.db.prepare("SELECT data,at FROM records WHERE kind='MagpieIngressCheckIntent' AND project_id IS NULL AND run_id IS NULL ORDER BY rowid DESC LIMIT 1").get();
 if(!intent)return empty();
 const operationHash=object(JSON.parse(String(intent.data))).operationHash;
 const result=store.db.prepare("SELECT data FROM records WHERE kind='MagpieIngressCheckResult' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.operationHash')=? ORDER BY rowid DESC LIMIT 1").get(String(operationHash));
 if(!result)return{...empty('UNCERTAIN'),checkedAt:String(intent.at),reason:'CLEANUP_UNCERTAIN',processClosed:false};
 return object(JSON.parse(String(result.data))).view as unknown as MagpieCheckView;
}
export function magpieBlocksNative(store:Store,allowCurrentLocalCheck=false):boolean{
 if(recoveredControllers.has(store))return true;
 if(activeChecks.has(store))return !allowCurrentLocalCheck;
 return latestMagpieCheck(store).status==='UNCERTAIN'||accountChecksUncertain(store);
}
/** One existing controller lock for empty checks and explicit-account checks alike. */
export async function withMagpieLocalCheck<T>(store:Store,operationHash:string,operation:()=>Promise<T>):Promise<T>{
 if(magpieBlocksNative(store))throw new DomainError('MAGPIE_CHECK_RECOVERY_REQUIRED',409);
 activeChecks.set(store,operationHash);try{return await operation();}finally{activeChecks.delete(store);}
}
/** Recovery only reads OS state; uncertainty blocks launches, not this inspection. */
export async function withMagpieLocalRecovery<T>(store:Store,targetHash:string,operation:()=>Promise<T>):Promise<T>{
 if(activeChecks.has(store))throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_BUSY',409);
 activeChecks.set(store,targetHash);try{return await operation();}finally{activeChecks.delete(store);}
}
export async function checkMagpieLocally(store:Store,operationHash:string,actor:string,signal:AbortSignal,inspect:((signal:AbortSignal)=>Promise<unknown>)|undefined):Promise<MagpieCheckView>{
 if(signal.aborted)throw new DomainError('APPLICATION_STOPPING',409);
 return withMagpieLocalCheck(store,operationHash,async()=>{
 store.record('MagpieIngressCheckIntent',null,null,{operationHash,actor,purpose:'EMPTY_ACCOUNT_LOCAL_PROCESS_ONLY'});
 let view:MagpieCheckView,privateObservation:Record<string,unknown>|null=null;
 try{
  if(!inspect)throw new DomainError('MAGPIE_CANDIDATE_BINDING_REQUIRED',409);
  const observation=object(await inspect(signal));
  if(observation.scope!=='LOCAL_CONTROL_PROCESS_ONLY'||observation.qualification!=='NOT_VERIFIED'||observation.accountCount!==0||observation.credentialsAccepted!==false||observation.realCredentialsPermitted!==false||!Array.isArray(observation.accounts)||observation.accounts.length)throw new DomainError('MAGPIE_CHECK_OBSERVATION_INVALID',502);
  privateObservation=Object.fromEntries(['scope','qualification','pid','address','epoch','binaryHash','runtimeDirectory','accountCount','credentialsAccepted','realCredentialsPermitted'].filter(k=>Object.hasOwn(observation,k)).map(k=>[k,observation[k]]));
  view={...empty('PASSED'),checkedAt:new Date().toISOString(),processClosed:true};
 }catch(error){
  const code=error instanceof DomainError?error.code:'';
  const uncertain=['PROCESS_CLEANUP_UNPROVEN','NATIVE_OWNER_CLEANUP_UNCERTAIN','APPLICATION_CLOSE_UNCERTAIN'].includes(code);
  view={...empty(uncertain?'UNCERTAIN':'FAILED'),checkedAt:new Date().toISOString(),processClosed:uncertain?false:null,reason:uncertain?'CLEANUP_UNCERTAIN':code==='MAGPIE_CANDIDATE_BINDING_REQUIRED'?'COMPONENT_NOT_BOUND':code==='NATIVE_OWNER_BUSY_OR_CLOSED'?'BUSY':'CHECK_FAILED'};
 }
 // Controller-only lifecycle evidence. The read endpoint returns the narrow view above.
 store.record('MagpieIngressCheckResult',null,null,{operationHash,view,observation:privateObservation});return view;
 });
}
