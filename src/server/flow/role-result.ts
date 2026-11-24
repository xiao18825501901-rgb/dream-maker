import type {AgentOutput,ExecutionIdentity,Role,Run,Phase} from '../../shared/types.js';
import type {Store} from '../store.js';
import {DomainError,id} from '../security.js';
import {assertReviewSupplementCompletion} from '../review-supplement.js';
import {appendExecutorRoleIdentity} from './executor-role-evidence.js';

export type RoleTurnResult={mode:'demo'}|{mode:'live';out:AgentOutput;identity:ExecutionIdentity;executorRoleId?:string;assignment?:{taskId:string;sliceId:string}};
export interface DispatchedRoleResult {result:RoleTurnResult;dispatchId:string;generation:string;phase:Phase}

/** Publish completion only after the one Dispatch journal has accepted the result
 * and actual process cleanup. All role records commit together in the original DB. */
export function commitRoleResult(store:Store,expected:Run,role:Role,completion:DispatchedRoleResult,afterPublish?:(run:Run)=>void):void {
 store.tx(()=>{
  const run=store.run(expected.id),project=store.project(run.projectId),ref=completion;
  if(run.version!==expected.version||run.phase!==expected.phase||run.phase!==completion.phase||run.specHash!==expected.specHash||run.configFingerprint!==expected.configFingerprint||project.activeRunId!==run.id||!store.owns(run.projectId,run.id)||![run.phase,'PAUSE_REQUESTED'].includes(run.state)||completion.result.mode!==run.mode)throw new DomainError('DISPATCH_RESULT_FENCED',409);
  const rows=store.db.prepare("SELECT kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('DispatchGranted','DispatchFinished','DispatchReconciled') AND json_extract(data,'$.dispatchId')=?").all(run.projectId,run.id,ref.dispatchId);
  const grant=rows.find(r=>r.kind==='DispatchGranted'),finished=rows.find(r=>r.kind==='DispatchFinished');
  if(rows.length!==2||!grant||!finished)throw new DomainError('DISPATCH_RESULT_FENCED',409);
  const g=JSON.parse(String(grant.data)),f=JSON.parse(String(finished.data));
  if(g.kind!==role||g.mode!==run.mode||g.generation!==ref.generation||f.generation!==ref.generation||f.outcome!=='COMPLETED'||f.cleanupReturned!==true)throw new DomainError('DISPATCH_RESULT_FENCED',409);
  const result=completion.result;
  if(result.mode==='demo'){
   run.usage.push({role,inputTokens:null,outputTokens:null,costUsd:0,source:'DEMO_NO_CLOUD',requestId:id('demo')});run.sessions[role]=id('demo_session');
  }else{
   const {out,identity,executorRoleId,assignment}=result;
   if(run.reviewSupplement)assertReviewSupplementCompletion(store,run,role,out,ref);
   if(role==='executor'&&g.executorRoleId!==executorRoleId)throw new DomainError('DISPATCH_RESULT_FENCED',409);
   if(role==='executor'&&run.flowName==='custom'){
    if(!executorRoleId)throw new DomainError('DISPATCH_RESULT_FENCED',409);
    if(g.executorSliceId!==assignment?.sliceId)throw new DomainError('DISPATCH_RESULT_FENCED',409);
    appendExecutorRoleIdentity(run,{...identity,roleId:executorRoleId,sessionId:out.sessionId,requestId:out.usage.requestId,executorRoleId,...(assignment?{taskId:assignment.taskId,sliceId:assignment.sliceId}:{}),dispatchId:ref.dispatchId,generation:ref.generation});
    run.sessions.executor??=out.sessionId;
    (run.roleIdentities??={}).executor??={...identity,sessionId:out.sessionId,requestId:out.usage.requestId};
   }else{
    run.sessions[role]=out.sessionId;
    (run.roleIdentities??={})[role]={...identity,sessionId:out.sessionId,requestId:out.usage.requestId};
   }
   run.usage.push(out.usage);
   store.record('AgentSession',run.projectId,run.id,{role,sessionId:out.sessionId,...identity,...(role==='executor'?{executorRoleId}:{}),...(assignment?{taskId:assignment.taskId,sliceId:assignment.sliceId}:{}),modelEvidence:'ADAPTER_VERIFIED_RESPONSE',dispatchId:ref.dispatchId,generation:ref.generation});
   store.record('UsageLedger',run.projectId,run.id,out.usage);
  }
  store.saveRun(run);afterPublish?.(run);store.event(run.projectId,run.id,result.mode==='demo'?'role.demo.completed':'role.completed',{state:run.state,phase:run.phase,attempt:run.attempt,reason:run.reason});
 });
}
