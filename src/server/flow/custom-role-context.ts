import {resolve} from 'node:path';
import type {AgentInput,Config} from '../../shared/types.js';
import type {Store} from '../store.js';
import type {ProcessOwnershipScope} from './process-ownership.js';
import {DomainError,hash} from '../security.js';
import {boundExecutorAssignment,executorRoleForTurn} from './executor-slices.js';
import {customDispatchConfiguration,type CustomDispatchIdentity} from './custom-budget.js';
import {customRoleConfiguration} from './custom-role-identity.js';

/** Actual original run/dispatch identity before credentials or wire bytes exist.
 * Shared by NativeOwner custody and the inner model request; never a browser proof. */
export function customRoleRequestContext(store:Store,config:Config,input:AgentInput,ownership:ProcessOwnershipScope|undefined){
 const stale=():never=>{throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);};
 try{
  const identity=store.tx(()=>{
   if(!ownership||ownership.store!==store||ownership.mode!=='live'||ownership.runId!==input.runId||input.signal.aborted||!['planner2','executor','reviewer'].includes(input.role))return stale();
   const run=store.run(input.runId),flow=run.flowConfig,role=input.role as 'planner2'|'executor'|'reviewer';
   if(run.flowName!=='custom'||flow?.mode!=='custom'||ownership.projectId!==run.projectId||input.specHash!==run.specHash||input.laya.adoption!=='off'||input.laya.mode!=='off'||flow.laya.enabled||flow.privacy.deniedDataLabels.length)return stale();
   const assignment=input.executorSliceId?boundExecutorAssignment(store,run.id,input.executorSliceId):undefined;
   if(role!=='executor'&&(input.taskId!==undefined||input.repairRound!==undefined||input.executorSliceId!==undefined||input.executorRoleId!==undefined))return stale();
   const roleId=role==='executor'?executorRoleForTurn(run,assignment):role,rawRole=role==='executor'?flow.roles.executors.find(r=>r.id===roleId):flow.roles[role];
   if(!rawRole||role==='executor'&&input.executorRoleId!==roleId||assignment&&assignment.taskId!==input.taskId||resolve(assignment?.workspace??run.workspace)!==resolve(input.workspace))return stale();
   const selected=customRoleConfiguration(flow,role,role==='executor'?roleId:undefined);
   if(input.model!==selected.model.id)return stale();
   let work:CustomDispatchIdentity['work']={kind:'SUPERVISION'};
   if(role==='executor'){
    if(run.phase==='REPAIRING'){
     if(input.taskId!==undefined||input.executorSliceId!==undefined||input.repairRound!==run.repairCount||!run.reason||run.failedFingerprints.at(-1)!==hash(run.reason))return stale();
     work={kind:'REPAIR',round:run.repairCount,inputHash:hash({round:run.repairCount,attempt:run.attempt,reason:run.reason,findings:run.findings,failedFingerprints:run.failedFingerprints,verification:run.verification,review:run.review})};
    }else{if(input.repairRound!==undefined||typeof input.taskId!=='string')return stale();work={kind:'TASK',taskIdHash:hash(input.taskId),executorSliceId:input.executorSliceId??null};}
   }
   return{projectId:run.projectId,runId:run.id,engineeringMode:'custom' as const,configurationHash:run.flowConfigHash!,planVersionHash:run.planVersionHash!,specHash:run.specHash,dispatchId:ownership.dispatchId,generation:ownership.generation,role,roleId,work};
  });
  // This reader rechecks all mutable original authority in its own transaction.
  const {snapshot,role}=customDispatchConfiguration(store,config,identity);
  if(snapshot.privacy.deniedProviders.includes(role.provider))return stale();
  return{identity,snapshot,role,identityHash:hash(identity)};
 }catch{return stale();}
}
