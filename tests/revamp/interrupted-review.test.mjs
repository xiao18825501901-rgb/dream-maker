// OFFLINE original Engine/Store with explicit trusted-reader seam; never Native proof.
import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';import {buildReviewPacket} from '../../dist/server/review-packet.js';import {hash} from '../../dist/server/security.js';
async function setup(t){
 const x=await reviewWindowFixture(t);await x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);
 const r=x.h.store.run(x.r.id);r.reason='RPC_LINE_TOO_LONG';r.calls=5;x.h.store.saveRun(r);
 const packet=buildReviewPacket(x.h.store,r,x.s),packetHash=hash(packet);
 x.h.store.record('ReviewPacket',x.p.id,r.id,{sha256:packetHash,packet});
 const dispatchId='OFFLINE_REVIEW_DISPATCH',generation='OFFLINE_GENERATION',processId='OFFLINE_PROCESS';
 x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId,generation,kind:'reviewer'});
 x.h.store.record('OwnedProcessIntent',x.p.id,r.id,{dispatchId,generation,processId,platform:'win32',commandSha256:'a'.repeat(64),argvSha256:'b'.repeat(64)});
 x.h.store.record('OwnedProcessCleanup',x.p.id,r.id,{dispatchId,generation,processId,cleanupReturned:true});
 x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId,generation,outcome:'RPC_LINE_TOO_LONG',cleanupReturned:true});
 x.h.store.event(x.p.id,r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer',threadId:'OFFLINE_REVIEW_THREAD',model:x.h.config.codex.model,provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',paidFallback:false,includedUsageAllowed:true,permissionProfile:'dream-maker-supervisor-data',policyHash:'c'.repeat(64),reviewPacketHash:packetHash}});
 let inspected=0;
 x.h.engine.nativeExecution={assertReady:()=>{},executor:()=>{throw Error('MODEL_FORBIDDEN');},verify:async()=>{throw Error('MODEL_FORBIDDEN');},close:async()=>{},inspectInterruptedReview:async input=>{inspected++;return {schema:'dream-maker.interrupted-review-observation.v1',threadId:input.threadId,turnId:'OFFLINE_TURN',status:'interrupted',inputHash:input.inputHash,contextHash:'d'.repeat(64),transcriptHash:'e'.repeat(64),userOnly:true,modelDispatchesByInspection:0,cleanupReturned:true};}};
 return {...x,r,inspected:()=>inspected,call:()=>x.h.engine.prepareInterruptedReview(r.id,r.treeHash,x.h.store.run(r.id).version,x.actor)};
}
test('original Engine prepares interrupted review once without dispatch or resetting limits',async t=>{
 const x=await setup(t),before=x.h.store.run(x.r.id),after=await x.call();
 assert.equal(after.state,'PAUSED');assert.equal(after.reason,'REVIEW_INTERRUPTION_RECONCILED');assert.equal(after.calls,before.calls);assert.equal(after.repairCount,before.repairCount);assert.equal(after.createdAt,before.createdAt);assert.deepEqual(after.reviewWindow,before.reviewWindow);
 assert.equal(after.review,null);assert.equal(x.inspected(),1);assert.equal(x.h.store.records(x.p.id,'ReviewInterruptedRecovery').length,1);
 await assert.rejects(x.call());assert.equal(x.inspected(),1);
});
test('interrupted Codex history inspection holds the CFW lease through child cleanup',async t=>{
 const x=await setup(t),original=x.h.engine.nativeExecution.inspectInterruptedReview;
 let active=false,leases=0,environment=null;
 const networkRoute={
  async withRun(_runId,_signal,action){assert.equal(active,false);active=true;leases++;try{return await action();}finally{active=false;}},
  childEnvironment(extra){if(!active)throw Object.assign(Error('OFFLINE_CFW_LEASE_MISSING'),{code:'CLASH_RUN_LEASE_REQUIRED'});return{...extra,HTTPS_PROXY:'http://127.0.0.1:7890/'};},
  async assertRecovered(){return{scope:'OFFLINE_CFW',pendingLocks:0};}
 };
 x.h.engine.networkRoute=networkRoute;
 x.h.engine.nativeExecution.inspectInterruptedReview=async(input,signal)=>{
  environment=networkRoute.childEnvironment({});
  return original(input,signal);
 };
 const after=await x.call();
 assert.equal(after.state,'PAUSED');assert.equal(leases,1);assert.equal(active,false);
 assert.equal(environment.HTTPS_PROXY,'http://127.0.0.1:7890/');
});
for(const status of ['completed','inProgress','failed'])test('official '+status+' is not treated as the confirmed interrupted user-only case',async t=>{
 const x=await setup(t),inspect=x.h.engine.nativeExecution.inspectInterruptedReview;x.h.engine.nativeExecution.inspectInterruptedReview=async input=>({...await inspect(input),status});
 await assert.rejects(x.call(),{code:'REVIEW_INTERRUPTION_HISTORY_UNVERIFIED'});assert.equal(x.inspected(),1);assert.equal(x.h.store.run(x.r.id).state,'BLOCKED');assert.equal(x.h.store.records(x.p.id,'ReviewInterruptedRecovery').length,0);
});
test('source changes during trusted inspection preserve blocked state and leave no recovery receipt',async t=>{
 const x=await setup(t),inspect=x.h.engine.nativeExecution.inspectInterruptedReview;x.h.engine.nativeExecution.inspectInterruptedReview=async input=>{const out=await inspect(input);writeFileSync(join(x.r.workspace,'changed.txt'),'OFFLINE drift');return out;};
 await assert.rejects(x.call());assert.equal(x.inspected(),1);assert.equal(x.h.store.records(x.p.id,'ReviewInterruptedRecovery').length,0);
});
test('a failed Store transition rolls back inspection receipt and recovery marker',async t=>{
 const x=await setup(t),before=x.h.store.run(x.r.id),observations=x.h.store.records(x.p.id,'WindowsIntentRecoveryObservation').length;t.mock.method(x.h.store,'saveRun',()=>{throw Error('OFFLINE_COMMIT_FAILURE');});
 await assert.rejects(x.call(),/OFFLINE_COMMIT_FAILURE/);assert.deepEqual(x.h.store.run(x.r.id),before);assert.equal(x.h.store.records(x.p.id,'ReviewInterruptedRecovery').length,0);
 assert.equal(x.h.store.records(x.p.id,'WindowsIntentRecoveryObservation').length,observations);
});

test('cancel waits for the interrupted-history reader cleanup before releasing the writer',async t=>{
 const x=await setup(t),original=x.h.engine.nativeExecution.inspectInterruptedReview;let start,release,seenSignal;
 const started=new Promise(r=>start=r),finish=new Promise(r=>release=r);
 x.h.engine.nativeExecution.inspectInterruptedReview=async(input,signal)=>{seenSignal=signal;start();await finish;return original(input);};
 const work=x.call();work.catch(()=>{});await started;let cancelled=false;
 const cancel=x.h.engine.cancel(x.r.id).then(r=>{cancelled=true;return r;});
 try{await new Promise(r=>setImmediate(r));assert.equal(cancelled,false);assert.equal(x.h.store.owns(x.p.id,x.r.id),true);assert.equal(seenSignal?.aborted,true);}
 finally{release();await Promise.allSettled([work,cancel]);}
 assert.equal(x.h.store.run(x.r.id).state,'CANCELLED');assert.equal(x.h.store.records(x.p.id,'ReviewInterruptedRecovery').length,0);
});

test('uncertain reader cleanup preserves a blocked run and original writer lease',async t=>{
 const x=await setup(t);let start,release;const started=new Promise(r=>start=r),finish=new Promise(r=>release=r);
 x.h.engine.nativeExecution.inspectInterruptedReview=async()=>{start();await finish;throw Object.assign(Error('OFFLINE_CLEANUP_UNCERTAIN'),{code:'PROCESS_CLEANUP_UNPROVEN'});};
 const work=x.call();work.catch(()=>{});await started;const cancel=x.h.engine.cancel(x.r.id);cancel.catch(()=>{});release();
 await Promise.allSettled([work,cancel]);assert.equal(x.h.store.run(x.r.id).state,'BLOCKED');assert.equal(x.h.store.run(x.r.id).reason,'PROCESS_CLEANUP_UNPROVEN');assert.equal(x.h.store.owns(x.p.id,x.r.id),true);
});

test('uncertain cleanup remains blocked when cancellation is requested after the reader has failed',async t=>{
 const x=await setup(t);x.h.engine.nativeExecution.inspectInterruptedReview=async()=>{throw Object.assign(Error('OFFLINE_CLEANUP_UNCERTAIN'),{code:'PROCESS_CLEANUP_UNPROVEN'});};
 await assert.rejects(x.call(),{code:'PROCESS_CLEANUP_UNPROVEN'});
 await assert.rejects(x.h.engine.cancel(x.r.id),{code:'PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED'});
 assert.equal(x.h.store.run(x.r.id).reason,'PROCESS_CLEANUP_UNPROVEN');assert.equal(x.h.store.owns(x.p.id,x.r.id),true);
});
