// Original Engine loop and Dispatch, explicit OFFLINE role substitutes. NOT model evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {reviewSupplementFixture} from '../fixtures/review-supplement.mjs';import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {DomainError,hash} from '../../dist/server/security.js';import {reviewSupplementEvidence} from '../../dist/server/review-supplement.js';
import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
for(const outcome of ['PASS','BLOCKED','CHANGES_REQUESTED','rpc','replay','silent','wrong-packet','wrong-turn','early-event','late-event'])test('original supplemental loop executes exactly one Reviewer and stops on '+outcome,async t=>{
 const x=await reviewSupplementFixture(t),before=x.h.store.run(x.r.id),priorReviews=x.h.store.records(x.p.id,'Review').length;fixedControllerCapacity(x.h.engine);let roles=0,executors=0,repairs=0;
 x.h.engine.nativeExecution={assertReady:()=>{},verify:async()=>{throw Error('VERIFIER_NOT_EXPECTED');},executor(){executors++;throw Error('EXECUTOR_FORBIDDEN');},reserveRepair(){repairs++;},close:async()=>{},codex(){return{run:async(input,emit)=>{
  roles++;assert.equal(input.role,'reviewer');if(outcome==='rpc')throw new DomainError('RUNNER_RPC_ERROR',502);
  if(outcome==='replay'){const identity=before.roleIdentities.reviewer;return{text:'{"verdict":"PASS","findings":[]}',sessionId:identity.sessionId,model:identity.model,identity,usage:{role:'reviewer',requestId:identity.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'}};}
  const identity={runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:x.h.config.codex.model},sessionId='OFFLINE_EXTRA_REVIEWER',requestId='OFFLINE_EXTRA_REVIEW_TURN';
  const outputVerdict=['silent','wrong-packet','wrong-turn','early-event','late-event'].includes(outcome)?'PASS':outcome;
  if(outcome!=='silent'){
   const binding=currentProcessOwnership(),processId='OFFLINE_EXTRA_REVIEW_PROCESS';x.h.store.record('OwnedProcessIntent',x.p.id,input.runId,{dispatchId:binding.dispatchId,generation:binding.generation,processId,platform:'win32'});
   const packet=JSON.parse(JSON.parse(input.prompt).taskData);
   emit({method:'dm/codexAdmission',params:{role:'reviewer',threadId:sessionId,model:identity.model,provider:'openai',authentication:identity.authentication,includedUsageAllowed:true,paidFallback:false,permissionProfile:'dream-maker-supervisor-data',policyHash:'d'.repeat(64),reviewPacketHash:outcome==='wrong-packet'?'f'.repeat(64):hash(packet)}});
   emit({method:'dm/codexCompletion',params:{role:'reviewer',threadId:sessionId,turnId:outcome==='wrong-turn'?'OFFLINE_FOREIGN_TURN':requestId,model:identity.model,provider:'openai',status:'completed',runId:input.runId,specHash:input.specHash}});
   if(outcome==='early-event'||outcome==='late-event')x.h.store.db.prepare("UPDATE events SET at=? WHERE run_id=? AND json_extract(payload,'$.dispatchId')=? AND type='agent.event'").run(new Date(Date.now()+(outcome==='early-event'?-5000:5000)).toISOString(),input.runId,binding.dispatchId);
   x.h.store.record('OwnedProcessCleanup',x.p.id,input.runId,{dispatchId:binding.dispatchId,generation:binding.generation,processId,cleanupReturned:true});
  }
  return{text:JSON.stringify({verdict:outputVerdict,findings:outputVerdict==='PASS'?[]:[{id:'OFFLINE_STILL_BLOCKED',severity:'high',description:'offline remaining issue',evidence:'offline'}]}),sessionId,model:identity.model,identity,usage:{role:'reviewer',requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'}};
 }};}};
 const approved=await x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor);x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
 await x.h.engine.resume(approved.id);await x.h.engine.settled(approved.id);const r=x.h.store.run(approved.id);
 assert.equal(roles,1);assert.equal(executors,0);assert.equal(repairs,0);assert.equal(r.calls,before.calls);assert.equal(r.maxCalls,before.maxCalls);assert.equal(r.repairCount,before.repairCount);
 assert.equal(reviewSupplementEvidence(x.h.store,r).used,1);assert.equal(x.h.store.records(x.p.id,'Review').length,priorReviews+(['PASS','BLOCKED','CHANGES_REQUESTED'].includes(outcome)?1:0));
 assert.equal(r.state,outcome==='PASS'?'READY_FOR_DELIVERY':'BLOCKED');if(outcome==='PASS')assert.equal(r.review.verdict,'PASS');
 await assert.rejects(x.h.engine.resume(r.id));assert.equal(roles,1);assert.equal(x.h.store.records(x.p.id,'ReviewSupplementCallReservation').length,1);
});
