/** Scheduling proposals only. Host Engine remains the only execution authority.
 * Logical paths and resource reservations do not provide OS sandboxing; the
 * host must resolve symlinks, aliases and actual process ownership separately. */
import { requireCondition as need, id, text, integer, oneOf, isRecord, digest } from '../research/common.mjs';

export function resourcePath(value) {
  text(value,'RESOURCE_PATH',1024);
  need(!value.startsWith('/') && !/[\\:%\x00-\x1f]/.test(value), 'UNSAFE_RESOURCE_PATH');
  const parts=value.normalize('NFC').split('/');
  need(parts.every(p=>p && p!=='.' && p!=='..' && !/[. ]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'UNSAFE_RESOURCE_PATH');
  return parts.join('/').toLocaleLowerCase('en-US');
}
const overlap=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const executorDemand=t=>Object.hasOwn(t.demand,'executorSlots')?t.demand.executorSlots:t.kind==='MODEL'?1:0;
export function checkTaskDag(tasks) {
  need(Array.isArray(tasks) && tasks.length>0 && tasks.length<=300,'INVALID_TASKS');
  const byId=new Map();
  for(const t of tasks){
    id(t.id,'TASK');id(t.projectId,'PROJECT');id(t.flowId,'FLOW');id(t.workspaceKey,'WORKSPACE');
    oneOf(t.kind,['MODEL','DETERMINISTIC'],'TASK_KIND');
    need(!byId.has(t.id),'DUPLICATE_TASK');need(Array.isArray(t.dependsOn) && new Set(t.dependsOn).size===t.dependsOn.length,'INVALID_DEPENDENCIES');
    for(const field of ['reads','writes']){need(Array.isArray(t[field]),'INVALID_FILE_SCOPE');t[field].forEach(resourcePath);}
    need(Array.isArray(t.exclusiveResources) && new Set(t.exclusiveResources).size===t.exclusiveResources.length,'INVALID_EXCLUSIVE_RESOURCES');t.exclusiveResources.forEach(x=>id(x,'RESOURCE'));
    need(isRecord(t.demand),'INVALID_DEMAND');for(const[k,v]of Object.entries(t.demand)){id(k,'RESOURCE');integer(v,'DEMAND',0,1_000_000);}
    if(t.kind==='MODEL')need((t.demand.externalModelSlots??0)+(t.demand.localModelSlots??0)>=1,'MODEL_SLOT_REQUIRED');
    byId.set(t.id,t);
  }
  const seen=new Map(),order=[];
  function visit(key){need(byId.has(key),'MISSING_DEPENDENCY');need(seen.get(key)!==1,'TASK_DEPENDENCY_CYCLE');if(seen.get(key)===2)return;seen.set(key,1);
    const t=byId.get(key);for(const d of t.dependsOn){need(byId.has(d),'MISSING_DEPENDENCY');need(byId.get(d).flowId===t.flowId && byId.get(d).projectId===t.projectId,'CROSS_FLOW_DEPENDENCY_DENIED');visit(d);}seen.set(key,2);order.push(key);}
  for(const key of byId.keys())visit(key);return{byId,order};
}
export function tasksConflict(a,b) {
  if(a.exclusiveResources.some(r=>b.exclusiveResources.includes(r)))return true;
  if(a.workspaceKey!==b.workspaceKey)return false;
  const ar=a.reads.map(resourcePath),aw=a.writes.map(resourcePath),br=b.reads.map(resourcePath),bw=b.writes.map(resourcePath);
  return aw.some(p=>[...br,...bw].some(q=>overlap(p,q)))||bw.some(p=>ar.some(q=>overlap(p,q)));
}
/** Aging/fairness counters supplied from the existing persistent Engine, not wall-clock speculation. */
export function proposeDispatch({tasks,completedIds=[],activeIds=[],capacity,reservedForSupervisors={},activeFlowByProject,userMaxExecutors=null,projectDispatchCounts={}}) {
  const {byId}=checkTaskDag(tasks);need(isRecord(capacity)&&isRecord(reservedForSupervisors)&&isRecord(activeFlowByProject),'INVALID_SCHEDULER_STATE');
  const completed=new Set(completedIds),active=new Set(activeIds);need(completed.size===completedIds.length&&active.size===activeIds.length,'DUPLICATE_SCHEDULER_STATE');
  for(const key of [...completed,...active])need(byId.has(key),'UNKNOWN_TASK_STATE');
  for(const key of completed)need(!active.has(key)&&byId.get(key).dependsOn.every(d=>completed.has(d)),'INCONSISTENT_COMPLETED_STATE');
  for(const key of active)need(byId.get(key).dependsOn.every(d=>completed.has(d)),'ACTIVE_TASK_DEPENDENCY_UNMET');
  if(userMaxExecutors!==null)integer(userMaxExecutors,'EXECUTOR_CAP',1,128);
  const remaining={};for(const[k,v]of Object.entries(capacity)){integer(v,'CAPACITY',0,1_000_000);integer(reservedForSupervisors[k]??0,'RESERVE',0,1_000_000);remaining[k]=v-(reservedForSupervisors[k]??0);need(remaining[k]>=0,'INSUFFICIENT_SUPERVISOR_RESERVE');}
  for(const k of Object.keys(reservedForSupervisors))need(Object.hasOwn(capacity,k),'UNKNOWN_RESERVED_RESOURCE');
  const chosen=[],blocked=[];const running=[...active].map(k=>byId.get(k));
  for(const task of running){need(activeFlowByProject[task.projectId]===task.flowId,'ACTIVE_FLOW_IDENTITY_MISMATCH');for(const[k,v]of Object.entries(task.demand)){need(Object.hasOwn(remaining,k),'UNKNOWN_RESOURCE');remaining[k]-=v;need(remaining[k]>=0,'ACTIVE_RESOURCE_OVERCOMMIT');}}
  for(let i=0;i<running.length;i++)for(let j=i+1;j<running.length;j++)need(!tasksConflict(running[i],running[j]),'ACTIVE_TASK_CONFLICT');
  const queue=tasks.filter(t=>!completed.has(t.id)&&!active.has(t.id));
  const counts={...projectDispatchCounts};for(const n of Object.values(counts))integer(n,'FAIRNESS_COUNT',0);
  while(queue.length){
    queue.sort((a,b)=>(counts[a.projectId]??0)-(counts[b.projectId]??0)||a.id.localeCompare(b.id));const t=queue.shift();let reason=null;
    if(activeFlowByProject[t.projectId]!==t.flowId)reason='NOT_CURRENT_ACTIVE_FLOW';
    else if(!t.dependsOn.every(x=>completed.has(x)))reason='DEPENDENCIES_PENDING';
    else if(userMaxExecutors!==null&&executorDemand(t)>0&&[...running,...chosen,t].reduce((n,x)=>n+executorDemand(x),0)>userMaxExecutors)reason='USER_CONCURRENCY_CAP';
    else if([...running,...chosen].some(other=>tasksConflict(t,other)))reason='RESOURCE_CONFLICT';
    else if(Object.entries(t.demand).some(([k,v])=>!Object.hasOwn(remaining,k)||v>remaining[k]))reason='CAPACITY_OR_ENTITLEMENT_LIMIT';
    if(reason){blocked.push({taskId:t.id,reason});continue;}
    chosen.push(t);for(const[k,v]of Object.entries(t.demand))remaining[k]-=v;counts[t.projectId]=(counts[t.projectId]??0)+1;
  }
  return{kind:'PROPOSAL_NOT_EXECUTION_PERMISSION',taskIds:chosen.map(x=>x.id),blocked,remaining,nextProjectDispatchCounts:counts,snapshotHash:digest({tasks,completedIds,activeIds,capacity,reservedForSupervisors,activeFlowByProject,userMaxExecutors,projectDispatchCounts})};
}
