// OFFLINE_TEST: original Engine/Store + deterministic controller seam, never real product roles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness,ready} from '../helpers.mjs';
import {treeHash} from '../../dist/server/workspace.js';
import {ExecutorSlices} from '../../dist/server/flow/executor-slices.js';
import {DomainError} from '../../dist/server/security.js';
async function rig(t){
 const h=harness(t),{p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);h.engine.pause(created.id);await h.engine.settled(created.id);
 const r=h.store.run(created.id);r.state=r.phase='IMPLEMENTING';r.tasks=['A','B'].map((id,i)=>({id,title:id,dependsOn:[],requirementIds:[s.requirements[0].id],acceptance:['check'],writePaths:[i?'b.txt':'a.txt'],status:'pending'}));
 mkdirSync(r.workspace,{recursive:true});writeFileSync(resolve(r.workspace,'a.txt'),'a0');writeFileSync(resolve(r.workspace,'b.txt'),'b0');r.treeHash=treeHash(r.workspace);h.store.saveRun(r);
 const calls=[];h.engine.role=async(run,role,prompt,signal,taskId,sliceId)=>{
  if(role!=='executor')throw new DomainError('OFFLINE_STOP_BEFORE_REAL_REVIEW');calls.push({taskId,sliceId});
  const current=h.store.run(run.id);current.tasks=current.tasks.map(t=>t.id===taskId?{...t,status:'running'}:t);h.store.saveRun(current);
  const assignment=new ExecutorSlices(h.store,h.dir).assignment(run.id,sliceId);writeFileSync(resolve(assignment.workspace,taskId==='A'?'a.txt':'b.txt'),'changed '+taskId);
 };
 // Stop at the original verifier boundary: it must see the combined bytes and runs after merge.
 let verified=false;h.engine.verifyOwned=async()=>{throw Error('NO_NATIVE_VERIFIER');};
 const dispatch=h.engine.dispatch.run.bind(h.engine.dispatch);h.engine.dispatch.run=(request,action)=>{if(request.kind==='verifier'){verified=true;throw new DomainError('OFFLINE_STOP_AT_COMBINED_VERIFIER');}return dispatch(request,action);};
 return {h,r,calls,verified:()=>verified};
}
test('original Engine uses different task workspaces then reaches the original whole-tree verifier',async t=>{
 const {h,r,calls,verified}=await rig(t);await h.engine.loop(r.id,new AbortController().signal);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.sliceId));assert.notEqual(calls[0].sliceId,calls[1].sliceId);
 assert.equal(readFileSync(resolve(r.workspace,'a.txt'),'utf8'),'changed A');assert.equal(readFileSync(resolve(r.workspace,'b.txt'),'utf8'),'changed B');
 assert.equal(verified(),true);assert.equal(h.store.run(r.id).reason,'OFFLINE_STOP_AT_COMBINED_VERIFIER');
 assert.ok(h.store.run(r.id).tasks.every(t=>t.status==='implemented'));assert.equal(h.store.run(r.id).verification,null);
 const source=h.store.records(r.projectId,'SourceSnapshot').map(row=>row.data);assert.ok(source.some(row=>row.stage==='EXECUTOR_BEFORE'));assert.ok(source.some(row=>row.stage==='EXECUTOR_AFTER'&&row.treeHash===h.store.run(r.id).treeHash));
});
test('uncertain merged bytes cannot be cancelled or accepted to release their original writer',async t=>{
 const {h,r}=await rig(t);h.store.record('ExecutorMergeIntent',r.projectId,r.id,{waveId:'offline_unknown',beforeHash:r.treeHash,sourceHash:'0'.repeat(64)});
 await assert.rejects(h.engine.cancel(r.id),{code:'EXECUTOR_MERGE_RESULT_UNCERTAIN'});assert.equal(h.store.owns(r.projectId,r.id),true);
 assert.throws(()=>h.engine.accept(r.id),{code:'ACCEPTANCE_GATES_NOT_MET'});h.engine.recover();assert.equal(h.store.run(r.id).reason,'EXECUTOR_MERGE_RESULT_UNCERTAIN');assert.equal(h.store.owns(r.projectId,r.id),true);
});
test('pause retains a sealed task and explicit resume dispatches only the unstarted sibling',async t=>{
 const {h,r,calls}=await rig(t),turn=h.engine.role;let paused=false;
 h.engine.role=async(...args)=>{if(h.store.run(r.id).state==='PAUSE_REQUESTED')throw new DomainError('DISPATCH_PAUSED',409);const value=turn(...args);if(!paused){paused=true;const current=h.store.run(r.id);current.state='PAUSE_REQUESTED';h.store.saveRun(current);}return await value;};
 await h.engine.loop(r.id,new AbortController().signal);assert.equal(h.store.run(r.id).state,'PAUSED');assert.equal(calls.length,1);
 await h.engine.resume(r.id);await h.engine.settled(r.id);assert.deepEqual(calls.map(c=>c.taskId),['A','B']);assert.equal(h.store.run(r.id).reason,'OFFLINE_STOP_AT_COMBINED_VERIFIER');
});
test('a changed independent copy cannot be retried just because canonical source stayed unchanged',async t=>{
 const {h,r}=await rig(t),slices=new ExecutorSlices(h.store,h.dir),wave=slices.prepare(r.id),assignment=wave.assignments[0],input={signal:new AbortController().signal,workspace:assignment.workspace};let calls=0;
 const runner={async run(){calls++;writeFileSync(resolve(assignment.workspace,'a.txt'),'partial');throw new DomainError('DSH_HOST_TIMEOUT',504);}};
 await assert.rejects(h.engine.executorSegmented(r,input,runner,'task',{adoption:'off'},()=>{}),{code:'DSH_HOST_TIMEOUT'});assert.equal(calls,1);assert.equal(readFileSync(resolve(r.workspace,'a.txt'),'utf8'),'a0');
});
test('process-only reconciliation cannot release an unfinished merge after a route error masks the reason',async t=>{
 const {h,r}=await rig(t),current=h.store.run(r.id);current.state='BLOCKED';current.reason='PROCESS_CLEANUP_UNPROVEN';h.store.saveRun(current);
 h.store.record('ExecutorMergeIntent',r.projectId,r.id,{waveId:'OFFLINE_INCOMPLETE_PUBLICATION',beforeHash:r.treeHash,sourceHash:'0'.repeat(64)});
 let processInspections=0;h.engine.ownershipProofs=()=>{processInspections++;return {ok:true,reasons:[],evidence:{scope:'OFFLINE_TEST_NO_NATIVE_PROOF'}};};h.engine.dispatch.reconcileOwned=async()=>{};
 await assert.rejects(h.engine.reconcile(r.id),{code:'EXECUTOR_MERGE_RESULT_UNCERTAIN'});assert.equal(h.store.owns(r.projectId,r.id),true);assert.equal(processInspections,0);assert.equal(h.store.run(r.id).state,'BLOCKED');
});
test('an anomalous unfinished merge never rewrites a historically accepted run',async t=>{
 const {h,r}=await rig(t),current=h.store.run(r.id);current.state='ACCEPTED';h.store.saveRun(current);const before=h.store.run(r.id);
 h.store.record('ExecutorMergeIntent',r.projectId,r.id,{waveId:'OFFLINE_ACCEPTED_ANOMALY',beforeHash:r.treeHash,sourceHash:'0'.repeat(64)});
 h.engine.recover();assert.deepEqual(h.store.run(r.id),before);assert.equal(h.store.records(r.projectId,'ExecutorMergeApplied').length,0);assert.ok(h.store.events(r.projectId,0).some(e=>e.type==='run.accepted.merge.recovery.required'));
});
