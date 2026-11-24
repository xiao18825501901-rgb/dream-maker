// OFFLINE synthetic journal and real local fixture files. Never product/Native evidence.
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
import {reviewWindowFixture} from './review-window.mjs';import {captureSource} from '../../dist/server/review-packet.js';import {hash} from '../../dist/server/security.js';
export async function partialSourceCustodyFixture(t,options={}){
 const x=await reviewWindowFixture(t,{configure:options.configure}),s=x.h.store,r=s.run(x.r.id),spec=x.s,record=(kind,data)=>s.record(kind,x.p.id,r.id,data);
 const originalHash=r.treeHash,originalEvidence=JSON.parse(s.db.prepare('SELECT data FROM records WHERE id=?').get(r.verification.evidenceId).data);
 record('Review',{verdict:'CHANGES_REQUESTED',source:'CODEX',treeHash:originalHash,findings:[{id:'OFFLINE_REPAIR',description:'offline change request'}]});
 const generation='OFFLINE_ENGINE';let failed,custodyId,admissionRecoveryId,retained,resultId,intentId,partialReceiptId;
 if(options.admissionOnly){
  retained=captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'EXECUTOR_BEFORE');
  failed='OFFLINE_EMPTY_ADMISSION';const rejectedProcess='OFFLINE_REJECTED_PROCESS',emptyReceiptCount=options.emptyReceiptCount??1;
  record('DispatchGranted',{dispatchId:failed,generation,kind:'executor',mode:'live'});
  record('OwnedProcessIntent',{dispatchId:failed,generation,processId:rejectedProcess,platform:'win32'});
  for(let i=0;i<emptyReceiptCount;i++)record('NativeBudgetReceipt',{method:'dm/budget',params:{requests:[]}});
  record('OwnedProcessCleanup',{dispatchId:failed,generation,processId:rejectedProcess,cleanupReturned:true});
  record('DispatchFinished',{dispatchId:failed,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});
  admissionRecoveryId=record('PartialRepairAdmissionRecovery',{schema:'dream-maker.partial-repair-continuation.v1',dispatchId:failed,sourceHash:retained.treeHash,previousSourceHash:retained.treeHash,basisHash:'d'.repeat(64),toolResults:[],actorHash:'e'.repeat(64),
   proof:{schema:'dream-maker.dispatch-recovery.v1',dispatchId:failed,proven:true,basisSha256:'f'.repeat(64)},source:retained,calls:7,repairCount:2,maxRepairs:2,automaticRetry:false,taskCompletionAssumed:false,modelDispatched:false,admissionRecovery:true});
 }else{
  failed='OFFLINE_FAILED_EXECUTION';const processId='OFFLINE_FAILED_PROCESS';
  record('DispatchGranted',{dispatchId:failed,generation,kind:'executor',mode:'live'});
  record('OwnedProcessIntent',{dispatchId:failed,generation,processId,platform:'win32'});
  if(options.duplicateProcess)record('OwnedProcessIntent',{dispatchId:failed,generation,processId,platform:'win32'});
  intentId=record('ToolIntent',{tool:'desk_edit',specHash:r.specHash,sourceHash:originalHash,requestHash:hash('OFFLINE_EDIT')});
  writeFileSync(join(r.workspace,'main.mjs'),'// OFFLINE retained source; never executed\n');
  retained=captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'EXECUTOR_BEFORE');
  resultId=record('ToolResult',{intentId,tool:'desk_edit',specHash:r.specHash,status:'COMPLETE',sourceHash:retained.treeHash});
  partialReceiptId=record('NativeBudgetReceipt',{method:'dm/budget',params:{requests:[{id:'OFFLINE_PHYSICAL_REQUEST',observedModel:'OFFLINE_DSH',outcome:'COMPLETE',completionObserved:true,responseModelMatched:true,finishReason:'tool_use',usage:null}]}});
  record('OwnedProcessCleanup',{dispatchId:failed,generation,processId,cleanupReturned:true});
  record('DispatchFinished',{dispatchId:failed,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});
  custodyId=record('PartialRepairContinuation',{schema:'dream-maker.partial-repair-continuation.v1',dispatchId:failed,sourceHash:retained.treeHash,previousSourceHash:originalHash,basisHash:'a'.repeat(64),toolResults:[resultId],actorHash:'b'.repeat(64),
   proof:{schema:'dream-maker.dispatch-recovery.v1',dispatchId:failed,proven:true,basisSha256:'c'.repeat(64)},source:retained,calls:6,repairCount:2,maxRepairs:2,automaticRetry:false,taskCompletionAssumed:false,modelDispatched:false});
   if(options.admissionRecovery){const rejected='OFFLINE_EMPTY_ADMISSION',rejectedProcess='OFFLINE_REJECTED_PROCESS',emptyReceiptCount=options.emptyReceiptCount??1;record('DispatchGranted',{dispatchId:rejected,generation,kind:'executor',mode:'live'});record('OwnedProcessIntent',{dispatchId:rejected,generation,processId:rejectedProcess,platform:'win32'});for(let i=0;i<emptyReceiptCount;i++)record('NativeBudgetReceipt',{method:'dm/budget',params:{requests:[]}});record('OwnedProcessCleanup',{dispatchId:rejected,generation,processId:rejectedProcess,cleanupReturned:true});record('DispatchFinished',{dispatchId:rejected,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});
   admissionRecoveryId=record('PartialRepairAdmissionRecovery',{schema:'dream-maker.partial-repair-continuation.v1',dispatchId:rejected,sourceHash:retained.treeHash,previousSourceHash:retained.treeHash,basisHash:'d'.repeat(64),toolResults:[],actorHash:'e'.repeat(64),proof:{schema:'dream-maker.dispatch-recovery.v1',dispatchId:rejected,proven:true,basisSha256:'f'.repeat(64)},source:retained,calls:7,repairCount:2,maxRepairs:2,automaticRetry:false,taskCompletionAssumed:false,modelDispatched:false,admissionRecovery:true});}
 }
 const beforeId=record('SourceSnapshot',retained),adopt='OFFLINE_ADOPT_EXECUTION',adoptProcess='OFFLINE_ADOPT_PROCESS';
 record('DispatchGranted',{dispatchId:adopt,generation,kind:'executor',mode:'live'});
 record('OwnedProcessIntent',{dispatchId:adopt,generation,processId:adoptProcess,platform:'win32'});
 const readId=record('ToolIntent',{tool:'desk_read',specHash:r.specHash,sourceHash:retained.treeHash,requestHash:hash('OFFLINE_READ')});
 const adoptResultId=record('ToolResult',{intentId:readId,tool:'desk_read',specHash:r.specHash,status:'COMPLETE',sourceHash:retained.treeHash});
 record('NativeBudgetReceipt',{method:'dm/budget',params:{requests:[{id:'OFFLINE_ADOPT_REQUEST',observedModel:'OFFLINE_DSH',outcome:'COMPLETE',completionObserved:true,responseModelMatched:true,finishReason:'end_turn',usage:null}]}});
 record('OwnedProcessCleanup',{dispatchId:adopt,generation,processId:adoptProcess,cleanupReturned:true});record('DispatchFinished',{dispatchId:adopt,generation,outcome:'COMPLETED',cleanupReturned:true});
 const identity={...r.roleIdentities.executor,sessionId:'OFFLINE_ADOPTED_SESSION',requestId:'OFFLINE_ADOPT_REQUEST'};
 const sessionId=record('AgentSession',{role:'executor',...identity,modelEvidence:'ADAPTER_VERIFIED_RESPONSE',dispatchId:adopt,generation});
 const after=captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'EXECUTOR_AFTER'),afterId=record('SourceSnapshot',after);record('SourceSnapshot',captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'VERIFIER_INPUT'));
 const raw=JSON.parse(originalEvidence.stdout);raw.sourceHash=retained.treeHash;for(const c of raw.cases)c.sourceHash=retained.treeHash;
 const evidenceId=record('Evidence',{...originalEvidence,treeHash:retained.treeHash,stdout:JSON.stringify(raw)});
 r.treeHash=retained.treeHash;r.verification={ok:true,evidenceId,treeHash:r.treeHash};r.roleIdentities.executor=identity;r.sessions.executor=identity.sessionId;r.calls=9;r.repairCount=2;r.maxRepairs=2;s.saveRun(r);
 return {...x,r:s.run(r.id),custodyId,admissionRecoveryId,failedDispatchId:failed,adoptDispatchId:adopt,retainedHash:retained.treeHash,beforeId,afterId,sessionId,resultId,intentId,partialReceiptId,adoptResultId};
}
