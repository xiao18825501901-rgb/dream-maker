import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {treeHash} from '../../dist/server/workspace.js';
import {interruptedMerge} from '../fixtures/executor-recovery.mjs';
for(const [stage,expected,published]of [['UNCHANGED','SOURCE_UNCHANGED',0],['PARTIAL','PARTIALLY_PUBLISHED',1],['COMBINED','COMBINED_UNCOMMITTED',2]])test('read-only merge inspection classifies '+stage+' from actual bytes without a status mutation',async t=>{
 const {h,run,slices}=await interruptedMerge(t,stage),before=h.store.run(run.id),events=h.store.events(run.projectId,0),records=h.store.records(run.projectId),view=slices.inspectRecovery(run.id).view;
 assert.equal(view.sourceState,expected);assert.equal(view.publishedFiles,published);assert.equal(view.changedFiles,2);assert.equal(view.source.currentHash,treeHash(run.workspace));
 assert.equal(view.executionGranted,false);assert.equal(view.modelsCalled,0);assert.equal(view.automaticResume,false);assert.equal(view.canRestoreBase,true);
 assert.deepEqual(h.store.run(run.id),before);assert.deepEqual(h.store.events(run.projectId,0),events);assert.deepEqual(h.store.records(run.projectId),records);assert.equal(h.store.owns(run.projectId,run.id),true);
});
test('unknown external changes block both recovery actions and preserve business data',async t=>{
 const {run,slices,canary}=await interruptedMerge(t);writeFileSync(resolve(run.workspace,'a.txt'),'external user edit');
 const view=slices.inspectRecovery(run.id).view;assert.equal(view.sourceState,'EXTERNAL_CHANGE');assert.equal(view.canKeepFiles,false);assert.equal(view.canRestoreBase,false);assert.equal(readFileSync(canary,'utf8'),'OFFLINE_BUSINESS_DATA_KEEP');
});
test('changed base, combination and sealed task copies are never accepted as recovery authority',async t=>{
 const {run,slices,wave}=await interruptedMerge(t),path=resolve(wave.directory,'base/a.txt');writeFileSync(path,'bad base');assert.throws(()=>slices.inspectRecovery(run.id),{code:'EXECUTOR_SLICE_BASE_CHANGED'});
 writeFileSync(path,'a0');writeFileSync(resolve(wave.directory,'merged/b.txt'),'bad combination');assert.throws(()=>slices.inspectRecovery(run.id),{code:'MERGE_RECOVERY_COPY_CHANGED'});
 writeFileSync(resolve(wave.directory,'merged/b.txt'),'b1');writeFileSync(resolve(wave.assignments[0].workspace,'a.txt'),'late');assert.throws(()=>slices.inspectRecovery(run.id),{code:'EXECUTOR_SLICE_CHANGED'});
});
