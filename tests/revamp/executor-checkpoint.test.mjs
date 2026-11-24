// OFFLINE original SQLite/files recovery; no native model or review evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {resolve} from 'node:path';
import {interruptedTask} from '../fixtures/interrupted-task.mjs';import {treeHash} from '../../dist/server/workspace.js';
import {hash,DomainError} from '../../dist/server/security.js';
const actor='local-session:'+'a'.repeat(64),operation=name=>hash('OFFLINE_CHECKPOINT_'+name);

test('a settled money-limit interruption can retain source without resetting monetary or run limits',async t=>{
 const {h,run}=await interruptedTask(t);h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_ONLY'}});
 const blocked=h.store.run(run.id);blocked.reason='USER_BUDGET_LIMIT';blocked.tasks.push({id:'OTHER',title:'already implemented elsewhere',status:'implemented',dependsOn:[],requirementIds:[],acceptance:[],writePaths:['other.txt']});h.store.saveRun(blocked);
 const before=h.store.run(run.id),limits={calls:before.calls,maxCalls:before.maxCalls,repairCount:before.repairCount,maxRepairs:before.maxRepairs,maxSeconds:before.maxSeconds,createdAt:before.createdAt,usage:before.usage},view=h.engine.executorCheckpointPreview(run.id);
 assert.equal(h.engine.executorCheckpointRequired(run.id),true);assert.equal(view.modelsCalled,0);
 await h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('money-limit'),actor);
 const current=h.store.run(run.id);assert.equal(current.state,'PAUSED');assert.equal(current.tasks.find(t=>t.id==='OTHER').status,'implemented');
 assert.deepEqual({calls:current.calls,maxCalls:current.maxCalls,repairCount:current.repairCount,maxRepairs:current.maxRepairs,maxSeconds:current.maxSeconds,createdAt:current.createdAt,usage:current.usage},limits);
 assert.equal(h.store.owns(run.projectId,run.id),true);assert.equal(h.store.records(run.projectId,'ExecutorSliceSealed').length,0);assert.equal(h.engine.activeJobCount,0);
});

test('source recovery cannot renew global call, wall-clock or repair ceilings',async t=>{
 const {h,run}=await interruptedTask(t);
 for(const reason of ['RUN_CALL_BUDGET_EXCEEDED','RUN_WALL_TIME_BUDGET_EXCEEDED','REPAIR_LIMIT']){
  const current=h.store.run(run.id);current.reason=reason;h.store.saveRun(current);assert.equal(h.engine.executorCheckpointRequired(run.id),false);
  assert.throws(()=>h.engine.executorCheckpointPreview(run.id),{code:'EXECUTOR_CHECKPOINT_NOT_REQUIRED'});
 }
 assert.equal(h.store.records(run.projectId,'ExecutorCheckpointIntent').length,0);
});

test('Live resume with an unavailable money gate leaves the prepared checkpoint and all records unchanged',async t=>{
 const {h,run}=await interruptedTask(t),paused=h.store.run(run.id);paused.mode='live';paused.state='PAUSED';paused.reason='EXECUTOR_CHECKPOINT_PREPARED';h.store.saveRun(paused);
 let modelCalls=0;h.engine.nativeExecution={assertReady(){throw new DomainError('USER_BUDGET_LIMIT',409);},executor(){modelCalls++;throw Error('OFFLINE_MODEL_MUST_NOT_RUN');},async verify(){throw Error('OFFLINE_VERIFY_MUST_NOT_RUN');},async close(){}};
 const before=h.store.run(run.id),records=h.store.records(run.projectId).length;
 await assert.rejects(h.engine.resume(run.id),{code:'USER_BUDGET_LIMIT'});
 assert.deepEqual(h.store.run(run.id),before);assert.equal(h.store.records(run.projectId).length,records);assert.equal(h.engine.activeJobCount,0);assert.equal(modelCalls,0);assert.equal(h.store.owns(run.projectId,run.id),true);
});
test('interrupted multi-task copies can be inspected without changing task, source, lease or journal',async t=>{
 const {h,run,slices}=await interruptedTask(t),before=h.store.run(run.id),count=h.store.records(run.projectId).length,source=treeHash(run.workspace);
 const inspection=slices.inspectCheckpoint(run.id);
 assert.equal(inspection.view.tasks.length,2);assert.equal(inspection.view.tasks[0].toolCalls,1);assert.equal(inspection.view.modelsCalled,0);assert.equal(inspection.view.automaticResume,false);
 assert.equal(inspection.view.tasks[0].sourceHash,treeHash(inspection.wave.assignments[0].workspace));assert.equal(treeHash(run.workspace),source);
 assert.deepEqual(h.store.run(run.id),before);assert.equal(h.store.records(run.projectId).length,count);assert.equal(h.store.owns(run.projectId,run.id),true);
});
test('original Engine prepares new retained copies while every task remains unfinished and no model is launched',async t=>{
 const {h,run,slices,wave}=await interruptedTask(t),view=h.engine.executorCheckpointPreview(run.id),before=treeHash(run.workspace),usage=h.store.run(run.id).usage,approvals=h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all();
 h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_OS_PROOF_NOT_NATIVE'}});
 const result=await h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('prepare'),actor);
 assert.equal(result.state,'PAUSED');assert.equal(result.taskCompletionAssumed,false);assert.equal(result.automaticResume,false);assert.equal(result.modelsCalled,0);assert.equal(h.engine.activeJobCount,0);
 const r=h.store.run(run.id);assert.equal(r.state,'PAUSED');assert.ok(r.tasks.every(t=>t.status==='pending'));assert.equal(h.store.owns(r.projectId,r.id),true);assert.equal(treeHash(r.workspace),before);assert.deepEqual(r.usage,usage);
 assert.deepEqual(h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all(),approvals);assert.equal(h.store.records(r.projectId,'ExecutorSliceSealed').length,0);assert.equal(h.store.records(r.projectId,'ExecutorMergeApplied').length,0);
 const prepared=h.store.records(r.projectId,'ExecutorCheckpointPrepared').at(-1).data;
 assert.equal(prepared.copies.length,2);assert.equal(prepared.waveId,wave.id);assert.notEqual(result.newWaveId,wave.id);
 const source=JSON.parse(readFileSync(resolve(h.dir,'controller/executor-waves',r.id,result.newWaveId,'wave.json'),'utf8'));
 assert.equal(readFileSync(resolve(source.assignments[0].workspace,'a.txt'),'utf8'),'a1');assert.equal(readFileSync(resolve(wave.assignments[0].workspace,'a.txt'),'utf8'),'a1');
 assert.equal(readFileSync(resolve(source.assignments[1].workspace,'b.txt'),'utf8'),'b0');
 const replay=await h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('prepare'),actor);assert.equal(replay.replayed,true);assert.equal(h.store.records(r.projectId,'ExecutorCheckpointPrepared').length,1);
 writeFileSync(resolve(source.assignments[0].workspace,'a.txt'),'changed after recovery');await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('prepare'),actor),{code:'EXECUTOR_CHECKPOINT_SOURCE_CHANGED'});
});
test('consent, current preview, active work and missing OS cleanup cannot be used to prepare another writer',async t=>{
 const {h,run}=await interruptedTask(t),view=h.engine.executorCheckpointPreview(run.id),request={confirmed:true,previewHash:view.previewHash};
 await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,{...request,confirmed:false},operation('no-consent'),actor),{code:'EXECUTOR_CHECKPOINT_CONSENT_REQUIRED'});
 await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,{...request,previewHash:'0'.repeat(64)},operation('stale'),actor),{code:'EXECUTOR_CHECKPOINT_PREVIEW_CHANGED'});
 h.engine.jobs.set(run.id,{controller:new AbortController(),promise:Promise.resolve()});await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,request,operation('busy'),actor),{code:'PROCESS_OWNERSHIP_ACTIVE'});h.engine.jobs.delete(run.id);
 h.engine.ownershipProofs=()=>({ok:false,reasons:['OFFLINE_UNPROVEN'],evidence:{}});await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,request,operation('unproven'),actor),{code:'PROCESS_OWNERSHIP_UNPROVEN'});
 assert.equal(h.store.records(run.projectId,'ExecutorCheckpointIntent').length,0);assert.equal(h.store.run(run.id).state,'BLOCKED');assert.equal(h.store.owns(run.projectId,run.id),true);
});
test('an interrupted checkpoint commit retains old bytes and prevents same-key or new-key replay',async t=>{
 const {h,run,wave}=await interruptedTask(t),view=h.engine.executorCheckpointPreview(run.id),request={confirmed:true,previewHash:view.previewHash};h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_ONLY'}});
 const record=h.store.record.bind(h.store);h.store.record=(kind,...args)=>{if(kind==='ExecutorCheckpointPrepared')throw Error('OFFLINE_CHECKPOINT_COMMIT_FAILURE');return record(kind,...args);};
 try{await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,request,operation('interrupted'),actor),/OFFLINE_CHECKPOINT_COMMIT_FAILURE/);}finally{h.store.record=record;}
 assert.equal(h.store.run(run.id).state,'BLOCKED');assert.equal(readFileSync(resolve(wave.assignments[0].workspace,'a.txt'),'utf8'),'a1');assert.equal(h.store.records(run.projectId,'ExecutorCheckpointPrepared').length,0);
 await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,request,operation('interrupted'),actor),{code:'EXECUTOR_CHECKPOINT_RESULT_UNCERTAIN'});
 await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,request,operation('another-key'),actor),{code:'EXECUTOR_CHECKPOINT_RESULT_UNCERTAIN'});
});
test('unresolved tool effects and edits after the recorded write cannot become resumable checkpoints',async t=>{
 const {h,run,slices,a}=await interruptedTask(t),intent=h.store.record('ToolIntent',run.projectId,run.id,{tool:'desk_write',sliceId:a.id,specHash:run.specHash,sourceHash:treeHash(a.workspace),requestHash:'a'.repeat(64)});
 assert.throws(()=>slices.inspectCheckpoint(run.id),{code:'TOOL_RECOVERY_REQUIRED'});
 h.store.record('ToolResult',run.projectId,run.id,{intentId:intent,tool:'desk_write',sliceId:a.id,status:'FAILED_NO_EFFECT'});
 writeFileSync(resolve(a.workspace,'a.txt'),'outside the recorded write');assert.throws(()=>slices.inspectCheckpoint(run.id),{code:'EXECUTOR_CHECKPOINT_SOURCE_CHANGED'});
 assert.equal(readFileSync(resolve(run.workspace,'a.txt'),'utf8'),'a0');
});
test('a recovered seed changed before ordinary dispatch cannot be adopted as a fresh source baseline',async t=>{
 const {h,run,slices}=await interruptedTask(t),view=h.engine.executorCheckpointPreview(run.id);h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_ONLY'}});
 const result=await h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('seed-fence'),actor),manifest=JSON.parse(readFileSync(resolve(h.dir,'controller/executor-waves',run.id,result.newWaveId,'wave.json'),'utf8'));
 writeFileSync(resolve(manifest.assignments[0].workspace,'a.txt'),'unlogged edit before dispatch');const current=h.store.run(run.id);current.state='IMPLEMENTING';h.store.saveRun(current);
 assert.throws(()=>slices.prepare(run.id),{code:'EXECUTOR_CHECKPOINT_SOURCE_CHANGED'});
 assert.equal(h.store.records(run.projectId,'ExecutorSliceSealed').length,0);assert.equal(readFileSync(resolve(run.workspace,'a.txt'),'utf8'),'a0');
});
test('successful replay rejects additional excluded dependency directories in the canonical workspace',async t=>{
 const {h,run}=await interruptedTask(t),view=h.engine.executorCheckpointPreview(run.id),request={confirmed:true,previewHash:view.previewHash};h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_ONLY'}});
 await h.engine.prepareExecutorCheckpoint(run.id,request,operation('strict-replay'),actor);mkdirSync(resolve(run.workspace,'node_modules'));writeFileSync(resolve(run.workspace,'node_modules/hidden.js'),'uninspected bytes');
 await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,request,operation('strict-replay'),actor),{code:'EXECUTOR_SLICE_WRITE_DENIED'});
});
test('a recovered task cannot seal a file changed after its last settled tool',async t=>{
 const {h,run,slices}=await interruptedTask(t),view=h.engine.executorCheckpointPreview(run.id);h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_ONLY'}});
 const result=await h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('seal-fence'),actor),next=JSON.parse(readFileSync(resolve(h.dir,'controller/executor-waves',run.id,result.newWaveId,'wave.json'),'utf8')),a=next.assignments[0];
 const current=h.store.run(run.id);current.state='IMPLEMENTING';current.tasks[0].status='running';h.store.saveRun(current);
 const sourceHash=treeHash(a.workspace),intent=h.store.record('ToolIntent',run.projectId,run.id,{tool:'desk_read',sliceId:a.id,specHash:run.specHash,sourceHash,requestHash:'a'.repeat(64)});
 h.store.record('ToolResult',run.projectId,run.id,{intentId:intent,tool:'desk_read',sliceId:a.id,status:'COMPLETE',sourceHash});writeFileSync(resolve(a.workspace,'a.txt'),'unlogged late edit');
 assert.throws(()=>slices.seal(run.id,a.id),{code:'EXECUTOR_CHECKPOINT_SOURCE_CHANGED'});assert.equal(h.store.records(run.projectId,'ExecutorSliceSealed').length,0);
});

test('a third explicit recovery cannot create another copy or renew the task allowance',async t=>{
 const {h,run}=await interruptedTask(t);h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_ONLY'}});
 for(let attempt=1;attempt<=2;attempt++){
  const view=h.engine.executorCheckpointPreview(run.id);assert.equal(view.canPrepare,true);
  await h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('bounded-'+attempt),actor);
  // Simulate another interrupted turn only in this offline fixture; production state is never edited.
  const current=h.store.run(run.id);current.state='BLOCKED';current.reason='EXECUTOR_SLICE_RESULT_UNCERTAIN';h.store.saveRun(current);
 }
 const view=h.engine.executorCheckpointPreview(run.id),before=h.store.run(run.id),intents=h.store.records(run.projectId,'ExecutorCheckpointIntent').length;
 assert.equal(view.canPrepare,false);
 await assert.rejects(h.engine.prepareExecutorCheckpoint(run.id,{confirmed:true,previewHash:view.previewHash},operation('bounded-third'),actor),{code:'EXECUTOR_CHECKPOINT_LIMIT'});
 assert.deepEqual(h.store.run(run.id),before);assert.equal(h.store.owns(run.projectId,run.id),true);
 assert.equal(h.store.records(run.projectId,'ExecutorCheckpointIntent').length,intents);assert.equal(h.store.records(run.projectId,'ExecutorCheckpointPrepared').length,2);
});

for(const [kind,body] of [['sqlite',Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(112)])],['wal',Buffer.from([0x37,0x7f,0x06,0x82,0,0,0,0])]])test('a settled tool cannot turn '+kind+' bytes into a source-only recovery',async t=>{
 const {h,run,a}=await interruptedTask(t),before=treeHash(a.workspace);
 const intent=h.store.record('ToolIntent',run.projectId,run.id,{tool:'desk_write',sliceId:a.id,specHash:run.specHash,sourceHash:before,requestHash:hash('OFFLINE_DATABASE_'+kind)});
 writeFileSync(resolve(a.workspace,'a.txt'),body);
 h.store.record('ToolResult',run.projectId,run.id,{intentId:intent,tool:'desk_write',sliceId:a.id,status:'COMPLETE',sourceHash:treeHash(a.workspace)});
 assert.throws(()=>h.engine.executorCheckpointPreview(run.id),{code:'RECOVERY_DATABASE_UNREGISTERED'});
 assert.deepEqual(readFileSync(resolve(a.workspace,'a.txt')),body);assert.equal(h.store.run(run.id).state,'BLOCKED');assert.equal(h.store.owns(run.projectId,run.id),true);
 assert.equal(h.store.records(run.projectId,'ExecutorCheckpointIntent').length,0);assert.equal(h.store.records(run.projectId,'ExecutorCheckpointPrepared').length,0);
});
