// OFFLINE Store/Engine recovery contract only. No model, native verifier or product acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';
import {treeHash} from '../../dist/server/workspace.js';

const ACTOR='local-session:'+'a'.repeat(64);
const PREPARED='INTERRUPTED_REPAIR_VERIFICATION_PREPARED';

async function interruptedRepair(t,{noEffect=false,restarted=false}={}){
 const x=await reviewWindowFixture(t);
 const r=x.h.store.run(x.r.id);
 const previousSourceHash=r.treeHash;
 r.state='BLOCKED';
 r.phase='REPAIRING';
 r.reason=restarted?'WORKER_RESTART_RESULT_UNCERTAIN':'RUNNER_RPC_ERROR';
 r.calls=7;
 r.repairCount=2;
 r.maxRepairs=2;
 r.review=null;
 r.verification={ok:false,exitCode:1,stdout:'OLD_FAILURE',stderr:'OLD_FAILURE',command:['offline-verifier'],treeHash:previousSourceHash,at:new Date().toISOString(),evidenceId:'OFFLINE_OLD_EVIDENCE'};
 r.tasks=r.tasks.map(task=>({...task,status:'implemented'}));
 x.h.store.saveRun(r);

 const dispatchId='OFFLINE_INTERRUPTED_REPAIR';
 const generation='OFFLINE_INTERRUPTED_REPAIR_GENERATION';
 x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId,generation,kind:'executor',mode:'live',cleanupReturned:false});

 const processId='OFFLINE_INTERRUPTED_REPAIR_PROCESS';
 x.h.store.record('OwnedProcessIntent',x.p.id,r.id,{dispatchId,generation,processId});
 x.h.store.record('OwnedProcessCleanup',x.p.id,r.id,{dispatchId,generation,processId,cleanupReturned:true});

 writeFileSync(join(r.workspace,'main.mjs'),'// OFFLINE interrupted repair result\n');
 const editedHash=treeHash(r.workspace);
 const editIntent=x.h.store.record('ToolIntent',x.p.id,r.id,{tool:'desk_edit',specHash:r.specHash,sourceHash:previousSourceHash});
 x.h.store.record('ToolResult',x.p.id,r.id,{intentId:editIntent,tool:'desk_edit',specHash:r.specHash,sourceHash:editedHash,status:'COMPLETE'});
 const runIntent=x.h.store.record('ToolIntent',x.p.id,r.id,{tool:'desk_run',specHash:r.specHash,sourceHash:editedHash});
 x.h.store.record('ToolResult',x.p.id,r.id,{intentId:runIntent,tool:'desk_run',specHash:r.specHash,sourceHash:editedHash,status:'COMPLETE'});
 let noEffectIntent,noEffectResult;
 if(noEffect){
  noEffectIntent=x.h.store.record('ToolIntent',x.p.id,r.id,{tool:'desk_write',specHash:r.specHash,sourceHash:editedHash});
  noEffectResult=x.h.store.record('ToolResult',x.p.id,r.id,{intentId:noEffectIntent,tool:'desk_write',status:'FAILED_NO_EFFECT',code:'NATIVE_TOOL_FAILED'});
 }
 x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});

 const sourceHash=treeHash(r.workspace);
 const call=(version=x.h.store.run(r.id).version)=>x.h.engine.prepareInterruptedRepairVerification(
  r.id,
  {confirmed:true,sourceHash,expectedVersion:version},
  ACTOR,
 );
 return {...x,r,previousSourceHash,sourceHash,dispatchId,generation,processId,call,noEffectIntent,noEffectResult};
}

for(const restarted of [false,true])test('settled no-effect tool refusal permits verification only after '+(restarted?'restart classification':'RPC failure'),async t=>{
 const x=await interruptedRepair(t,{noEffect:true,restarted}),before=x.h.store.run(x.r.id);
 const after=await x.call();assert.equal(after.state,'PAUSED');assert.equal(after.phase,'VERIFYING');
 assert.equal(after.calls,before.calls);assert.equal(after.repairCount,before.repairCount);
 const row=x.h.store.records(x.p.id,'ToolResult').find(r=>r.id===x.noEffectResult);
 assert.equal(row.data.status,'FAILED_NO_EFFECT');assert.equal(after.review,null);
});
for(const [name,alter] of [
 ['unknown effect',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.status','UNKNOWN_EFFECT') WHERE id=?").run(x.noEffectResult)],
 ['missing refusal code',x=>x.h.store.db.prepare("UPDATE records SET data=json_remove(data,'$.code') WHERE id=?").run(x.noEffectResult)],
 ['no-effect source drift',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.sourceHash',?) WHERE id=?").run('f'.repeat(64),x.noEffectIntent)],
])test('no-effect verification recovery refuses '+name,async t=>{
 const x=await interruptedRepair(t,{noEffect:true,restarted:true});alter(x);
 await assert.rejects(x.call(),{code:'INTERRUPTED_REPAIR_VERIFICATION_NOT_RECOVERABLE'});
 assert.equal(x.h.store.records(x.p.id,'InterruptedRepairVerificationRecovery').length,0);
});

test('one exact interrupted repair prepares formal verification without a model or executor dispatch',async t=>{
 const x=await interruptedRepair(t);
 const before=x.h.store.run(x.r.id);
 const after=await x.call(before.version);
 assert.equal(after.state,'PAUSED');
 assert.equal(after.phase,'VERIFYING');
 assert.equal(after.reason,PREPARED);
 assert.equal(after.treeHash,x.sourceHash);
 for(const key of ['calls','maxCalls','repairCount','maxRepairs','createdAt','maxSeconds','review','failedFingerprints'])
  assert.deepEqual(after[key],before[key],key);
 assert.deepEqual(after.verification,before.verification);
 const rows=x.h.store.records(x.p.id,'InterruptedRepairVerificationRecovery');
 assert.equal(rows.length,1);
 assert.equal(rows[0].data.modelDispatched,false);
 assert.equal(rows[0].data.automaticRetry,false);
 assert.equal(rows[0].data.dispatchId,x.dispatchId);
 assert.equal(rows[0].data.sourceHash,x.sourceHash);
 assert.equal(rows[0].data.previousSourceHash,x.previousSourceHash);
});

test('the same recovery request replays the one durable receipt without a second state transition',async t=>{
 const x=await interruptedRepair(t);
 const version=x.h.store.run(x.r.id).version;
 const first=await x.call(version);
 const second=await x.call(version);
 assert.deepEqual(second,first);
 assert.equal(x.h.store.records(x.p.id,'InterruptedRepairVerificationRecovery').length,1);
});

test('recovery refuses source bytes that no longer match the final COMPLETE tool result',async t=>{
 const x=await interruptedRepair(t);
 writeFileSync(join(x.r.workspace,'main.mjs'),'// FOREIGN CHANGE\n');
 await assert.rejects(x.call(),{code:'INTERRUPTED_REPAIR_VERIFICATION_NOT_RECOVERABLE'});
 assert.equal(x.h.store.records(x.p.id,'InterruptedRepairVerificationRecovery').length,0);
});

for(const [name,alter] of [
 ['missing tool result',x=>{
  const row=x.h.store.records(x.p.id,'ToolResult').at(-1);
  x.h.store.db.prepare('DELETE FROM records WHERE id=?').run(row.id);
 }],
 ['incomplete process cleanup',x=>{
  const row=x.h.store.records(x.p.id,'OwnedProcessCleanup').at(-1);
  x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',0) WHERE id=?").run(row.id);
 }],
 ['new source effect after dispatch finish',x=>{
  const intent=x.h.store.record('ToolIntent',x.p.id,x.r.id,{tool:'desk_edit',specHash:x.r.specHash,sourceHash:x.sourceHash});
  x.h.store.record('ToolResult',x.p.id,x.r.id,{intentId:intent,tool:'desk_edit',specHash:x.r.specHash,sourceHash:x.sourceHash,status:'COMPLETE'});
 }],
 ['old verification already bound to current source',x=>{
  const r=x.h.store.run(x.r.id);
  r.verification={...r.verification,treeHash:x.sourceHash};
  x.h.store.saveRun(r);
 }],
 ['run reason is not a runner transport failure',x=>{
  const r=x.h.store.run(x.r.id);
  r.reason='VERIFIER_EXIT_1';
  x.h.store.saveRun(r);
 }],
])test('recovery refuses '+name,async t=>{
 const x=await interruptedRepair(t);
 alter(x);
 await assert.rejects(x.call(),{code:'INTERRUPTED_REPAIR_VERIFICATION_NOT_RECOVERABLE'});
 assert.equal(x.h.store.records(x.p.id,'InterruptedRepairVerificationRecovery').length,0);
});

test('resume starts only the formal verifier after the zero-model recovery',async t=>{
 const x=await interruptedRepair(t);
 const first=await x.call();
 let launches=0;
 x.h.engine.launch=()=>{launches++;};
 x.h.engine.nativeExecution={
  assertReady:()=>{throw Error('MODEL_ADMISSION_FORBIDDEN');},
  executor:()=>{throw Error('EXECUTOR_FORBIDDEN');},
  verify:async()=>{throw Error('SYNCHRONOUS_TEST_STOP');},
  close:async()=>{},
 };
 const resumed=await x.h.engine.resume(x.r.id);
 assert.equal(resumed.state,'VERIFYING');
 assert.equal(resumed.reason,null);
 assert.equal(launches,1);
 assert.equal(x.h.store.records(x.p.id,'InterruptedRepairVerificationRecovery').length,1);
 assert.equal(x.h.store.run(x.r.id).calls,first.calls);
});
