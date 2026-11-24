// OFFLINE original Store and source-copy custody only. No model, account or Custom dispatch permit.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {harness,ready} from '../helpers.mjs';import {Store} from '../../dist/server/store.js';
import {ExecutorSlices} from '../../dist/server/flow/executor-slices.js';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {hash} from '../../dist/server/security.js';import {treeHash} from '../../dist/server/workspace.js';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {installOfflinePrework} from '../fixtures/offline-prework.mjs';
import * as roleSelection from '../../dist/server/flow/executor-slices.js';
const actor='local-session:'+'a'.repeat(64);
function configuration(readonly=false,extra=0){
 const role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write&&!readonly?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 return{mode:'custom',laya:false,accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('worker-left',true),role('worker-right',true),...Array.from({length:extra},(_,i)=>role('worker-extra-'+i,true))],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
}
async function rig(t,custom=false,readonly=false,extra=0,{laterWave=false,mode='demo'}={}){
 const h=harness(t),{p,s}=await ready(h);let prepared;
 if(custom){const profile=new FlowProfiles(h.store).confirm(p.id,{configuration:configuration(readonly,extra),expectedRevision:0,confirmed:true},actor,'OFFLINE_ROLE_PROFILE');prepared=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);}
 h.engine.launch=()=>{};const classic=h.engine.create(p.id,s.hash,true),run=structuredClone(classic);
 if(custom){h.store.release(p.id,classic.id);Object.assign(run,{id:prepared.flowConfig.runId,flowName:'custom',rolePolicy:'CUSTOM_FROZEN_V1',flowConfig:prepared.flowConfig,flowConfigHash:prepared.flowConfigHash,configFingerprint:prepared.flowConfig.configurationFingerprint,workspace:resolve(h.dir,'workspaces',prepared.flowConfig.runId)});}
 run.mode=mode;run.state=run.phase='IMPLEMENTING';run.tasks=Array.from({length:4},(_,i)=>({id:'T'+i,title:'OFFLINE task '+i,status:'pending',dependsOn:[],requirementIds:s.requirements.map(v=>v.id),acceptance:['OFFLINE'],writePaths:['file-'+i+'.txt']}));mkdirSync(run.workspace,{recursive:true});run.treeHash=treeHash(run.workspace);
 if(laterWave)run.tasks.push(...Array.from({length:4},(_,i)=>({...run.tasks[0],id:'NEXT'+i,dependsOn:run.tasks.map(task=>task.id),writePaths:['next-'+i+'.txt']})));
 if(custom){h.store.insertRun(run);h.store.acquire(p.id,run.id);const project=h.store.project(p.id);project.activeRunId=run.id;h.store.saveProject(project);}else h.store.saveRun(run);
 const planned=installOfflinePrework(h,run.id);
 return{h,run:planned,slices:new ExecutorSlices(h.store,h.dir)};
}
function rewrite(h,run,wave,edit){const path=resolve(wave.directory,'wave.json'),value=JSON.parse(readFileSync(path));edit(value);const bytes=Buffer.from(JSON.stringify(value));writeFileSync(path,bytes);const row=h.store.records(run.projectId,'ExecutorWavePrepared').find(r=>r.data.id===wave.id);h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...row.data,manifestHash:hash(bytes)}),row.id);return path;}
test('new Classic copies explicitly bind executor-1 without claiming another paid slot',async t=>{
 const {h,run,slices}=await rig(t),wave=slices.prepare(run.id);assert.deepEqual(wave.assignments.map(a=>a.executorRoleId),Array(4).fill('executor-1'));assert.equal(h.engine.activeJobCount,0);assert.equal(h.store.records(run.projectId,'AgentSession').length,0);
});
test('the same frozen role selection serves canonical turns and repairs rather than a hard-coded Custom actor',async t=>{
 const {h,run,slices}=await rig(t,true),wave=slices.prepare(run.id);
 assert.equal(roleSelection.executorRoleForTurn(run),'worker-left');assert.equal(roleSelection.executorRoleForTurn(run,wave.assignments[1]),'worker-right');
 assert.throws(()=>roleSelection.executorRoleForTurn(run,{...wave.assignments[0],executorRoleId:undefined}),{code:'EXECUTOR_ROLE_BINDING_CHANGED'});
});
test('frozen Custom actors survive original Store reopening without allowing Custom execution',async t=>{
 const {h,run,slices}=await rig(t,true),wave=slices.prepare(run.id);assert.deepEqual(wave.assignments.map(a=>a.executorRoleId),['worker-left','worker-right','worker-left','worker-right']);
 const reopened=new Store(h.store.path);try{assert.deepEqual(new ExecutorSlices(reopened,h.dir).pending(run.id),wave);}finally{reopened.close();}
 assert.throws(()=>h.engine.assertBinding(h.store.run(run.id)),{code:'CUSTOM_MAGPIE_SECURITY_REQUIRED'});assert.equal(h.store.records(run.projectId,'AgentSession').length,0);
});
test('read-only Custom actors cannot be assigned source-writing tasks',async t=>{
 const {h,run,slices}=await rig(t,true,true);assert.throws(()=>slices.prepare(run.id),{code:'EXECUTOR_ROLE_WRITE_PERMISSION_REQUIRED'});assert.equal(h.store.records(run.projectId,'ExecutorWavePrepared').length,0);
});
for(const missing of [false,true])test('Custom rejects a changed or absent actor even if its manifest anchor is replaced; missing='+missing,async t=>{
 const {h,run,slices}=await rig(t,true),wave=slices.prepare(run.id);rewrite(h,run,wave,value=>{if(missing)delete value.assignments[0].executorRoleId;else value.assignments[0].executorRoleId='worker-right';});assert.throws(()=>slices.pending(run.id),{code:'EXECUTOR_ROLE_BINDING_CHANGED'});
});
test('old Classic manifests remain byte-identical while being interpreted as the original default actor',async t=>{
 const {h,run,slices}=await rig(t),wave=slices.prepare(run.id),path=rewrite(h,run,wave,value=>{for(const assignment of value.assignments)delete assignment.executorRoleId;}),before=readFileSync(path);
 const old=slices.pending(run.id);assert.ok(old.assignments.every(a=>a.executorRoleId===undefined));assert.deepEqual(readFileSync(path),before);
});
test('later waves also assign configured actors beyond the first four',async t=>{
 const {h,run,slices}=await rig(t,true,false,4,{laterWave:true}),one=slices.prepare(run.id);
 for(const a of one.assignments){const current=h.store.run(run.id);current.tasks.find(task=>task.id===a.taskId).status='running';h.store.saveRun(current);slices.seal(run.id,a.id);}
 slices.merge(run.id,one.id,new AbortController().signal,()=>{},current=>{current.tasks=current.tasks.map(task=>one.assignments.some(a=>a.taskId===task.id)?{...task,status:'implemented'}:task);});
 const two=slices.prepare(run.id);assert.deepEqual(two.assignments.map(a=>a.executorRoleId),['worker-extra-2','worker-extra-3','worker-left','worker-right']);assert.deepEqual(slices.pending(run.id),two);
});
test('the original Engine passes and records the actor from its own assignment',async t=>{
 const {h,run,slices}=await rig(t,false,false,0,{mode:'live'}),wave=slices.prepare(run.id),assignment=wave.assignments[0];fixedControllerCapacity(h.engine);
 const current=h.store.run(run.id);let observed;
 h.engine.nativeExecution={assertReady(){},executor(input){observed=input;return{async run(){return{text:'OFFLINE_CONTROLLED_EXECUTOR_RESULT',sessionId:'OFFLINE_ACTOR_SESSION',model:h.config.dsh.model,usage:{role:'executor',costUsd:null,source:'OFFLINE_TEST',requestId:'OFFLINE_REQUEST'},identity:{runner:'DSH',provider:'deepseek-official',authentication:'API_KEY',model:h.config.dsh.model}};}};},async verify(){throw Error('OFFLINE_NO_VERIFIER');},async close(){}};
 await h.engine.role(current,'executor','OFFLINE task',new AbortController().signal,assignment.taskId,assignment.id);
 assert.equal(observed.executorRoleId,'executor-1');assert.equal(observed.executorSliceId,assignment.id);assert.equal(observed.workspace,assignment.workspace);
 const session=h.store.records(run.projectId,'AgentSession').at(-1).data;assert.equal(session.executorRoleId,'executor-1');assert.equal(session.sliceId,assignment.id);assert.equal(session.sessionId,'OFFLINE_ACTOR_SESSION');
 const grant=h.store.records(run.projectId,'DispatchGranted').at(-1).data;assert.equal(grant.executorRoleId,session.executorRoleId);
});
test('a source checkpoint retains the frozen Custom assignment and rotation cursor',async t=>{
 const {h,run,slices}=await rig(t,true,false,4),wave=slices.prepare(run.id),current=h.store.run(run.id);current.state='BLOCKED';current.reason='EXECUTOR_TASK_TOOL_LIMIT';h.store.saveRun(current);
 const preview=slices.inspectCheckpoint(run.id).view,result=slices.prepareCheckpoint(run.id,{confirmed:true,previewHash:preview.previewHash},hash('OFFLINE_ACTOR_CHECKPOINT'),actor,new AbortController().signal,'b'.repeat(64),()=>{});
 const next=JSON.parse(readFileSync(resolve(h.dir,'controller/executor-waves',run.id,result.newWaveId,'wave.json')));assert.equal(next.executorRoleOffset,wave.executorRoleOffset);assert.deepEqual(next.assignments.map(a=>a.executorRoleId),wave.assignments.map(a=>a.executorRoleId));assert.equal(h.engine.activeJobCount,0);assert.equal(result.modelsCalled,0);
});

test('OFFLINE prework rejects a supplied directory or database outside its isolated harness',t=>{
 const h=harness(t),outside=resolve(h.dir,'..');
 assert.throws(()=>installOfflinePrework({...h,dir:outside},'OFFLINE_NO_RUN_READ'),/OFFLINE fixture must stay inside/);
 assert.throws(()=>installOfflinePrework({...h,store:{path:outside}},'OFFLINE_NO_RUN_READ'),/OFFLINE fixture must stay inside/);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM records').get().n,0);
});
