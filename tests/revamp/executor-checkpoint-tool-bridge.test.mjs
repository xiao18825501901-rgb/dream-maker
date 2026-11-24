// OFFLINE controller/file bridge using the existing read-only Archon module. No product model or OS worker.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {interruptedTask} from '../fixtures/interrupted-task.mjs';import {createExecutorTools} from '../../dist/server/executor-tools.js';import {hash} from '../../dist/server/security.js';
const archon='C:/Users/Hp/Documents/Archon_Astra_DSH_Source_Package/Archon_Astra_DSH_Source_Package',module=resolve(archon,'dist/provider/file-tools.js'),io=resolve(archon,'dist/core/io.js');
const binding={modulePath:module,dependencies:[{path:module,sha256:hash(readFileSync(module))},{path:io,sha256:hash(readFileSync(io))}],readPaths:['a.txt','b.txt'],writePaths:['a.txt','b.txt']};
async function prepared(t){const f=await interruptedTask(t),view=f.h.engine.executorCheckpointPreview(f.run.id);f.h.engine.ownershipProofs=()=>({ok:true,evidence:{scope:'OFFLINE_ONLY'}});
 const result=await f.h.engine.prepareExecutorCheckpoint(f.run.id,{confirmed:true,previewHash:view.previewHash},hash('OFFLINE_BRIDGE_'+f.run.id),'local-session:'+'a'.repeat(64));
 const wave=JSON.parse(readFileSync(resolve(f.h.dir,'controller/executor-waves',f.run.id,result.newWaveId,'wave.json'),'utf8')),r=f.h.store.run(f.run.id);r.state='IMPLEMENTING';r.tasks[0].status='running';f.h.store.saveRun(r);return{...f,next:wave};}
const kernel={run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}},signal=()=>new AbortController().signal;
test('retained source accepts journaled file edits and can later merge without inventing task completion',async t=>{
 const {h,run,slices,next,wave}=await prepared(t),a=next.assignments[0],tools=await createExecutorTools(h.store,()=>h.config,run.id,binding,kernel,a.id),read=await tools.dispatch('executor','desk_read',{path:'a.txt'},signal());
 assert.equal(read.content,'a1');await tools.dispatch('executor','desk_write',{path:'a.txt',content:'a2',expected_sha:read.sha256},signal());slices.seal(run.id,a.id);
 const r=h.store.run(run.id);r.tasks[1].status='running';h.store.saveRun(r);slices.seal(run.id,next.assignments[1].id);
 slices.merge(run.id,next.id,signal(),()=>{},(current,sourceHash)=>{current.treeHash=sourceHash;current.tasks=current.tasks.map(task=>({...task,status:'implemented'}));});
 assert.equal(readFileSync(resolve(run.workspace,'a.txt'),'utf8'),'a2');assert.equal(readFileSync(resolve(wave.assignments[0].workspace,'a.txt'),'utf8'),'a1');assert.ok(h.store.run(run.id).tasks.every(task=>task.status==='implemented'));assert.equal(h.store.run(run.id).review,null);
});
test('the file-tool factory rejects a changed retained seed before adopting disk contents',async t=>{
 const {h,run,next}=await prepared(t),a=next.assignments[0];writeFileSync(resolve(a.workspace,'a.txt'),'unlogged bytes');await assert.rejects(createExecutorTools(h.store,()=>h.config,run.id,binding,kernel,a.id),{code:'EXECUTOR_CHECKPOINT_SOURCE_CHANGED'});
});
test('explicit recovery gets a bounded new allowance and reconnecting it does not replenish eight calls',async t=>{
 const {h,run,next}=await prepared(t),a=next.assignments[0],tools=await createExecutorTools(h.store,()=>h.config,run.id,binding,kernel,a.id);
 for(let i=0;i<8;i++)assert.equal((await tools.dispatch('executor','desk_read',{path:'a.txt'},signal())).content,'a1');
 const reopened=await createExecutorTools(h.store,()=>h.config,run.id,binding,kernel,a.id);await assert.rejects(reopened.dispatch('executor','desk_read',{path:'a.txt'},signal()),{code:'EXECUTOR_TASK_TOOL_LIMIT'});
 assert.equal(h.store.records(run.projectId,'ToolIntent').filter(row=>row.runId===run.id&&row.data.sliceId===a.id).length,8);
});
