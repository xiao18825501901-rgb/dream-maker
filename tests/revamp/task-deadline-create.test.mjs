// OFFLINE original Engine/Store; explicit fake qualification only. No Native or model evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready,bindOfflineApi} from '../helpers.mjs';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {Store} from '../../dist/server/store.js';
import {runDeadline,taskDeadlineWaiverEvidence} from '../../dist/server/review-window.js';
import {hash} from '../../dist/server/security.js';
import {reserveCall,checkDuration} from '../../dist/server/budget.js';
const actor='local-session:'+'a'.repeat(64);
async function fixture(t){
 const h=harness(t);bindOfflineApi(h.config);const {p,s}=await ready(h,'live');
 const account={provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'};
 const role=(id,write=false)=>({id,...account,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const configuration={mode:'custom',laya:false,accounts:[account],roles:{planner2:role('planner2'),executors:[role('executor-1',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_PROFILE');
 h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);
 h.engine.nativeExecution={assertCustomReady(){},custom(){throw Error('MODEL_FORBIDDEN');},verify(){throw Error('MODEL_FORBIDDEN');},async close(){}};
 const launches=[];h.engine.launch=id=>{
  const other=new Store(h.store.path);
  try{const r=other.run(id);launches.push({deadline:runDeadline(other,r),waiver:taskDeadlineWaiverEvidence(other,r)});}finally{other.close();}
 };
 return{...h,p,s,launches,create:(options={},who=actor)=>h.engine.create(p.id,s.hash,true,false,'custom',options,who)};
}
test('explicit no-deadline choice is durable before first launch without changing other limits',async t=>{
 const h=await fixture(t),r=h.create({taskDeadline:null});
 assert.equal(h.launches.length,1);assert.equal(h.launches[0].deadline,Infinity);
 const approval=h.launches[0].waiver;assert.equal(approval.sourceHashAtApproval,null);assert.equal(approval.actorHash,hash(actor));
 assert.equal(approval.originalCreatedAt,r.createdAt);assert.equal(r.maxSeconds,h.config.limits.maxSeconds);
 assert.equal(r.maxCalls,h.config.limits.maxCalls);assert.equal(r.maxRepairs,h.config.limits.maxRepairs);
 assert.equal(r.calls,0);assert.equal(r.repairCount,0);assert.equal(r.treeHash,null);
 const reopened=new Store(h.store.path);try{assert.equal(runDeadline(reopened,reopened.run(r.id)),Infinity);}finally{reopened.close();}
 assert.equal(h.store.records(h.p.id,'TaskDeadlineWaiverApproval').length,1);
 assert.equal(approval.modelDispatched,false);assert.equal(approval.technicalTimeoutsPreserved,true);
 t.mock.timers.enable({apis:['Date'],now:Date.parse(r.createdAt)+(r.maxSeconds+1)*1000});
 assert.doesNotThrow(()=>checkDuration(r,h.store));
 const exhausted={...r,calls:r.maxCalls};assert.throws(()=>reserveCall(exhausted),{code:'RUN_CALL_BUDGET_EXCEEDED'});
});
test('omitting the choice preserves the original finite product default',async t=>{
 const h=await fixture(t),r=h.create();assert.equal(h.launches[0].deadline,Date.parse(r.createdAt)+r.maxSeconds*1000);
 assert.equal(r.taskDeadlineWaiver,undefined);assert.equal(h.store.records(h.p.id,'TaskDeadlineWaiverApproval').length,0);
});
test('a model claim or missing actor cannot approve a no-deadline build',async t=>{
 const h=await fixture(t);
 for(const who of ['', 'MODEL_CLAIM', 'local-session:wrong'])assert.throws(()=>h.create({taskDeadline:null},who),{code:'TASK_DEADLINE_WAIVER_CONFIRMATION_REQUIRED'});
 assert.equal(h.store.runs(h.p.id).length,0);assert.equal(h.launches.length,0);
});
test('a task deadline must be explicitly null; numeric, string and undefined values do not create a run',async t=>{
 const h=await fixture(t);
 for(const value of [0,3600,false,'none',{},undefined])assert.throws(()=>h.create({taskDeadline:value}),{code:'TASK_DEADLINE_WAIVER_INPUT_INVALID'});
 assert.equal(h.store.runs(h.p.id).length,0);assert.equal(h.store.approved(h.p.id,h.s.hash,'BUILD'),false);
});
test('waiver persistence failure rolls back the run, lease, build approval and project pointer',async t=>{
 const h=await fixture(t),original=h.store.record.bind(h.store);
 h.store.record=(kind,...args)=>{if(kind==='TaskDeadlineWaiverApproval')throw Error('OFFLINE_PERSIST_FAILURE');return original(kind,...args);};
 assert.throws(()=>h.create({taskDeadline:null}),/OFFLINE_PERSIST_FAILURE/);
 assert.equal(h.store.runs(h.p.id).length,0);assert.equal(h.store.approved(h.p.id,h.s.hash,'BUILD'),false);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM workspace_leases WHERE project_id=?').get(h.p.id).n,0);
 assert.equal(h.store.project(h.p.id).activeRunId,null);assert.equal(h.launches.length,0);
});
test('unlimited task time cannot bypass Custom role qualification',async t=>{
 const h=await fixture(t);h.engine.nativeExecution.assertCustomReady=()=>{throw Error('OFFLINE_UNQUALIFIED');};
 assert.throws(()=>h.create({taskDeadline:null}),/OFFLINE_UNQUALIFIED/);
 assert.equal(h.store.runs(h.p.id).length,0);assert.equal(h.store.records(h.p.id,'TaskDeadlineWaiverApproval').length,0);
});
for(const failure of ['after_record','save_run','event'])test('late '+failure+' failure rolls back every approval and lease across reopen',async t=>{
 const h=await fixture(t),record=h.store.record.bind(h.store),save=h.store.saveRun.bind(h.store),event=h.store.event.bind(h.store);
 h.store.record=(kind,...args)=>{const id=record(kind,...args);if(failure==='after_record'&&kind==='TaskDeadlineWaiverApproval')throw Error('OFFLINE_LATE_FAILURE');return id;};
 h.store.saveRun=(r,...args)=>{save(r,...args);if(failure==='save_run')throw Error('OFFLINE_LATE_FAILURE');};
 h.store.event=(pid,rid,kind,...args)=>{const id=event(pid,rid,kind,...args);if(failure==='event'&&kind==='run.task-deadline-waiver.approved')throw Error('OFFLINE_LATE_FAILURE');return id;};
 assert.throws(()=>h.create({taskDeadline:null}),/OFFLINE_LATE_FAILURE/);
 const other=new Store(h.store.path);try{
  assert.equal(other.runs(h.p.id).length,0);assert.equal(other.records(h.p.id,'TaskDeadlineWaiverApproval').length,0);
  assert.equal(other.approved(h.p.id,h.s.hash,'BUILD'),false);assert.equal(other.project(h.p.id).activeRunId,null);
  assert.equal(other.db.prepare('SELECT count(*) n FROM workspace_leases WHERE project_id=?').get(h.p.id).n,0);
 }finally{other.close();}assert.equal(h.launches.length,0);
});
test('a post-commit launch failure leaves one coherent recoverable run and no duplicate on retry',async t=>{
 const h=await fixture(t);h.engine.launch=()=>{throw Error('OFFLINE_LAUNCH_FAILURE');};
 assert.throws(()=>h.create({taskDeadline:null}),/OFFLINE_LAUNCH_FAILURE/);
 const [r]=h.store.runs(h.p.id);assert.ok(r);assert.equal(runDeadline(h.store,r),Infinity);
 assert.equal(h.store.project(h.p.id).activeRunId,r.id);assert.equal(h.store.records(h.p.id,'TaskDeadlineWaiverApproval').length,1);
 assert.throws(()=>h.create({taskDeadline:null}),{code:'FLOW_TERMINATION_REQUIRED'});
 assert.equal(h.store.runs(h.p.id).length,1);
});
test('Demo cannot acquire a Live deadline approval',async t=>{
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{throw Error('MUST_NOT_LAUNCH');};
 assert.throws(()=>h.engine.create(p.id,s.hash,true,false,'classic',{taskDeadline:null},actor),{code:'TASK_DEADLINE_WAIVER_BINDING_INVALID'});
 assert.equal(h.store.runs(p.id).length,0);assert.equal(h.store.records(p.id,'TaskDeadlineWaiverApproval').length,0);
});
