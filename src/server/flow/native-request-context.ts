import type {AgentInput,Config} from '../../shared/types.js';
import type {NativeRequestBinding} from '../../shared/native-request.js';
import type {Store} from '../store.js';
import type {ProcessOwnershipScope} from './process-ownership.js';
import {DomainError,hash} from '../security.js';
import {runConfigurationFingerprint} from '../flow-configuration.js';
import {boundExecutorAssignment} from './executor-slices.js';
import {nativeRequestBinding} from '../native-request-binding.js';
import {resolve} from 'node:path';
import {concreteMagpieRoute,magpieRouteHash} from '../magpie-route.js';
import {customFlowRequestBudget} from './custom-budget.js';
import {customRoleRequestContext} from './custom-role-context.js';

/** Recheck the actual original Store/Dispatch before each inner HTTP request. No qualification,
 * account, model, budget or filesystem authority can be supplied in the SDK's request body. */
export function executorModelRequestBinding(store:Store,config:Config,input:AgentInput,ownership:ProcessOwnershipScope|undefined,bodyHash:string):NativeRequestBinding {
 const stale=():never=>{throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);};
 try{return store.tx(()=>{
  if(!ownership||ownership.store!==store||ownership.mode!=='live'||ownership.runId!==input.runId||input.role!=='executor'||input.signal.aborted)stale();
  const owned=ownership!,run=store.run(input.runId),project=store.project(run.projectId),spec=store.spec(run.specId),plan=store.planVersion(run.specId);
  if(owned.projectId!==run.projectId||run.mode!=='live'||project.mode!=='live'||!['IMPLEMENTING','REPAIRING'].includes(run.phase)||run.state!==run.phase||project.activeRunId!==run.id||
   project.specId!==run.specId||!store.owns(run.projectId,run.id)||run.flowName!=='classic'||run.rolePolicy!=='CODEX_DSH_V1'||!run.flowConfig||run.flowConfig.mode!=='classic'||
   run.configFingerprint!==runConfigurationFingerprint(run,config)||spec.stale||spec.hash!==input.specHash||spec.hash!==run.specHash||
   !plan.approval||plan.id!==run.planVersionId||plan.contentHash!==run.planVersionHash||!store.approved(run.projectId,run.specHash,'SPEC')||!store.approved(run.projectId,run.specHash,'BUILD'))stale();
  const flow=run.flowConfig!,executor=flow.roles.executors[0];
  if(flow.magpie!==null||flow.roles.executors.length!==1||executor?.id!=='executor-1'||executor.runtime!=='dsh'||executor.transport!=='native'||executor.provider!=='deepseek-official'||
   executor.authentication!=='API_KEY'||input.model!==executor.model)stale();
   // The frozen snapshot already carries the model this run was approved and fingerprinted on, and
   // input.model must equal it: comparing it to live config as well forbade a saved role change
   // rather than protecting anything. Config still pins the fingerprint above.
  let work:NativeRequestBinding['work'];
  if(run.phase==='REPAIRING'){
   if(input.taskId!==undefined||input.executorSliceId!==undefined||!Number.isSafeInteger(run.repairCount)||run.repairCount<1||run.repairCount>run.maxRepairs||
    input.repairRound!==run.repairCount||!run.reason||run.failedFingerprints.at(-1)!==hash(run.reason))stale();
   work={kind:'REPAIR',round:run.repairCount,inputHash:hash({round:run.repairCount,attempt:run.attempt,reason:run.reason,findings:run.findings,failedFingerprints:run.failedFingerprints,verification:run.verification,review:run.review})};
  }else{
   const task=run.tasks.find(t=>t.id===input.taskId);if(input.repairRound!==undefined||!task||task.status!=='running')stale();
   work={kind:'TASK',taskIdHash:hash(task!.id),executorSliceId:input.executorSliceId??null};
  }
  const assignment=input.executorSliceId?boundExecutorAssignment(store,run.id,input.executorSliceId):undefined;
  if(input.executorRoleId!==undefined&&input.executorRoleId!==executor.id||assignment?.executorRoleId!==undefined&&assignment.executorRoleId!==executor.id)stale();
  if(assignment&&assignment.taskId!==input.taskId||resolve(assignment?.workspace??run.workspace)!==resolve(input.workspace))stale();
  const records=store.db.prepare("SELECT kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('DispatchGranted','DispatchFinished','DispatchReconciled') AND json_extract(data,'$.dispatchId')=?").all(run.projectId,run.id,owned.dispatchId);
  if(records.length!==1||records[0].kind!=='DispatchGranted')stale();
  const grant=JSON.parse(String(records[0].data));if(grant.kind!=='executor'||grant.mode!=='live'||grant.generation!==owned.generation)stale();
  return nativeRequestBinding({schema:'dream-maker.native-request-binding.v1',projectId:run.projectId,runId:run.id,engineeringMode:'classic',configurationHash:run.flowConfigHash,
   planVersionHash:run.planVersionHash,specHash:run.specHash,dispatchId:owned.dispatchId,generation:owned.generation,role:'executor',roleId:executor.id,
   work,bodyHash,
   routeHash:hash({runtime:executor.runtime,provider:executor.provider,protocol:'anthropic-messages',model:executor.model,authentication:executor.authentication,authRef:'session-env:'+config.dsh.keyEnv,accountRef:executor.accountRef})},'executor');
 });}catch{throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);}
}

/** Frozen Custom attribution underneath the original Engine. Membership is not a
 * route-selection/retry permit: NativeOwner must also qualify the actual runtime.
 * No caller/model can supply a budget, approval, account proof or file authority. */
export function customModelRequestBinding(store:Store,config:Config,input:AgentInput,ownership:ProcessOwnershipScope|undefined,rawRoute:unknown,bodyHash:string):NativeRequestBinding {
 const stale=():never=>{throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);};
 try{
  const {identity,snapshot:flow,role:selected}=customRoleRequestContext(store,config,input,ownership),route=concreteMagpieRoute(rawRoute);
  if(input.model!==route.model||flow.privacy.deniedProviders.includes(route.provider)||selected.runtime!==route.runtime||selected.provider!==route.provider||
   selected.authentication!==route.authentication||selected.authRef!==route.authRef||selected.accountRef!==route.accountRef||selected.model.id!==route.model)return stale();
  const account=flow.accounts.find(a=>a.provider===route.provider&&a.authentication===route.authentication&&a.authRef===route.authRef&&a.accountRef===route.accountRef);
  if(!account)return stale();
  const result=nativeRequestBinding({schema:'dream-maker.native-request-binding.v1',...identity,bodyHash,routeHash:magpieRouteHash(route)},identity.role);
 // Do not nest Store transactions. This original reader rechecks every mutable
 // authority against the exact frozen binding, and reserve/grant repeat it.
 customFlowRequestBudget(store,config,result);return result;
 }catch{return stale();}
}
