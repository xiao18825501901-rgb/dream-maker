import type {Store} from './store.js';import type {Run} from '../shared/types.js';
import {DomainError,hash,object} from './security.js';import {treeHash} from './workspace.js';import {runDeadline} from './review-window.js';
export interface PartialRepairRequest{confirmed:boolean;sourceHash:string;expectedVersion:number}
export function partialRepairBasis(store:Store,run:Run,sourceHash:string){
 const fail=():never=>{throw new DomainError('PARTIAL_REPAIR_NOT_RECOVERABLE',409);};
 const rows=store.db.prepare('SELECT id,kind,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097').all(run.projectId,run.id)
  .map(r=>({id:String(r.id),kind:String(r.kind),data:object(JSON.parse(String(r.data)))}));
 const previous=rows.filter(r=>r.kind==='PartialRepairContinuation'),preparationRecovery=rows.filter(r=>r.kind==='ReviewPreparationDispatchRecovery'),
  admissionRecovery=previous.length===1,preparationAdmissionRecovery=previous.length===0&&preparationRecovery.length===1;
 if(rows.length>4096||previous.length>1||preparationRecovery.length>1||rows.some(r=>r.kind==='PartialRepairAdmissionRecovery'))return fail();
 const repairReason=JSON.stringify(run.review?.findings);
 if(run.mode!=='live'||run.flowName!=='classic'||run.state!=='BLOCKED'||run.phase!=='REPAIRING'||run.reason!=='RUNNER_RPC_ERROR'||
  !store.owns(run.projectId,run.id)||!run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||
  run.review?.source!=='CODEX'||run.review.verdict!=='CHANGES_REQUESTED'||hash(repairReason)!==run.failedFingerprints.at(-1)||
  (admissionRecovery?previous[0].data.sourceHash!==sourceHash||previous[0].data.previousSourceHash!==run.review.treeHash||run.treeHash!==sourceHash:
   preparationAdmissionRecovery?run.review.treeHash!==run.treeHash||run.treeHash!==sourceHash:run.review.treeHash!==run.treeHash)||
  run.repairCount!==run.maxRepairs||run.calls>=run.maxCalls||Date.now()>=runDeadline(store,run)||treeHash(run.workspace)!==sourceHash)return fail();
 const allIntents=rows.filter(r=>r.kind==='ToolIntent'),allResults=rows.filter(r=>r.kind==='ToolResult');
 if(allResults.length!==allIntents.length||allIntents.some(i=>{
  const settled=allResults.filter(r=>r.data.intentId===i.id);if(settled.length!==1)return true;const result=settled[0];
  const known=result.data.status==='COMPLETE'?result.data.specHash===run.specHash:
   result.data.status==='FAILED_NO_EFFECT'&&typeof result.data.code==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(result.data.code);
  return !known||result.data.tool!==i.data.tool||i.data.specHash!==run.specHash||rows.indexOf(result)<=rows.indexOf(i);
 }))return fail();
 const grants=rows.filter(r=>r.kind==='DispatchGranted');const grant=grants.at(-1);if(!grant||grant.data.kind!=='executor')return fail();
 const finishes=rows.filter(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===grant.data.dispatchId);
 if(finishes.length!==1||finishes[0].data.outcome!=='RUNNER_RPC_ERROR'||finishes[0].data.cleanupReturned!==true||finishes[0].data.generation!==grant.data.generation)return fail();
 const during=rows.slice(rows.indexOf(grant)+1,rows.indexOf(finishes[0])),processes=during.filter(r=>r.kind==='OwnedProcessIntent');
 if(!processes.length||new Set(processes.map(r=>r.data.processId)).size!==processes.length||processes.some(r=>{
  const cleanup=rows.filter(c=>c.kind==='OwnedProcessCleanup'&&c.data.processId===r.data.processId);
  return r.data.dispatchId!==grant.data.dispatchId||r.data.generation!==grant.data.generation||cleanup.length!==1||cleanup[0].data.cleanupReturned!==true||
   cleanup[0].data.dispatchId!==grant.data.dispatchId||cleanup[0].data.generation!==grant.data.generation||rows.indexOf(cleanup[0])<=rows.indexOf(r)||rows.indexOf(cleanup[0])>=rows.indexOf(finishes[0]);
 }))return fail();
 const intents=during.filter(r=>r.kind==='ToolIntent'),results=during.filter(r=>r.kind==='ToolResult');
 if(rows.slice(rows.indexOf(finishes[0])+1).some(r=>r.kind==='ToolIntent'||r.kind==='ToolResult'))return fail();
  const emptyReceipts=()=>{
   const receipts=during.filter(r=>r.kind==='NativeBudgetReceipt');
   return receipts.length>=1&&receipts.length<=3&&receipts.every(row=>{
    const requests=object(row.data.params??{}).requests;return row.data.method==='dm/budget'&&Array.isArray(requests)&&requests.length===0;
   });
  };
 if(admissionRecovery){
  if(rows.indexOf(previous[0])>=rows.indexOf(grant)||previous[0].data.schema!=='dream-maker.partial-repair-continuation.v1'||
    intents.length||results.length||during.some(r=>r.kind==='AgentSession')||!emptyReceipts())return fail();
  return {dispatchId:String(grant.data.dispatchId),sourceHash,previousSourceHash:run.treeHash,basisHash:hash(rows),toolResults:[],repairReason,admissionRecovery:true};
 }
 if(preparationAdmissionRecovery){
  const marker=preparationRecovery[0],receipts=during.filter(r=>r.kind==='NativeBudgetReceipt'),
    review=rows.filter(r=>r.kind==='Review').at(-1),
   priorGrant=rows.find(r=>r.kind==='DispatchGranted'&&r.data.dispatchId===marker.data.dispatchId),
   priorFinish=rows.find(r=>r.kind==='DispatchFinished'&&r.data.dispatchId===marker.data.dispatchId),
   afterMarker=rows.slice(rows.indexOf(marker)+1).filter(r=>r.kind==='DispatchGranted');
  if(rows.indexOf(marker)>=rows.indexOf(grant)||marker.data.schema!=='dream-maker.review-preparation-dispatch-recovery.v1'||
   marker.data.sourceHash!==run.treeHash||marker.data.specHash!==run.specHash||marker.data.planVersionHash!==run.planVersionHash||
   !review||marker.data.reviewRecordId!==review.id||marker.data.reviewHash!==hash(review.data)||
   typeof marker.data.dispatchId!=='string'||typeof marker.data.generation!=='string'||!priorGrant||!priorFinish||
   priorGrant.data.kind!=='executor'||priorGrant.data.mode!=='live'||priorGrant.data.generation!==marker.data.generation||
   priorFinish.data.generation!==marker.data.generation||priorFinish.data.outcome!=='REVIEW_PREPARATION_REPLAY_INVALID'||
   priorFinish.data.cleanupReturned!==true||marker.data.outcome!=='REVIEW_PREPARATION_REPLAY_INVALID'||
   typeof marker.data.calls!=='number'||!Number.isSafeInteger(marker.data.calls)||marker.data.calls<0||marker.data.calls>run.calls||
   marker.data.repairCount!==run.repairCount||marker.data.createdAt!==run.createdAt||marker.data.maxSeconds!==run.maxSeconds||
   marker.data.modelDispatched!==false||marker.data.automaticRetry!==false||afterMarker.length!==1||afterMarker[0]!==grant||
    intents.length||results.length||during.some(r=>r.kind==='AgentSession')||!emptyReceipts())return fail();
  return {dispatchId:String(grant.data.dispatchId),sourceHash,previousSourceHash:run.treeHash,basisHash:hash(rows),toolResults:[],repairReason,admissionRecovery:true};
 }
 const allowed=new Set(['desk_read','desk_list','desk_search','desk_write','desk_edit','desk_run']);
 if(!intents.length||results.length!==intents.length||intents.some(i=>{
  const matches=results.filter(r=>r.data.intentId===i.id);return !allowed.has(String(i.data.tool))||i.data.specHash!==run.specHash||matches.length!==1||
   !['COMPLETE','FAILED_NO_EFFECT'].includes(String(matches[0].data.status))||matches[0].data.tool!==i.data.tool||during.indexOf(matches[0])<=during.indexOf(i);
 })||rows.slice(rows.indexOf(finishes[0])+1).some(r=>r.kind==='ToolIntent'||r.kind==='ToolResult')||results.at(-1)?.data.status!=='COMPLETE'||results.at(-1)?.data.sourceHash!==sourceHash)return fail();
 return {dispatchId:String(grant.data.dispatchId),sourceHash,previousSourceHash:run.treeHash,basisHash:hash(rows),toolResults:results.map(r=>r.id),repairReason,admissionRecovery:false};
}
