// OFFLINE_TEST only: original Engine/Store/dispatch, seeded admission and a controller-only fake runner.
// No fixture receipt is installed in a product database, and no model/Native acceptance is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {JsonDatasets} from '../../dist/server/json-data.js';
import {Engine} from '../../dist/server/engine.js';
import {hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {harness,ready,root,until} from '../helpers.mjs';
import {fixedControllerCapacity,fixtureEntered} from '../fixtures/controller-capacity.mjs';
import {inProcessDemoVerifier} from '../fixtures/in-process-demo-verifier.mjs';
const actor='local-session:'+'c'.repeat(64),op=name=>hash('OFFLINE_JSON_RUNTIME_'+name);
const latch=()=>{let release;return {promise:new Promise(r=>release=r),release:()=>release()};};
async function setup(t,action){
 const h=harness(t);fixedControllerCapacity(h.engine);inProcessDemoVerifier(h);const {p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);
 const baseline=h.store.run(created.id);
 assert.equal(baseline.state,'READY_FOR_DELIVERY','OFFLINE_DEMO_BASELINE_NOT_DELIVERED '+JSON.stringify({state:baseline.state,phase:baseline.phase,reason:baseline.reason,calls:baseline.calls,verificationOk:baseline.verification?.ok}));
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);
 const run=h.store.run(created.id);run.mode='live';run.review={...run.review,source:'CODEX'};
 run.plan={...run.plan,dataRuntime:{schema:'dream-maker.json-runtime-plan.v1',protocol:'JSON_DOCUMENT_V1',runtime:'node',entry:'data.mjs',args:[]}};
 h.store.saveRun(run);const data=new JsonDatasets(h.store,root);data.write(run.id,run.treeHash,{count:1},0,op('initial'),actor);
 let calls=0;h.engine.nativeExecution={assertReady(){},executor(){throw Error('NO_MODELS');},verify(){throw Error('NO_VERIFIER');},async close(){},async runData(input){
  calls++;if(action)await action(input);const raw=JSON.parse(input.command.stdin);
  return {schema:'dream-maker.wsl-result.v1',sourceHash:input.sourceHash,status:'EXECUTED',exitCode:0,stdout:JSON.stringify({schema:'dream-maker.json-runtime-output.v1',inputHash:raw.inputHash,expectedRevision:raw.revision,document:{count:raw.document.count+1}}),stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true}};
 }};
 return {h,p,s,run,data,calls:()=>calls,execute:(name='one',revision=1)=>h.engine.executeJsonData(run.id,run.treeHash,revision,true,op(name),actor)};
}

test('original Engine dispatches deterministic JSON, commits only data and replays without execution',async t=>{
 const {h,p,run,data,calls,execute}=await setup(t),source=treeHash(run.workspace),budget=structuredClone(h.store.run(run.id).usage),recordCount=h.store.records(p.id).length;
 const result=await execute();assert.deepEqual(result.document,{count:2});assert.equal(result.revision,2);
 assert.equal(h.engine.activeJobCount,0);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');assert.equal(treeHash(run.workspace),source);assert.deepEqual(h.store.run(run.id).usage,budget);
 const ticket=h.store.records(p.id,'DispatchQueued').find(row=>row.data.kind==='data-runtime');assert.equal(ticket.data.demand.externalModelSlots,0);assert.equal(ticket.data.demand.verifierSlots,1);
 assert.equal(h.store.db.prepare('SELECT origin FROM managed_dataset_versions WHERE project_id=? AND revision=2').get(p.id).origin,'RUNTIME_RESULT');
 data.write(run.id,run.treeHash,{count:99},2,op('later-edit'),actor);
 const replay=await execute();assert.equal(replay.operation.replayed,true);assert.equal(replay.operation.appliedRevision,2);assert.equal(replay.document.count,99);assert.equal(calls(),1);
 assert.doesNotMatch(JSON.stringify(h.store.records(p.id).slice(recordCount)),/"document"|"stdout"|"count":2/);assert.doesNotMatch(JSON.stringify(h.store.db.prepare('SELECT response FROM requests').all()),/"document"|"count"/);
});

test('concurrent edit wins CAS and a failed runtime request cannot automatically execute again',async t=>{
 const gate=latch(),entered=latch(),{h,run,data,calls,execute}=await setup(t,async()=>{entered.release();await gate.promise;});
 const work=execute('conflict'),rejection=assert.rejects(work,{code:'JSON_DATA_CONFLICT'});await fixtureEntered(entered.promise,work,gate.release);
 assert.equal(h.engine.activeJobCount,1);data.write(run.id,run.treeHash,{count:88},1,op('concurrent'),actor);gate.release();await rejection;
 assert.equal(data.read(run.projectId).document.count,88);await assert.rejects(execute('conflict'),{code:'REQUEST_RESULT_UNCERTAIN'});assert.equal(calls(),1);
});

test('source change during runtime fences the late output before writing a version',async t=>{
 const gate=latch(),entered=latch(),{h,run,data,execute}=await setup(t,async()=>{entered.release();await gate.promise;});
 const work=execute('fenced'),rejection=assert.rejects(work,{code:'DISPATCH_RESULT_FENCED'});await fixtureEntered(entered.promise,work,gate.release);
 writeFileSync(resolve(run.workspace,'changed.txt'),'external change');gate.release();await rejection;
 assert.equal(data.read(run.projectId).revision,1);assert.equal(h.engine.dispatchStatus().quarantined.length,0);
});

test('pause cancels data work and waits for cleanup without cancelling the delivered Flow',async t=>{
 const gate=latch(),entered=latch(),{h,run,data,execute}=await setup(t,async()=>{entered.release();await gate.promise;});
 const work=execute('pause'),rejection=assert.rejects(work);await fixtureEntered(entered.promise,work,gate.release);let finished=false;
 const pause=h.engine.pauseAll().then(()=>{finished=true;});await new Promise(r=>setImmediate(r));assert.equal(finished,false);
 gate.release();await Promise.all([pause,rejection]);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');assert.equal(data.read(run.projectId).revision,1);assert.equal(h.engine.activeJobCount,0);
 await assert.rejects(execute('after-pause'),{code:'APPLICATION_PAUSING'});
});

test('runtime requires current admission, explicit consent and a native factory before launch',async t=>{
 const {h,run,data,execute,calls}=await setup(t);h.engine.nativeExecution.assertReady=()=>{throw Object.assign(Error('offline blocked'),{code:'NATIVE_INTEGRATION_BLOCKED'});};
 await assert.rejects(execute('blocked'),{code:'NATIVE_INTEGRATION_BLOCKED'});
 await assert.rejects(h.engine.executeJsonData(run.id,run.treeHash,1,false,op('no-consent'),actor),{code:'JSON_DATA_CONSENT_REQUIRED'});
 assert.equal(calls(),0);assert.equal(data.read(run.projectId).revision,1);assert.equal(h.store.db.prepare('SELECT count(*) n FROM requests').get().n,0);
});

test('missing baseline verification still blocks data changes and runner dispatch',async t=>{
 const {h,run,data,execute,calls}=await setup(t),current=h.store.run(run.id);
 assert.match(current.verification.stdout,/OFFLINE_IN_PROCESS_DEMO_VERIFIER/);
 current.verification=null;h.store.saveRun(current);
 assert.throws(()=>data.write(run.id,run.treeHash,{count:9},1,op('invalid-baseline'),actor),{code:'JSON_DATA_SOURCE_UNVERIFIED'});
 await assert.rejects(execute('invalid-baseline'),{code:'JSON_DATA_SOURCE_UNVERIFIED'});
 assert.equal(data.read(run.projectId).revision,1);assert.equal(calls(),0);
});

for(const state of ['READY_FOR_DELIVERY','ACCEPTED'])test('restart retains '+state+' and refuses unproven data cleanup without changing the original Flow',async t=>{
 const {h,p,run,data}=await setup(t),current=h.store.run(run.id);current.state=state;h.store.saveRun(current);
 const scope={dispatchId:'dispatch_offline_data_recovery',generation:'offline-test',kind:'data-runtime',mode:'live'};
 h.store.record('DispatchGranted',p.id,run.id,scope);h.store.record('OwnedProcessIntent',p.id,run.id,{...scope,processId:'offline-unknown-child'});
 const restarted=new Engine(h.store,h.laya,()=>h.config,root,h.dir,0);restarted.recover();
 assert.equal(h.store.run(run.id).state,state);await assert.rejects(restarted.reconcile(run.id),{code:'DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED'});
 assert.equal(h.store.run(run.id).state,state);assert.equal(data.read(p.id).revision,1);assert.equal(restarted.dispatchStatus().quarantined.length,1);
 await assert.rejects(restarted.close(),{code:'ENGINE_CLOSE_UNCERTAIN'});
});
