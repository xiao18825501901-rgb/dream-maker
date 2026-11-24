import type {NativeRequestBinding} from '../../shared/native-request.js';
import type {RequestRecord} from '../native-budget.js';
import type {ProfileBudget,CustomRoleProfile} from '../../shared/flow-profile.js';
import type {CustomFlowConfigSnapshot} from '../../shared/flow-configuration.js';
import {DomainError,hash,object} from '../security.js';
import type {Store} from '../store.js';
import type {Config} from '../../shared/types.js';
import {runConfigurationFingerprint} from '../flow-configuration.js';
import {nativeRequestBinding} from '../native-request-binding.js';
import {boundExecutorAssignment} from './executor-slices.js';
import {CUSTOM_ROLE_POLICY} from '../role-policy.js';
import {customProbeRequestBinding,customProbeRequestLimits} from './custom-probe-budget.js';
import {customRoleConfiguration,type ResolvedCustomRole} from './custom-role-identity.js';
import {customBudgetSupplementForRole,requestBudgetSupplement,type RequestBudgetSupplement} from './custom-budget-supplement.js';
import {assertProjectEngineAgainstStore} from '../engine-mode.js';

/** Original frozen selection, not an independent spending or dispatch authority. */
export interface CustomRequestBudget {
 schema:'dream-maker.custom-request-budget.v1';projectId:string;runId:string;
 configurationHash:string;roleId:string;flow:ProfileBudget;role:ProfileBudget;
 /** Additive owner approval from the original Store. Original frozen caps stay intact. */
 supplement?:RequestBudgetSupplement;
}
export type CustomBudgetResolver=(binding:Readonly<NativeRequestBinding>)=>CustomRequestBudget;
/** Internal dispatch identity before a model body or concrete account mapping exists. */
export type CustomDispatchIdentity=Omit<NativeRequestBinding,'schema'|'bodyHash'|'routeHash'>;
const fail=(code:string):never=>{throw new DomainError(code,409);};
/** Shared original authority reader. Caller owns the Store transaction. */
function dispatchConfiguration(store:Store,config:Config,b:CustomDispatchIdentity):{snapshot:CustomFlowConfigSnapshot;role:ResolvedCustomRole} {
 const stale=():never=>fail('CUSTOM_BUDGET_CONTEXT_STALE');
  const run=store.run(b.runId),project=store.project(b.projectId),spec=store.spec(run.specId),plan=store.planVersion(run.specId),flow=run.flowConfig;
  if(b.engineeringMode!=='custom'||run.projectId!==b.projectId||run.mode!=='live'||project.mode!=='live'||run.flowName!=='custom'||run.rolePolicy!==CUSTOM_ROLE_POLICY||flow?.mode!=='custom'||
   project.activeRunId!==run.id||project.specId!==run.specId||!store.owns(project.id,run.id)||run.state!==run.phase||
   run.configFingerprint!==runConfigurationFingerprint(run,config)||run.flowConfigHash!==b.configurationHash||run.specHash!==b.specHash||spec.stale||spec.hash!==b.specHash||
   !plan.approval||plan.id!==run.planVersionId||plan.contentHash!==run.planVersionHash||plan.contentHash!==b.planVersionHash||
   !store.approved(project.id,b.specHash,'SPEC')||!store.approved(project.id,b.specHash,'BUILD'))stale();
  const selection=flow!;
  if(selection.mode!=='custom')return stale();
  const rawRole=b.role==='executor'?selection.roles.executors.find(r=>r.id===b.roleId):selection.roles[b.role];
  if(!rawRole||rawRole.id!==b.roleId)stale();
  const role=customRoleConfiguration(selection,b.role,b.role==='executor'?b.roleId:undefined);
  if(b.role==='executor'){
   if(run.phase==='IMPLEMENTING'&&b.work.kind==='TASK'){
    const work=b.work,task=run.tasks.find(t=>hash(t.id)===work.taskIdHash&&t.status==='running');if(!task)stale();
    if(work.executorSliceId){const assignment=boundExecutorAssignment(store,run.id,work.executorSliceId);if(assignment.taskId!==task!.id||assignment.executorRoleId!==role.id)stale();}
   }else if(run.phase==='REPAIRING'&&b.work.kind==='REPAIR'){
    if(b.work.round!==run.repairCount||run.repairCount>run.maxRepairs||!run.reason||b.work.inputHash!==hash({round:run.repairCount,attempt:run.attempt,reason:run.reason,findings:run.findings,failedFingerprints:run.failedFingerprints,verification:run.verification,review:run.review}))stale();
   }else stale();
  }else if(b.work.kind!=='SUPERVISION'||run.phase!==(b.role==='planner2'?'PLANNING':'REVIEWING'))stale();
  const records=store.db.prepare("SELECT kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('DispatchGranted','DispatchFinished','DispatchReconciled') AND json_extract(data,'$.dispatchId')=?").all(b.projectId,b.runId,b.dispatchId);
  if(records.length!==1||records[0].kind!=='DispatchGranted')stale();
  const grant=JSON.parse(String(records[0].data));if(grant.mode!=='live'||grant.kind!==b.role||grant.generation!==b.generation||b.role==='executor'&&grant.executorRoleId!==b.roleId)stale();
  return{snapshot:selection,role};
}
/** Frozen running configuration; does not create a preparation, hold or qualification. */
export function customDispatchConfiguration(store:Store,config:Config,identity:CustomDispatchIdentity){
 try{return store.tx(()=>structuredClone(dispatchConfiguration(store,config,identity)));}
 catch{return fail('CUSTOM_BUDGET_CONTEXT_STALE');}
}
/** Rechecked from original Store, not the current UI selection or a caller's cap object. */
export function customFlowRequestBudget(store:Store,config:Config,raw:NativeRequestBinding):CustomRequestBudget {
 const stale=():never=>fail('CUSTOM_BUDGET_CONTEXT_STALE');
 try{return store.tx(()=>{
  const b=nativeRequestBinding(raw,raw?.role),{snapshot,role}=dispatchConfiguration(store,config,b);
   // The custom budget is only legal under a project decided to be custom. Same reader as the
   // badge, the Prework gate and the API: one decision, four readers.
   assertProjectEngineAgainstStore(store,b.projectId,'custom');
  const supplement=customBudgetSupplementForRole(store,store.run(b.runId),b.roleId);
  return customRequestBudget({schema:'dream-maker.custom-request-budget.v1',projectId:b.projectId,runId:b.runId,configurationHash:b.configurationHash,roleId:b.roleId,flow:snapshot.budget,role:role.budget,...(supplement?{supplement}:{})},b);
 });}catch{return stale();}
}
function exact(raw:unknown,keys:string[]):Record<string,unknown>{
 const v=object(raw),descriptors=Object.getOwnPropertyDescriptors(v);
 if(Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!descriptors[k]?.enumerable||!Object.hasOwn(descriptors[k],'value')))fail('CUSTOM_BUDGET_CONTEXT_INVALID');
 return v;
}
/** No aliases, credential fields, currency conversion, implicit unbounded limits or client proof. */
export function customRequestBudget(raw:unknown,binding:NativeRequestBinding):CustomRequestBudget {
 try{
  const hasSupplement=Object.hasOwn(object(raw),'supplement');
  const v=exact(raw,['schema','projectId','runId','configurationHash','roleId','flow','role',...(hasSupplement?['supplement']:[])]);
  const cap=(raw:unknown):ProfileBudget=>{const c=exact(raw,['currency','maxMicros']);
   if(!['CNY','USD'].includes(String(c.currency))||!Number.isSafeInteger(c.maxMicros)||Number(c.maxMicros)<0||Number(c.maxMicros)>1000000000000)fail('CUSTOM_BUDGET_CONTEXT_INVALID');
   return {currency:c.currency as 'CNY'|'USD',maxMicros:Number(c.maxMicros)};
  };
  const flow=cap(v.flow),role=cap(v.role);
  if(binding.engineeringMode!=='custom'||v.schema!=='dream-maker.custom-request-budget.v1'||v.projectId!==binding.projectId||v.runId!==binding.runId||v.configurationHash!==binding.configurationHash||v.roleId!==binding.roleId||flow.currency!==role.currency||role.maxMicros>flow.maxMicros)fail('CUSTOM_BUDGET_CONTEXT_INVALID');
  let supplement:CustomRequestBudget['supplement'];
  if(hasSupplement)supplement=requestBudgetSupplement(v.supplement,flow,role);
  return {schema:'dream-maker.custom-request-budget.v1',projectId:binding.projectId,runId:binding.runId,configurationHash:binding.configurationHash,roleId:binding.roleId,flow,role,...(supplement?{supplement}:{})};
 }catch{return fail('CUSTOM_BUDGET_CONTEXT_INVALID');}
}
/** Called inside the original ledger's reserve transaction. No second balance or baseline. */
export function assertCustomRequestBudget(rows:RequestRecord[],binding:NativeRequestBinding,limits:CustomRequestBudget,nextMicros:number):void {
 const {flowRemainingMicros,roleRemainingMicros}=customBudgetRemaining(rows,binding,limits);
 if(nextMicros>roleRemainingMicros)fail('CUSTOM_ROLE_BUDGET_EXCEEDED');
 if(nextMicros>flowRemainingMicros)fail('CUSTOM_FLOW_BUDGET_EXCEEDED');
}
export function customBudgetRemaining(rows:RequestRecord[],binding:Pick<NativeRequestBinding,'runId'|'projectId'|'configurationHash'|'roleId'>,limits:Pick<CustomRequestBudget,'flow'|'role'|'supplement'>){
 let flow=0n,role=0n;
 for(const row of rows){
  if(row.binding?.runId!==binding.runId)continue;
  let prior:CustomRequestBudget;
  try{
   if(row.role!==row.binding.role||row.binding.engineeringMode!=='custom'||row.binding.projectId!==binding.projectId||row.binding.configurationHash!==binding.configurationHash)fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
   prior=customRequestBudget(row.customBudget,row.binding);
   if(row.customProbe&&(hash(customProbeRequestBinding(row.customProbe,row.binding))!==hash(row.binding)||hash(customProbeRequestLimits(row.customProbe))!==hash(prior)))fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
   if(hash(prior.flow)!==hash(limits.flow)||prior.flow.currency!==row.price.currency||row.binding.roleId===binding.roleId&&hash(prior.role)!==hash(limits.role))fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
   if(prior.supplement&&(!limits.supplement||prior.supplement.revision>limits.supplement.revision||
    prior.supplement.revision===limits.supplement.revision&&prior.supplement.approvalHash!==limits.supplement.approvalHash||
    prior.supplement.flow.maxMicros>limits.supplement.flow.maxMicros||row.binding.roleId===binding.roleId&&prior.supplement.role.maxMicros>limits.supplement.role.maxMicros))fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
   if(!['PENDING','KNOWN','UNKNOWN'].includes(row.usageStatus)||!Number.isSafeInteger(row.reservedMicros)||row.reservedMicros<0||row.chargedMicros!==null&&(!Number.isSafeInteger(row.chargedMicros)||row.chargedMicros<0)||row.usageStatus==='KNOWN'&&row.chargedMicros===null)fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
  }catch{return fail('CUSTOM_BUDGET_HISTORY_MISMATCH');}
  const amount=BigInt(row.usageStatus==='KNOWN'?row.chargedMicros!:Math.max(row.reservedMicros,row.chargedMicros??0));
  flow+=amount;if(row.binding.roleId===binding.roleId)role+=amount;
 }
 return {flowRemainingMicros:Number(BigInt((limits.supplement?.flow??limits.flow).maxMicros)-flow),roleRemainingMicros:Number(BigInt((limits.supplement?.role??limits.role).maxMicros)-role)};
}
