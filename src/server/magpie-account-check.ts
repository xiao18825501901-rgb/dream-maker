import type {Store} from './store.js';import type {Config} from '../shared/types.js';
import type {InspectCustomAccountSources} from '../shared/custom-account-sources.js';
import type {MagpieAccountCheckView,MagpieAccountControlObservation} from '../shared/magpie-account-check.js';
import {CustomFlowPreparations} from './custom-flow-preparation.js';import {withMagpieLocalCheck} from './magpie-check.js';
import {accountCheckSelection,accountCheckBinding,accountCheckOperation,beginAccountCheck,beginAccountCheckOwnership,finishAccountCheck,latestAccountCheck} from './magpie-account-check-state.js';
import {withProcessOwnership} from './flow/process-ownership.js';
import type {MagpieCustodyBinding} from './magpie-account-custody.js';
import {DomainError,hash,now,withExplicitSecretInspection} from './security.js';import {cleanupUncertain} from './cleanup-uncertainty.js';
function observation(raw:unknown,projectId:string,flowConfigHash:string,accountVerified:boolean):MagpieAccountControlObservation {
 const fail=():never=>{throw new DomainError('MAGPIE_ACCOUNT_CHECK_OBSERVATION_INVALID',502);};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const d=Object.getOwnPropertyDescriptors(raw),keys=['schema','projectId','flowConfigHash','sourceBindingHash','accountCount','processClosed','accountVerified','modelVerified','customExecutionGranted'];
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))return fail();const v=Object.fromEntries(keys.map(k=>[k,d[k].value]));
 if(v.schema!=='dream-maker.magpie-account-control-observation.v1'||v.projectId!==projectId||v.flowConfigHash!==flowConfigHash||typeof v.sourceBindingHash!=='string'||!/^[a-f0-9]{64}$/.test(v.sourceBindingHash)||!Number.isSafeInteger(v.accountCount)||Number(v.accountCount)<1||Number(v.accountCount)>8||v.processClosed!==true||v.accountVerified!==accountVerified||v.modelVerified!==false||v.customExecutionGranted!==false)return fail();return v as unknown as MagpieAccountControlObservation;
}
/** A journaled local controller operation using the original Store and shared native lock.
 * No model, role queue, plan approval, budget grant or account qualification is created. */
export class MagpieAccountChecks {
 /** Probe evidence for the exact accounts this check covers; a missing provider is never a promotion. */
 private deriveAccountVerified(input:InspectCustomAccountSources):boolean{try{return this.verified?.(structuredClone(input))===true;}catch{return false;}}
 constructor(private store:Store,private config:()=>Config,private describe:(input:InspectCustomAccountSources)=>MagpieCustodyBinding,private verified?:(input:InspectCustomAccountSources)=>boolean){}
 latest(projectId:string):MagpieAccountCheckView{return latestAccountCheck(this.store,projectId);}
 read(raw:InspectCustomAccountSources,operationHash:string,actor:string):MagpieAccountCheckView {
  const selected=accountCheckSelection(raw),saved=accountCheckOperation(this.store,operationHash);if(!saved)throw new DomainError('MAGPIE_ACCOUNT_CHECK_INTEGRITY',409);
  if(saved.intent.actor!==actor||saved.intent.requestHash!==hash(selected))throw new DomainError('IDEMPOTENCY_KEY_REUSED',409);return saved.view;
 }
 async check(raw:InspectCustomAccountSources,operationHash:string,actor:string,signal:AbortSignal,inspect?:((input:InspectCustomAccountSources,signal:AbortSignal,binding:MagpieCustodyBinding)=>Promise<unknown>)):Promise<MagpieAccountCheckView>{
  const selected=accountCheckSelection(raw),old=accountCheckOperation(this.store,operationHash);
  if(old){if(old.intent.actor!==actor||old.intent.requestHash!==hash(selected))throw new DomainError('IDEMPOTENCY_KEY_REUSED',409);return old.view;}
  if(signal.aborted)throw new DomainError('APPLICATION_STOPPING',409);
  return withMagpieLocalCheck(this.store,operationHash,async()=>{
   const preparations=new CustomFlowPreparations(this.store,this.config),current=()=>withExplicitSecretInspection([],()=>preparations.prepare(selected.projectId,selected.specHash,selected.profileHash,selected.preparation)),prepared=current();
   if(typeof this.describe!=='function')throw new DomainError('MAGPIE_ACCOUNT_CHECK_SOURCE_BINDING_REQUIRED',409);
   const bound=accountCheckBinding(this.describe(structuredClone(selected)));if(bound.flowConfigHash!==prepared.flowConfigHash)throw new DomainError('FLOW_PREPARATION_STALE',409);
   const intent=beginAccountCheck(this.store,selected,bound,actor,operationHash);
   const accountVerified=this.deriveAccountVerified(selected);
   const base:MagpieAccountCheckView={schema:'dream-maker.magpie-account-check.v1',projectId:selected.projectId,scope:'REGISTERED_MEMORY_TRANSFER_ONLY',historical:true,status:'FAILED',selection:structuredClone(selected),flowConfigHash:prepared.flowConfigHash,sourceBindingHash:null,checkedAt:now(),accountCount:null,processClosed:null,reason:'CHECK_FAILED',accountVerified,modelVerified:false,customExecutionGranted:false};
   let view:MagpieAccountCheckView,observed:MagpieAccountControlObservation|undefined;
   try{
    if(!inspect)throw new DomainError('MAGPIE_CANDIDATE_BINDING_REQUIRED',409);
    const ownership=beginAccountCheckOwnership(this.store,intent);
    observed=observation(await withProcessOwnership({store:this.store,projectId:selected.projectId,runId:null,dispatchId:ownership.dispatchId,generation:ownership.generation,mode:'live'},()=>inspect(structuredClone(selected),signal,{...bound})),selected.projectId,prepared.flowConfigHash,accountVerified);
    if(observed.sourceBindingHash!==bound.sourceBindingHash)throw new DomainError('MAGPIE_ACCOUNT_CHECK_OBSERVATION_INVALID',502);
    if(signal.aborted)throw new DomainError('APPLICATION_STOPPING',409);
    try{if(current().flowConfigHash!==prepared.flowConfigHash||hash(accountCheckBinding(this.describe(structuredClone(selected))))!==hash(bound))throw new DomainError('FLOW_PREPARATION_STALE',409);}catch{throw new DomainError('MAGPIE_ACCOUNT_CHECK_SELECTION_CHANGED',409);}
    view={...base,status:'PASSED',checkedAt:now(),sourceBindingHash:observed.sourceBindingHash,accountCount:observed.accountCount,processClosed:true,reason:null};
   }catch(error){
    const code=error instanceof DomainError?error.code:'',closedSelection=code==='MAGPIE_ACCOUNT_CHECK_SELECTION_CHANGED';
    // Only known prelaunch refusals or a verified closed observation are settled failures.
    const prelaunch=['MAGPIE_CANDIDATE_BINDING_REQUIRED','NATIVE_OWNER_BUSY_OR_CLOSED','NATIVE_OWNER_CLOSED','NATIVE_OWNER_STOPPING','MAGPIE_EXECUTABLE_CHANGED','MAGPIE_ACCOUNT_ROUTE_UNSUPPORTED','MAGPIE_ACCOUNT_SOURCE_REQUIRED','MAGPIE_ACCOUNT_SECRET_INVALID','MAGPIE_ACCOUNT_SOURCE_UNAVAILABLE','MAGPIE_ACCOUNT_CUSTODY_INVALID','MAGPIE_ACCOUNT_CUSTODY_STALE'].includes(code);
    const uncertain=cleanupUncertain(error)||code==='APPLICATION_CLOSE_UNCERTAIN'||code==='MAGPIE_ACCOUNT_CHECK_OBSERVATION_INVALID'||!closedSelection&&!observed&&!prelaunch;
    view=uncertain?{...base,status:'UNCERTAIN',checkedAt:now(),processClosed:false,reason:'CLEANUP_UNCERTAIN'}:{...base,checkedAt:now(),...(observed?{sourceBindingHash:observed.sourceBindingHash,accountCount:observed.accountCount,processClosed:true}:closedSelection?{processClosed:true}:{}),reason:code==='MAGPIE_CANDIDATE_BINDING_REQUIRED'?'COMPONENT_NOT_BOUND':code==='NATIVE_OWNER_BUSY_OR_CLOSED'?'BUSY':closedSelection?'SELECTION_CHANGED':'CHECK_FAILED'};
   }
   finishAccountCheck(this.store,intent,view);return view;
  });
 }
}
