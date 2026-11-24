// OFFLINE Store/Engine seams only; no real identity, model or product evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';import {treeHash} from '../../dist/server/workspace.js';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';import {DomainError,hash} from '../../dist/server/security.js';
async function setup(t,preworkPrerequisite=false){const x=await reviewWindowFixture(t,{preworkPrerequisite});await x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);const r=x.h.store.run(x.r.id);
 r.state='BLOCKED';r.phase='REPAIRING';r.reason='RUNNER_RPC_ERROR';r.calls=7;r.repairCount=2;r.maxRepairs=2;r.review={verdict:'CHANGES_REQUESTED',source:'CODEX',treeHash:r.treeHash,findings:[{id:'OFFLINE_F1',severity:'medium',description:'offline finding',evidence:'offline',status:'open'}]};r.failedFingerprints.push(hash(JSON.stringify(r.review.findings)));x.h.store.saveRun(r);
 const dispatchId='OFFLINE_FAILED_REPAIR',generation='OFFLINE_GENERATION',processId='OFFLINE_PROCESS';x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId,generation,kind:'executor'});
 x.h.store.record('OwnedProcessIntent',x.p.id,r.id,{dispatchId,generation,processId});x.h.store.record('OwnedProcessCleanup',x.p.id,r.id,{dispatchId,generation,processId,cleanupReturned:true});
 const intent=x.h.store.record('ToolIntent',x.p.id,r.id,{tool:'desk_edit',specHash:r.specHash});writeFileSync(join(r.workspace,'main.mjs'),'// actual OFFLINE partial edit\n');
 const sourceHash=treeHash(r.workspace);x.h.store.record('ToolResult',x.p.id,r.id,{intentId:intent,tool:'desk_edit',specHash:r.specHash,sourceHash,status:'COMPLETE'});
 x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});
 x.h.engine.nativeExecution={assertReady:()=>{},executor:()=>{throw Error('MODEL_FORBIDDEN');},verify:async()=>{throw Error('MODEL_FORBIDDEN');},close:async()=>{}};
 return {...x,r,sourceHash,call:()=>x.h.engine.preparePartialRepair(r.id,{confirmed:true,sourceHash,expectedVersion:x.h.store.run(r.id).version},x.actor)};}
test('explicit partial repair continuation preserves bytes, old counters and deadline without implying completion',async t=>{const x=await setup(t),before=x.h.store.run(x.r.id),after=await x.call();assert.equal(after.state,'PAUSED');assert.equal(after.phase,'REPAIRING');assert.equal(after.treeHash,x.sourceHash);assert.equal(after.verification,null);assert.deepEqual(after.review,before.review);for(const k of ['calls','maxCalls','repairCount','maxRepairs','createdAt','maxSeconds'])assert.equal(after[k],before[k]);assert.deepEqual(after.reviewWindow,before.reviewWindow);assert.equal(x.h.store.records(x.p.id,'PartialRepairContinuation').length,1);await assert.rejects(x.call());});
test('unsettled tool side effect cannot be resumed',async t=>{const x=await setup(t);x.h.store.record('ToolIntent',x.p.id,x.r.id,{tool:'desk_edit',specHash:x.r.specHash});await assert.rejects(x.call());assert.equal(x.h.store.records(x.p.id,'PartialRepairContinuation').length,0);});
test('older controller-proven FAILED_NO_EFFECT remains settled without inventing its missing source fields',async t=>{const x=await setup(t),row=x.h.store.records(x.p.id,'ToolResult')[0];const data={intentId:row.data.intentId,tool:row.data.tool,status:'FAILED_NO_EFFECT',code:'SANDBOX_ENTRY_MISSING'};x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),row.id);assert.equal((await x.call()).state,'PAUSED');});
test('current bytes must match the last actual completed tool result',async t=>{const x=await setup(t);writeFileSync(join(x.r.workspace,'main.mjs'),'// foreign change');await assert.rejects(x.call());});
test('a final FAILED_NO_EFFECT result cannot claim a completed source anchor',async t=>{const x=await setup(t),row=x.h.store.records(x.p.id,'ToolResult').at(-1);x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.status','FAILED_NO_EFFECT','$.code','OFFLINE_REFUSAL') WHERE id=?").run(row.id);await assert.rejects(x.call());});
test('failed commit rolls back continuation receipt and keeps the old blocked run',async t=>{const x=await setup(t),before=x.h.store.run(x.r.id);t.mock.method(x.h.store,'saveRun',()=>{throw Error('OFFLINE_COMMIT_FAILURE');});await assert.rejects(x.call(),/OFFLINE_COMMIT_FAILURE/);assert.deepEqual(x.h.store.run(x.r.id),before);assert.equal(x.h.store.records(x.p.id,'PartialRepairContinuation').length,0);});
for(const [name,alter]of [
 ['remaining automatic repairs',x=>{const r=x.h.store.run(x.r.id);r.repairCount=1;x.h.store.saveRun(r);}],
 ['missing explicit confirmation',x=>{x.call=()=>x.h.engine.preparePartialRepair(x.r.id,{confirmed:false,sourceHash:x.sourceHash,expectedVersion:x.h.store.run(x.r.id).version},x.actor);}],
 ['unknown actor',x=>{x.call=()=>x.h.engine.preparePartialRepair(x.r.id,{confirmed:true,sourceHash:x.sourceHash,expectedVersion:x.h.store.run(x.r.id).version},'MODEL_CLAIM');}],
 ['late tool result',x=>x.h.store.record('ToolResult',x.p.id,x.r.id,{tool:'desk_edit',status:'COMPLETE',sourceHash:x.sourceHash})],
 ['expired original window',x=>x.t.mock.timers.tick(3600001)]
])test('partial continuation refuses '+name+' without a new receipt',async t=>{const x=await setup(t);x.t=t;alter(x);await assert.rejects(Promise.resolve().then(x.call));assert.equal(x.h.store.records(x.p.id,'PartialRepairContinuation').length,0);});
for(const action of ['missing older result','unknown older effect','foreign cleanup generation','duplicate cleanup'])test('partial continuation refuses '+action,async t=>{
 const x=await setup(t),rows=x.h.store.records(x.p.id,action.includes('older')?'ToolResult':'OwnedProcessCleanup'),row=action.includes('older')?rows[0]:rows.at(-1);
 if(action==='missing older result')x.h.store.db.prepare('DELETE FROM records WHERE id=?').run(row.id);
 else if(action==='unknown older effect')x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.status','UNKNOWN_EFFECT') WHERE id=?").run(row.id);
 else if(action==='foreign cleanup generation')x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.generation','FOREIGN') WHERE id=?").run(row.id);
 else x.h.store.record('OwnedProcessCleanup',x.p.id,x.r.id,row.data);
 await assert.rejects(x.call());assert.equal(x.h.store.records(x.p.id,'PartialRepairContinuation').length,0);
});
test('one approved repair continuation cannot segment or auto-repair after a runner error',async t=>{
 const x=await setup(t,true);await x.call();fixedControllerCapacity(x.h.engine);let calls=0,segments=0;
 x.h.engine.nativeExecution.executor=()=>({run:async()=>{calls++;throw new DomainError('RUNNER_RPC_ERROR',502);}});
 x.h.engine.executorSegmented=async()=>{segments++;throw Error('SEGMENT_FORBIDDEN');};
 await x.h.engine.resume(x.r.id);await x.h.engine.loop(x.r.id,new AbortController().signal);
 assert.equal(calls,1);assert.equal(segments,0);const r=x.h.store.run(x.r.id);assert.equal(r.state,'BLOCKED');assert.equal(r.reason,'RUNNER_RPC_ERROR');assert.equal(r.repairCount,2);assert.equal(r.calls,8);
});
test('resume retains the exact original reviewer repair cause required by inner request binding',async t=>{
 const x=await setup(t);await x.call();await x.h.engine.resume(x.r.id);const r=x.h.store.run(x.r.id);assert.equal(r.reason,JSON.stringify(r.review.findings));assert.equal(hash(r.reason),r.failedFingerprints.at(-1));
});
async function refusedAdmission(t,emptyReceiptCount=1){const x=await setup(t);await x.call();const r=x.h.store.run(x.r.id);r.state='BLOCKED';r.reason='RUNNER_RPC_ERROR';r.calls++;x.h.store.saveRun(r);
 const dispatchId='OFFLINE_REFUSED_ADMISSION',generation='OFFLINE_SECOND_GENERATION',processId='OFFLINE_SECOND_PROCESS';
 x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId,generation,kind:'executor'});
 x.h.store.record('OwnedProcessIntent',x.p.id,r.id,{dispatchId,generation,processId});
 for(let i=0;i<emptyReceiptCount;i++)x.h.store.record('NativeBudgetReceipt',x.p.id,r.id,{method:'dm/budget',params:{requests:[]}});
 x.h.store.record('OwnedProcessCleanup',x.p.id,r.id,{dispatchId,generation,processId,cleanupReturned:true});
 x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});
 x.h.engine.nativeExecution.assertEmptyNativeDispatch=()=>{};return x;
}
test('one verified zero-model admission rejection can be reconciled without granting another repair',async t=>{
 const x=await refusedAdmission(t),before=x.h.store.run(x.r.id);const after=await x.call();assert.equal(after.state,'PAUSED');assert.equal(after.calls,before.calls);assert.equal(after.repairCount,before.repairCount);assert.equal(x.h.store.records(x.p.id,'PartialRepairContinuation').length,1);assert.equal(x.h.store.records(x.p.id,'PartialRepairAdmissionRecovery').length,1);await assert.rejects(x.call());
});
test('three bounded zero-request admission receipts remain a zero-model recovery',async t=>{
 const x=await refusedAdmission(t,3),before=x.h.store.run(x.r.id),after=await x.call();
 assert.equal(after.state,'PAUSED');assert.equal(after.calls,before.calls);assert.equal(after.repairCount,before.repairCount);
 assert.equal(x.h.store.records(x.p.id,'PartialRepairAdmissionRecovery').length,1);
});
test('any real or unknown Native reservation prevents zero-model admission recovery',async t=>{const x=await refusedAdmission(t);x.h.engine.nativeExecution.assertEmptyNativeDispatch=()=>{throw new DomainError('NATIVE_DISPATCH_REQUESTS_PRESENT',409);};await assert.rejects(x.call(),{code:'NATIVE_DISPATCH_REQUESTS_PRESENT'});assert.equal(x.h.store.records(x.p.id,'PartialRepairAdmissionRecovery').length,0);});
test('a completed late tool after an empty admission still prevents recovery',async t=>{const x=await refusedAdmission(t),id=x.h.store.record('ToolIntent',x.p.id,x.r.id,{tool:'desk_run',specHash:x.r.specHash});x.h.store.record('ToolResult',x.p.id,x.r.id,{intentId:id,tool:'desk_run',specHash:x.r.specHash,sourceHash:x.sourceHash,status:'COMPLETE'});await assert.rejects(x.call());assert.equal(x.h.store.records(x.p.id,'PartialRepairAdmissionRecovery').length,0);});
async function preparationRecoveryAdmission(t){
 const x=await reviewWindowFixture(t);await x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);const r=x.h.store.run(x.r.id),
  review={verdict:'CHANGES_REQUESTED',source:'CODEX',treeHash:r.treeHash,findings:[{id:'OFFLINE_F1',severity:'medium',description:'offline finding',evidence:'offline',status:'open'}]},
  reviewRecordId=x.h.store.record('Review',x.p.id,r.id,review),priorDispatchId='OFFLINE_PREPARATION_REPLAY',priorGeneration='OFFLINE_PREPARATION_GENERATION';
 x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId:priorDispatchId,generation:priorGeneration,kind:'executor',mode:'live',cleanupReturned:false});
 x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId:priorDispatchId,generation:priorGeneration,outcome:'REVIEW_PREPARATION_REPLAY_INVALID',cleanupReturned:true});
 x.h.store.record('ReviewPreparationDispatchRecovery',x.p.id,r.id,{schema:'dream-maker.review-preparation-dispatch-recovery.v1',sourceHash:r.treeHash,specHash:r.specHash,
  planVersionHash:r.planVersionHash,reviewRecordId,reviewHash:hash(review),dispatchId:priorDispatchId,generation:priorGeneration,outcome:'REVIEW_PREPARATION_REPLAY_INVALID',
  calls:5,repairCount:2,createdAt:r.createdAt,maxSeconds:r.maxSeconds,modelDispatched:false,automaticRetry:false,basisHash:'e'.repeat(64),version:r.version,recoveredAt:new Date().toISOString()});
 Object.assign(r,{state:'BLOCKED',phase:'REPAIRING',reason:'RUNNER_RPC_ERROR',review,calls:6,maxCalls:13,repairCount:2,maxRepairs:2,
  tasks:[{id:'OFFLINE_TASK',status:'implemented'}],failedFingerprints:[hash(JSON.stringify(review.findings))]});x.h.store.saveRun(r);
 const dispatchId='OFFLINE_ZERO_MODEL_RETRY',generation='OFFLINE_ZERO_MODEL_GENERATION';
 x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId,generation,kind:'executor',mode:'live',cleanupReturned:false});
 for(let i=1;i<=3;i++){const processId='OFFLINE_ZERO_MODEL_PROCESS_'+i;
  x.h.store.record('OwnedProcessIntent',x.p.id,r.id,{dispatchId,generation,processId});
  x.h.store.record('NativeBudgetReceipt',x.p.id,r.id,{method:'dm/budget',params:{requests:[]}});
  x.h.store.record('OwnedProcessCleanup',x.p.id,r.id,{dispatchId,generation,processId,cleanupReturned:true});}
 x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});
 x.h.engine.nativeExecution={assertReady:()=>{},assertEmptyNativeDispatch:()=>{},executor:()=>{throw Error('MODEL_FORBIDDEN');},verify:async()=>{throw Error('MODEL_FORBIDDEN');},close:async()=>{}};
 return {...x,r,sourceHash:r.treeHash,call:()=>x.h.engine.preparePartialRepair(r.id,{confirmed:true,sourceHash:r.treeHash,expectedVersion:x.h.store.run(r.id).version},x.actor)};
}
test('a zero-model retry after exact review-preparation recovery can re-enter the same repair',async t=>{
 const x=await preparationRecoveryAdmission(t),before=x.h.store.run(x.r.id),after=await x.call();
 assert.equal(after.state,'PAUSED');assert.equal(after.phase,'REPAIRING');assert.equal(after.reason,JSON.stringify(after.review.findings));
 for(const key of ['calls','maxCalls','repairCount','maxRepairs','createdAt','maxSeconds','treeHash'])assert.equal(after[key],before[key]);
 assert.equal(x.h.store.records(x.p.id,'PartialRepairAdmissionRecovery').length,1);assert.equal(x.h.store.records(x.p.id,'PartialRepairContinuation').length,0);
});
test('a zero-model retry cannot borrow an unrelated review-preparation recovery',async t=>{
 const x=await preparationRecoveryAdmission(t),row=x.h.store.records(x.p.id,'ReviewPreparationDispatchRecovery')[0];
 x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.sourceHash',?) WHERE id=?").run('f'.repeat(64),row.id);
 await assert.rejects(x.call());assert.equal(x.h.store.records(x.p.id,'PartialRepairAdmissionRecovery').length,0);
});
