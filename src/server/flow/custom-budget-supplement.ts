import type {Run} from '../../shared/types.js';
import type {ProfileBudget} from '../../shared/flow-profile.js';
import type {CustomFlowConfigSnapshot} from '../../shared/flow-configuration.js';
import type {NativeRequestBinding} from '../../shared/native-request.js';
import type {RequestRecord} from '../native-budget.js';
import type {CustomRequestBudget} from './custom-budget.js';
import type {Store} from '../store.js';
import {DomainError,hash,now,object} from '../security.js';

type RoleBudget={roleId:string;budget:ProfileBudget};
type Limits={flow:ProfileBudget;roles:RoleBudget[]};
type Reference={recordId:string;sha256:string};
interface Approval extends Limits {
 schema:'dream-maker.custom-budget-supplement.v1';runId:string;projectId:string;
 configurationHash:string;specHash:string;planVersionHash:string;baseHash:string;
 revision:number;parent:Reference|null;actorHash:string;operationHash:string;requestHash:string;
 approvedAtVersion:number;sourceHashAtApproval:string|null;at:string;confirmed:true;modelDispatched:false;
}
const fail=(code='CUSTOM_BUDGET_SUPPLEMENT_INVALID'):never=>{throw new DomainError(code,409);};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function exact(raw:unknown,keys:string[]){
 const v=object(raw),d=Object.getOwnPropertyDescriptors(v);
 if(Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))return fail();
 return v;
}
function cap(raw:unknown):ProfileBudget {
 const v=exact(raw,['currency','maxMicros']);
 if(!['CNY','USD'].includes(String(v.currency))||!Number.isSafeInteger(v.maxMicros)||Number(v.maxMicros)<0||Number(v.maxMicros)>1e12)return fail();
 return{currency:v.currency as 'CNY'|'USD',maxMicros:Number(v.maxMicros)};
}
function baseLimits(run:Run):Limits{
 const f=run.flowConfig;
 if(run.mode!=='live'||run.flowName!=='custom'||f?.mode!=='custom'||!sha(run.flowConfigHash)||!sha(run.planVersionHash))return fail('CUSTOM_BUDGET_SUPPLEMENT_BINDING_INVALID');
 return{flow:cap(f.budget),roles:[f.roles.planner2,...f.roles.executors,f.roles.reviewer]
  .map(r=>({roleId:r.id,budget:cap(r.budget)})).sort((a,b)=>a.roleId<b.roleId?-1:a.roleId>b.roleId?1:0)};
}
function limits(raw:unknown,base:Limits):Limits{
 const v=exact(raw,['flow','roles']),flow=cap(v.flow);
 if(!Array.isArray(v.roles)||v.roles.length!==base.roles.length||flow.currency!==base.flow.currency)return fail();
 const roles=v.roles.map(raw=>{const r=exact(raw,['roleId','budget']);return{roleId:String(r.roleId),budget:cap(r.budget)};})
  .sort((a,b)=>a.roleId<b.roleId?-1:a.roleId>b.roleId?1:0);
 if(roles.some((r,i)=>r.roleId!==base.roles[i].roleId||r.budget.currency!==flow.currency||r.budget.maxMicros>flow.maxMicros))return fail();
 return{flow,roles};
}
function increasing(prior:Limits,next:Limits){
 const before=[prior.flow,...prior.roles.map(r=>r.budget)],after=[next.flow,...next.roles.map(r=>r.budget)];
 if(after.some((c,i)=>c.currency!==before[i].currency||c.maxMicros<before[i].maxMicros)||!after.some((c,i)=>c.maxMicros>before[i].maxMicros))return fail('CUSTOM_BUDGET_SUPPLEMENT_NOT_INCREASE');
}
export interface RequestBudgetSupplement {revision:number;approvalHash:string;flow:ProfileBudget;role:ProfileBudget}
export function requestBudgetSupplement(raw:unknown,flow:ProfileBudget,role:ProfileBudget):RequestBudgetSupplement{
 const s=exact(raw,['revision','approvalHash','flow','role']),sf=cap(s.flow),sr=cap(s.role);
 if(!Number.isSafeInteger(s.revision)||Number(s.revision)<1||Number(s.revision)>32||!sha(s.approvalHash)||
  sf.currency!==flow.currency||sr.currency!==role.currency||sf.maxMicros<flow.maxMicros||sr.maxMicros<role.maxMicros||sr.maxMicros>sf.maxMicros)return fail();
 return{revision:Number(s.revision),approvalHash:String(s.approvalHash),flow:sf,role:sr};
}
/** Validate every additive receipt against the original frozen configuration. No new balance. */
function evidence(store:Store,run:Run){
 const base=baseLimits(run),rows=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id=? AND kind='CustomBudgetSupplementApproval' ORDER BY rowid LIMIT 33").all(run.projectId,run.id);
 let current=base,parent:Reference|null=null;
 const approvals:Approval[]=[];
 if(rows.length>32)return fail();
 for(const row of rows){
  const a=JSON.parse(String(row.data)) as Approval;
  const next=limits({flow:a.flow,roles:a.roles},base);
  const expected:Approval={schema:'dream-maker.custom-budget-supplement.v1',runId:run.id,projectId:run.projectId,
   configurationHash:run.flowConfigHash!,specHash:run.specHash,planVersionHash:run.planVersionHash!,baseHash:hash(base),
   revision:approvals.length+1,parent,actorHash:a.actorHash,operationHash:a.operationHash,requestHash:a.requestHash,
   approvedAtVersion:a.approvedAtVersion,sourceHashAtApproval:a.sourceHashAtApproval,at:a.at,confirmed:true,modelDispatched:false,...next};
  if(hash(a)!==hash(expected)||![a.actorHash,a.operationHash,a.requestHash].every(sha)||
   !Number.isSafeInteger(a.approvedAtVersion)||a.approvedAtVersion<1||a.approvedAtVersion>=run.version||
   a.sourceHashAtApproval!==null&&!sha(a.sourceHashAtApproval)||!Number.isFinite(Date.parse(a.at))||Date.parse(a.at)<Date.parse(run.createdAt))return fail();
  increasing(current,next);current=next;parent={recordId:String(row.id),sha256:hash(a)};approvals.push(a);
 }
 if(hash(run.customBudgetSupplement??null)!==hash(parent))return fail();
 return{base,current,parent,approvals};
}
export function customBudgetSupplementPreview(store:Store,run:Run){
 const e=evidence(store,run);
 return{runId:run.id,expectedVersion:run.version,revision:e.approvals.length,approvalHash:e.parent?.sha256??null,
  base:e.base,...e.current,modelDispatched:false as const};
}
/** Only called by the original Engine, inside its transaction and current-workspace gates. */
export function saveCustomBudgetSupplement(store:Store,run:Run,raw:unknown,actor:string,operationHash:string){
 if(!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('CUSTOM_BUDGET_SUPPLEMENT_CONFIRMATION_REQUIRED',403);
 const q=exact(raw,['confirmed','expectedVersion','expectedRevision','flow','roles']);
 if(q.confirmed!==true)throw new DomainError('CUSTOM_BUDGET_SUPPLEMENT_CONFIRMATION_REQUIRED',403);
 if(!sha(operationHash)||!Number.isSafeInteger(q.expectedVersion)||Number(q.expectedVersion)<1||!Number.isSafeInteger(q.expectedRevision)||Number(q.expectedRevision)<0)return fail();
 const e=evidence(store,run),requestHash=hash(q),old=e.approvals.find(a=>a.operationHash===operationHash);
 if(old){if(old.requestHash!==requestHash||old.actorHash!==hash(actor))return fail('CUSTOM_BUDGET_SUPPLEMENT_OPERATION_CONFLICT');return customBudgetSupplementPreview(store,run);}
 if(q.expectedVersion!==run.version||q.expectedRevision!==e.approvals.length)return fail('CUSTOM_BUDGET_SUPPLEMENT_CHANGED');
 if(e.approvals.length>=32)return fail('CUSTOM_BUDGET_SUPPLEMENT_LIMIT');
 const next=limits({flow:q.flow,roles:q.roles},e.base);increasing(e.current,next);
 const a:Approval={schema:'dream-maker.custom-budget-supplement.v1',runId:run.id,projectId:run.projectId,
  configurationHash:run.flowConfigHash!,specHash:run.specHash,planVersionHash:run.planVersionHash!,baseHash:hash(e.base),
  revision:e.approvals.length+1,parent:e.parent,actorHash:hash(actor),operationHash,requestHash,
  approvedAtVersion:run.version,sourceHashAtApproval:run.treeHash,at:now(),confirmed:true,modelDispatched:false,...next};
 const recordId=store.record('CustomBudgetSupplementApproval',run.projectId,run.id,a);
 run.customBudgetSupplement={recordId,sha256:hash(a)};store.saveRun(run);
 const result=customBudgetSupplementPreview(store,run);
 store.event(run.projectId,run.id,'run.custom-budget-supplement.approved',result);return result;
}
export function customBudgetSupplementForRole(store:Store,run:Run,roleId:string){
 const e=evidence(store,run);if(!e.parent)return undefined;
 const role=e.current.roles.find(r=>r.roleId===roleId);if(!role)return fail();
 return{revision:e.approvals.length,approvalHash:e.parent.sha256,flow:e.current.flow,role:role.budget};
}
/** A renewed role probe keeps its original prepared configuration and all same-run costs. */
export function customProbeBudgetSupplement(store:Store,snapshot:CustomFlowConfigSnapshot,roleId:string){
 if(!store.db.prepare('SELECT 1 FROM runs WHERE id=?').get(snapshot.runId))return undefined;
 const run=store.run(snapshot.runId);
 if(run.projectId!==snapshot.projectId||run.flowConfigHash!==hash(snapshot))return fail('CUSTOM_BUDGET_SUPPLEMENT_BINDING_INVALID');
 return customBudgetSupplementForRole(store,run,roleId);
}
/** Re-read approval authority at the original ledger's reserve, grant and ACK boundaries. */
export function assertCustomBudgetSupplementHistory(store:Store,binding:NativeRequestBinding,limits:CustomRequestBudget,rows:RequestRecord[]):void{
 store.tx(()=>{
  const prior=rows.filter(r=>r.binding?.runId===binding.runId);
  if(!store.db.prepare('SELECT 1 FROM runs WHERE id=?').get(binding.runId)){
   if(limits.supplement||prior.some(r=>r.customBudget?.supplement))return fail('CUSTOM_BUDGET_CONTEXT_STALE');return;
  }
  const run=store.run(binding.runId),e=evidence(store,run),selected=e.base.roles.find(r=>r.roleId===binding.roleId),current=e.current.roles.find(r=>r.roleId===binding.roleId);
  if(run.projectId!==binding.projectId||run.flowConfigHash!==binding.configurationHash||run.planVersionHash!==binding.planVersionHash||run.specHash!==binding.specHash||
   !selected||!current||hash(limits.flow)!==hash(e.base.flow)||hash(limits.role)!==hash(selected.budget))return fail('CUSTOM_BUDGET_CONTEXT_STALE');
  const expected=e.parent?{revision:e.approvals.length,approvalHash:e.parent.sha256,flow:e.current.flow,role:current.budget}:null;
  if(hash(limits.supplement??null)!==hash(expected))return fail('CUSTOM_BUDGET_CONTEXT_STALE');
  for(const row of prior){
   const baseRole=e.base.roles.find(r=>r.roleId===row.binding?.roleId),c=row.customBudget;
   if(!baseRole||row.binding?.configurationHash!==binding.configurationHash||!c||hash(c.flow)!==hash(e.base.flow)||hash(c.role)!==hash(baseRole.budget))return fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
   if(!c.supplement)continue;
   const a=e.approvals[c.supplement.revision-1],role=a?.roles.find(r=>r.roleId===row.binding?.roleId);
   if(!a||!role||hash(c.supplement)!==hash({revision:a.revision,approvalHash:hash(a),flow:a.flow,role:role.budget}))return fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
  }
 });
}
