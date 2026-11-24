import type {Run} from '../shared/types.js';
import type {Store} from './store.js';
import {DomainError,hash,now,object} from './security.js';

export interface TaskDeadlineWaiverApproval{
 schema:'dream-maker.task-deadline-waiver.v1';
 scope:'OWNER_PROJECT_TASK_DEADLINES_DISABLED';
 runId:string;projectId:string;specHash:string;planVersionHash:string;flowConfigHash:string;flowName:'classic'|'custom';
 sourceHashAtApproval:string|null;originalCreatedAt:string;originalMaxSeconds:number;
 calls:number;maxCalls:number;repairCount:number;maxRepairs:number;
 at:string;taskDeadline:null;technicalTimeoutsPreserved:true;actorHash:string;confirmed:true;modelDispatched:false;
}

const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const invalid=():never=>{throw new DomainError('TASK_DEADLINE_WAIVER_INVALID',409);};

/** Called inside the original Engine transaction, before any model dispatch. */
export function saveTaskDeadlineWaiver(store:Store,run:Run,actor:string):Run{
 if(!/^local-session:[a-f0-9]{64}$/.test(actor))throw new DomainError('TASK_DEADLINE_WAIVER_CONFIRMATION_REQUIRED',403);
 if(run.taskDeadlineWaiver!==undefined)throw new DomainError('TASK_DEADLINE_WAIVER_ALREADY_PRESENT',409);
 if(run.mode!=='live'||(run.flowName!=='classic'&&run.flowName!=='custom')||run.flowConfig?.mode!==run.flowName||
  !run.planVersionHash||!run.flowConfigHash)throw new DomainError('TASK_DEADLINE_WAIVER_BINDING_INVALID',409);
 const approval:TaskDeadlineWaiverApproval={
  schema:'dream-maker.task-deadline-waiver.v1',scope:'OWNER_PROJECT_TASK_DEADLINES_DISABLED',
  runId:run.id,projectId:run.projectId,specHash:run.specHash,
  planVersionHash:run.planVersionHash,flowConfigHash:run.flowConfigHash,flowName:run.flowName,
  sourceHashAtApproval:run.treeHash,originalCreatedAt:run.createdAt,originalMaxSeconds:run.maxSeconds,
  calls:run.calls,maxCalls:run.maxCalls,repairCount:run.repairCount,maxRepairs:run.maxRepairs,
  at:now(),taskDeadline:null,technicalTimeoutsPreserved:true,actorHash:hash(actor),confirmed:true,modelDispatched:false,
 };
 const recordId=store.record('TaskDeadlineWaiverApproval',run.projectId,run.id,approval);
 run.taskDeadlineWaiver={recordId,sha256:hash(approval)};
 taskDeadlineWaiverEvidence(store,run);
 store.saveRun(run);
 store.event(run.projectId,run.id,'run.task-deadline-waiver.approved',{
  ...run.taskDeadlineWaiver,taskDeadline:null,technicalTimeoutsPreserved:true,modelDispatched:false,
 });
 return run;
}

/** Read the single owner-created no-overall-deadline record for this run.
 * The original Run clock and every technical timeout stay untouched. */
export function taskDeadlineWaiverEvidence(store:Store,run:Run):TaskDeadlineWaiverApproval|null{
 if(run.taskDeadlineWaiver===undefined)return null;
 const ref=run.taskDeadlineWaiver;
 if(!ref||typeof ref.recordId!=='string'||!ref.recordId||!sha(ref.sha256))return invalid();
 const row=store.db.prepare("SELECT data FROM records WHERE id=? AND project_id=? AND run_id=? AND kind='TaskDeadlineWaiverApproval'")
  .get(ref.recordId,run.projectId,run.id);
 if(!row||typeof row.data!=='string')return invalid();
 let body:TaskDeadlineWaiverApproval;
 try{body=object(JSON.parse(row.data)) as unknown as TaskDeadlineWaiverApproval;}catch{return invalid();}
 const original=Date.parse(run.createdAt)+run.maxSeconds*1000,at=Date.parse(body.at),
  flowName=run.flowName==='classic'||run.flowName==='custom'?run.flowName:null,
  sourceHashAtApproval=body.sourceHashAtApproval===null?null:sha(body.sourceHashAtApproval)?body.sourceHashAtApproval:undefined;
 if(hash(body)!==ref.sha256||body.schema!=='dream-maker.task-deadline-waiver.v1'||body.scope!=='OWNER_PROJECT_TASK_DEADLINES_DISABLED'||
  run.mode!=='live'||!flowName||run.flowConfig?.mode!==flowName||body.runId!==run.id||body.projectId!==run.projectId||
  body.specHash!==run.specHash||body.planVersionHash!==run.planVersionHash||body.flowConfigHash!==run.flowConfigHash||
  body.flowName!==flowName||!sha(run.flowConfigHash)||!sha(run.planVersionHash)||sourceHashAtApproval===undefined||
  body.originalCreatedAt!==run.createdAt||body.originalMaxSeconds!==run.maxSeconds||!Number.isFinite(original)||!Number.isFinite(at)||
  at<Date.parse(run.createdAt)||body.taskDeadline!==null||body.technicalTimeoutsPreserved!==true||
  !Number.isSafeInteger(body.calls)||body.calls<0||run.calls<body.calls||run.calls>body.maxCalls||body.maxCalls!==run.maxCalls||
  !Number.isSafeInteger(body.repairCount)||body.repairCount<0||run.repairCount<body.repairCount||
  run.repairCount>body.maxRepairs||body.maxRepairs!==run.maxRepairs||!sha(body.actorHash)||
  body.confirmed!==true||body.modelDispatched!==false)return invalid();
 const rows=store.db.prepare("SELECT id FROM records WHERE project_id=? AND run_id=? AND kind='TaskDeadlineWaiverApproval' LIMIT 2")
  .all(run.projectId,run.id);
 if(rows.length!==1||rows[0].id!==ref.recordId)return invalid();
 return body;
}
