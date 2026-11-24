// OFFLINE_TEST: actual Store and F files. No model/role/OS-isolation acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWritePaths,selectExecutorWave,ExecutorSlices} from '../../dist/server/flow/executor-slices.js';
import {executorWaveReservation,assertExecutorStageGrowth} from '../../dist/server/flow/executor-slices.js';
import {validatePlan} from '../../dist/server/engine.js';
import {harness,ready} from '../helpers.mjs';
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {treeHash} from '../../dist/server/workspace.js';
const task=(id,writePaths,dependsOn=[])=>({id,title:id,dependsOn,requirementIds:['R1'],acceptance:['observable'],status:'pending',writePaths});
test('explicit source scopes survive plan validation and directory overlaps serialize the wave',()=>{
 const tasks=[task('A',['src/a.ts']),task('B',['src/b.ts']),task('C',['src/']),task('D',['view.ts'],['A'])];
 const plan=validatePlan({tasks},['R1']);assert.deepEqual(plan[0].writePaths,['src/a.ts']);
 assert.deepEqual(selectExecutorWave(plan).map(x=>x.id),['A','B']);
 plan[0].status='implemented';plan[1].status='implemented';assert.deepEqual(selectExecutorWave(plan).map(x=>x.id),['C','D']);
});
test('write scope rejects root, wildcard, traversal, case aliases, credentials and Windows special names',()=>{
 for(const scope of [[],['.'],['/'],['../outside'],['src/../x'],['src\\x'],['src//x'],['C:/x'],['src/*'],['.env'],['nested/AUTH.JSON'],['.git/'],['node_modules/'],['CON.txt'],['src/x.'],['src/x '],['src\u0000x'],['a','A']])assert.throws(()=>validateWritePaths(scope),{code:'EXECUTOR_WRITE_SCOPE_INVALID'},JSON.stringify(scope));
 assert.deepEqual(validateWritePaths(['src/','README.md']),['src/','README.md']);
 assert.equal(validatePlan({tasks:[{...task('L',['a']),writePaths:undefined}]},['R1'])[0].writePaths,undefined);
});
test('wave uses already completed dependencies only and has a hard four-assignment limit',()=>{
 const tasks=Array.from({length:8},(_,i)=>task('T'+i,['file'+i+'.ts']));
 assert.equal(selectExecutorWave(tasks).length,4);
 tasks[0].dependsOn=['T1'];assert.deepEqual(selectExecutorWave(tasks).map(x=>x.id),['T1','T2','T3','T4']);
 assert.deepEqual(selectExecutorWave([task('old',undefined)]),[]);
});
test('space admission reserves task growth and refuses a 500MB pool before an empty-source wave',()=>{
 const reservation=executorWaveReservation(0,1);assert.equal(reservation,64000000);
 assert.throws(()=>assertExecutorStageGrowth(500000000,reservation),{code:'EXECUTOR_SLICE_STORAGE_LIMIT'});
 assertExecutorStageGrowth(511999999,1);assert.throws(()=>assertExecutorStageGrowth(512000000,1),{code:'EXECUTOR_SLICE_STORAGE_LIMIT'});
 for(const bad of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>assertExecutorStageGrowth(1,bad));
});
async function rig(t){
 const h=harness(t),{p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);h.engine.pause(created.id);await h.engine.settled(created.id);
 const run=h.store.run(created.id);run.state=run.phase='IMPLEMENTING';run.tasks=[task('A',['a.txt']),task('B',['b.txt'])];
 mkdirSync(run.workspace,{recursive:true});writeFileSync(resolve(run.workspace,'a.txt'),'old a');writeFileSync(resolve(run.workspace,'b.txt'),'old b');run.treeHash=treeHash(run.workspace);h.store.saveRun(run);
 const slices=new ExecutorSlices(h.store,h.dir),wave=slices.prepare(run.id);
 const start=id=>{const r=h.store.run(run.id);r.tasks=r.tasks.map(t=>t.id===id?{...t,status:'running'}:t);h.store.saveRun(r);};
 const merge=()=>slices.merge(run.id,wave.id,new AbortController().signal,()=>{},(r,sourceHash)=>{r.treeHash=sourceHash;r.tasks=r.tasks.map(t=>({...t,status:'implemented'}));});
 return {h,p,run,slices,wave,start,merge};
}
test('separate task copies combine exact allowed deltas while original source remains frozen until merge',async t=>{
 const {h,run,slices,wave,start,merge}=await rig(t),before=treeHash(run.workspace);
 assert.equal(wave.assignments.length,2);assert.notEqual(wave.assignments[0].workspace,wave.assignments[1].workspace);
 for(const a of wave.assignments){start(a.taskId);writeFileSync(resolve(a.workspace,a.taskId==='A'?'a.txt':'b.txt'),'new '+a.taskId);slices.seal(run.id,a.id);}
 assert.equal(treeHash(run.workspace),before);const result=merge();assert.equal(result.sourceHash,treeHash(run.workspace));
 assert.equal(readFileSync(resolve(run.workspace,'a.txt'),'utf8'),'new A');assert.equal(readFileSync(resolve(run.workspace,'b.txt'),'utf8'),'new B');
 assert.equal(h.store.records(run.projectId,'ExecutorMergeApplied').length,1);assert.ok(h.store.run(run.id).tasks.every(t=>t.status==='implemented'));
 assert.throws(()=>slices.assignment(run.id,wave.assignments[0].id),{code:'EXECUTOR_SLICE_CLOSED'});
});
test('out-of-scope edits, stale main source and modified sealed output cannot be merged',async t=>{
 const {run,slices,wave,start,merge}=await rig(t),a=wave.assignments[0];start(a.taskId);
 writeFileSync(resolve(a.workspace,'b.txt'),'not owned');assert.throws(()=>slices.seal(run.id,a.id),{code:'EXECUTOR_SLICE_WRITE_DENIED'});
 writeFileSync(resolve(a.workspace,'b.txt'),'old b');slices.seal(run.id,a.id);start('B');slices.seal(run.id,wave.assignments[1].id);
 writeFileSync(resolve(a.workspace,'a.txt'),'late');assert.throws(merge,{code:'EXECUTOR_SLICE_CHANGED'});
 writeFileSync(resolve(a.workspace,'a.txt'),'old a');writeFileSync(resolve(run.workspace,'outside.txt'),'new external');assert.throws(merge,{code:'EXECUTOR_SOURCE_CHANGED'});
});
test('a durable uncommitted merge blocks later assignment and retains base recovery bytes',async t=>{
 const {h,run,slices,wave,start,merge}=await rig(t);
 for(const a of wave.assignments){start(a.taskId);writeFileSync(resolve(a.workspace,a.taskId==='A'?'a.txt':'b.txt'),'new '+a.taskId);slices.seal(run.id,a.id);}
 const record=h.store.record.bind(h.store);h.store.record=(kind,...args)=>{if(kind==='ExecutorMergeApplied')throw Error('OFFLINE_SQLITE_COMMIT_FAILURE');return record(kind,...args);};
 assert.throws(merge,/OFFLINE_SQLITE_COMMIT_FAILURE/);h.store.record=record;
 assert.equal(slices.hasUncertainMerge(run.id),true);assert.equal(h.store.owns(run.projectId,run.id),true);
 assert.equal(readFileSync(resolve(wave.directory,'base/a.txt'),'utf8'),'old a');
 assert.throws(()=>slices.assignment(run.id,wave.assignments[0].id),{code:'EXECUTOR_MERGE_RESULT_UNCERTAIN'});
});
test('an unresolved tool effect cannot be sealed into a successful task result',async t=>{
 const {h,run,slices,wave,start}=await rig(t),a=wave.assignments[0];start(a.taskId);
 h.store.record('ToolIntent',run.projectId,run.id,{sliceId:a.id,sourceHash:run.treeHash,tool:'desk_write'});
 assert.throws(()=>slices.seal(run.id,a.id),{code:'TOOL_RECOVERY_REQUIRED'});
 assert.equal(slices.sealed(run.id,a.id),undefined);
});
test('incomplete wave directories count toward the per-run limit',async t=>{
 const {h,run,slices,wave,start,merge}=await rig(t);for(const a of wave.assignments){start(a.taskId);slices.seal(run.id,a.id);}merge();
 const r=h.store.run(run.id);r.tasks=r.tasks.map(t=>({...t,status:'pending'}));h.store.saveRun(r);
 for(let i=0;i<31;i++)mkdirSync(resolve(wave.directory,'..','incomplete_'+i));
 assert.throws(()=>slices.prepare(run.id),{code:'EXECUTOR_SLICE_WAVE_LIMIT'});
});
test('ignored dependency and Git directories are rejected at seal and after sealing',async t=>{
 const {run,slices,wave,start}=await rig(t),a=wave.assignments[0];start(a.taskId);
 mkdirSync(resolve(a.workspace,'.git'));writeFileSync(resolve(a.workspace,'.git/config'),'outside declared scope');
 assert.throws(()=>slices.seal(run.id,a.id),{code:'EXECUTOR_SLICE_WRITE_DENIED'});rmSync(resolve(a.workspace,'.git'),{recursive:true});slices.seal(run.id,a.id);
 mkdirSync(resolve(a.workspace,'node_modules'));writeFileSync(resolve(a.workspace,'node_modules/hidden'),'late');
 assert.throws(()=>slices.prepare(run.id),{code:'EXECUTOR_SLICE_WRITE_DENIED'});
});
test('credential-looking ordinary filenames retain their exact redaction-safe source binding',async t=>{
 const {h,run,slices,wave,start,merge}=await rig(t);for(const a of wave.assignments){start(a.taskId);slices.seal(run.id,a.id);}merge();
 const r=h.store.run(run.id);r.tasks=[task('N',['sk-controller.ts'])];writeFileSync(resolve(r.workspace,'sk-controller.ts'),'ordinary source');r.treeHash=treeHash(r.workspace);h.store.saveRun(r);
 const next=slices.prepare(run.id),current=h.store.run(run.id);current.tasks[0].status='running';h.store.saveRun(current);
 assert.equal(slices.assignment(run.id,next.assignments[0].id).workspace,next.assignments[0].workspace);
 const row=h.store.records(r.projectId,'ExecutorWavePrepared').at(-1);assert.ok(row.data.manifestHash);assert.equal(JSON.stringify(row.data).includes('sk-controller'),false);
});
test('directory types cannot be replaced after publication intent',async t=>{
 const {h,run,slices,wave,start,merge}=await rig(t);for(const a of wave.assignments){start(a.taskId);slices.seal(run.id,a.id);}merge();
 const r=h.store.run(run.id);r.tasks=[task('TYPE',['p','p/'])];mkdirSync(resolve(r.workspace,'p'));writeFileSync(resolve(r.workspace,'p/old.txt'),'keep old');r.treeHash=treeHash(r.workspace);h.store.saveRun(r);
 const next=slices.prepare(run.id),a=next.assignments[0],current=h.store.run(run.id);current.tasks[0].status='running';h.store.saveRun(current);rmSync(resolve(a.workspace,'p'),{recursive:true});writeFileSync(resolve(a.workspace,'p'),'a file');slices.seal(run.id,a.id);
 assert.throws(()=>slices.merge(run.id,next.id,new AbortController().signal,()=>{},()=>{}),{code:'EXECUTOR_SLICE_PATH_CONFLICT'});
 assert.equal(slices.hasUncertainMerge(run.id),false);assert.equal(readFileSync(resolve(r.workspace,'p/old.txt'),'utf8'),'keep old');
});
