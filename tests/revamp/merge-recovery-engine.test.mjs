// Real private SQLite/F files; OFFLINE admission, no product agents, review or paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {interruptedMerge} from '../fixtures/executor-recovery.mjs';
const actor='local-session:'+'d'.repeat(64),operation=name=>hash('OFFLINE_MERGE_RECOVERY_'+name);
const request=(view,choice)=>({choice,previewHash:view.previewHash,expectedHash:view.source.currentHash,confirmed:true});
for(const choice of ['KEEP_FILES_AND_END','RESTORE_BASE_AND_END'])test(choice+' ends the old Flow after actual source checks while retaining every copy',async t=>{
 const {h,run,slices,wave,canary}=await interruptedMerge(t),view=h.engine.mergeRecoveryPreview(run.id),before=treeHash(run.workspace),approvals=h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all(),plans=h.store.planVersions(run.projectId),usage=h.store.run(run.id).usage;
 const result=await h.engine.recoverMerge(run.id,request(view,choice),operation(choice),actor);
 assert.equal(result.choice,choice);assert.equal(result.flowEnded,true);assert.equal(result.originalMergeApplied,false);assert.equal(result.businessDataChanged,false);assert.equal(result.modelsCalled,0);assert.equal(result.automaticResume,false);
 assert.equal(h.store.run(run.id).state,'CANCELLED');assert.equal(h.store.owns(run.projectId,run.id),false);assert.equal(slices.hasUncertainMerge(run.id),false);
 assert.equal(treeHash(run.workspace),choice==='RESTORE_BASE_AND_END'?view.source.baseHash:before);assert.equal(readFileSync(resolve(run.workspace,'a.txt'),'utf8'),choice==='RESTORE_BASE_AND_END'?'a0':'a1');
 assert.equal(readFileSync(canary,'utf8'),'OFFLINE_BUSINESS_DATA_KEEP');assert.equal(readFileSync(resolve(wave.directory,'base/a.txt'),'utf8'),'a0');assert.equal(readFileSync(resolve(wave.directory,'merged/b.txt'),'utf8'),'b1');
 assert.deepEqual(h.store.db.prepare('SELECT * FROM approvals ORDER BY rowid').all(),approvals);assert.deepEqual(h.store.planVersions(run.projectId),plans);assert.deepEqual(h.store.run(run.id).usage,usage);assert.equal(h.store.records(run.projectId,'ExecutorMergeApplied').length,0);
 const replay=await h.engine.recoverMerge(run.id,request(view,choice),operation(choice),actor);assert.equal(replay.replayed,true);assert.equal(h.store.records(run.projectId,'ExecutorMergeRecovered').length,1);
 assert.ok(readdirSync(wave.directory).some(name=>name.startsWith('recovery_')));
 writeFileSync(resolve(run.workspace,'a.txt'),'later user data');await assert.rejects(h.engine.recoverMerge(run.id,request(view,choice),operation(choice),actor),{code:'MERGE_RECOVERY_SOURCE_CHANGED'});assert.equal(readFileSync(resolve(run.workspace,'a.txt'),'utf8'),'later user data');
});
test('consent, current source, active jobs and unresolved OS ownership cannot be bypassed by a recovery request',async t=>{
 const {h,run}=await interruptedMerge(t),view=h.engine.mergeRecoveryPreview(run.id),input=request(view,'RESTORE_BASE_AND_END'),before=treeHash(run.workspace);
 await assert.rejects(h.engine.recoverMerge(run.id,{...input,confirmed:false},operation('no-consent'),actor),{code:'MERGE_RECOVERY_CONSENT_REQUIRED'});
 await assert.rejects(h.engine.recoverMerge(run.id,{...input,expectedHash:'0'.repeat(64)},operation('stale'),actor),{code:'MERGE_RECOVERY_SOURCE_CHANGED'});
 h.engine.jobs.set(run.id,{controller:new AbortController(),promise:Promise.resolve()});await assert.rejects(h.engine.recoverMerge(run.id,input,operation('active'),actor),{code:'PROCESS_OWNERSHIP_ACTIVE'});h.engine.jobs.delete(run.id);
 h.engine.ownershipProofs=()=>({ok:false,reasons:['OFFLINE_UNPROVEN'],evidence:{}});await assert.rejects(h.engine.recoverMerge(run.id,input,operation('unproven'),actor),{code:'PROCESS_OWNERSHIP_UNPROVEN'});
 assert.equal(treeHash(run.workspace),before);assert.equal(h.store.owns(run.projectId,run.id),true);
});
