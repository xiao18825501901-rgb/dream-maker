// OFFLINE original Store/Engine/Dispatch; all runtime/review identities are explicit fixtures.
// Never a model response, formal qualification, process cleanup proof or Live acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready,root,bindOfflineApi} from '../helpers.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {JsonDatasets} from '../../dist/server/json-data.js';
import {hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
const actor='local-session:'+'a'.repeat(64);
async function setup(t){
 const h=harness(t);fixedControllerCapacity(h.engine);bindOfflineApi(h.config);const {p,s}=await ready(h,'live');
 const account={provider:'deepseek-official',authentication:'api_key',authRef:'OFFLINE_JSON_AUTH',accountRef:'OFFLINE_JSON_ACCOUNT'};
 const role=(id,write=false)=>({id,...account,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const configuration={mode:'custom',laya:false,accounts:[account],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_CUSTOM_JSON_PROFILE');
 h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);h.engine.launch=()=>{};
 const calls={classic:0,custom:0,worker:0};
 h.engine.nativeExecution={assertReady(){calls.classic++;throw Error('CLASSIC_QUALIFICATION_MUST_NOT_RUN');},assertCustomReady(snapshot){calls.custom++;assert.equal(snapshot.mode,'custom');},executor(){throw Error('NO_EXECUTOR_MODEL');},custom(){throw Error('NO_CUSTOM_MODEL');},verify(){throw Error('NO_VERIFIER');},async close(){},async runData(input){
  calls.worker++;assert.equal(currentProcessOwnership().runId,input.runId);const raw=JSON.parse(input.command.stdin);
  return{status:'EXECUTED',exitCode:0,sourceHash:input.sourceHash,stdout:JSON.stringify({schema:'dream-maker.json-runtime-output.v1',inputHash:raw.inputHash,expectedRevision:raw.revision,document:{count:raw.document.count+1}})};
 }};
 const created=h.engine.create(p.id,s.hash,true,false,'custom');h.store.release(p.id,created.id);const run=h.store.run(created.id);
 run.state='READY_FOR_DELIVERY';run.phase='REVIEWING';run.treeHash=treeHash(run.workspace);
 run.verification={ok:true,exitCode:0,command:[],stdout:'',stderr:'',treeHash:run.treeHash,at:'2026-11-12T00:00:00Z',evidenceId:'OFFLINE_VERIFIER'};
 run.plan={...run.plan,dataRuntime:{schema:'dream-maker.json-runtime-plan.v1',protocol:'JSON_DOCUMENT_V1',runtime:'node',entry:'data.mjs',args:[]}};
 run.sessions.reviewer='OFFLINE_JSON_REVIEWER_SESSION';
 run.roleIdentities={...(run.roleIdentities??{}),reviewer:{runner:'DSH',runtime:'dsh',provider:account.provider,authentication:'API_KEY',model:'deepseek-flash',roleId:'reviewer',authRef:account.authRef,accountRef:account.accountRef,configurationHash:run.flowConfigHash,routeHash:hash('OFFLINE_JSON_ROUTE'),sessionId:run.sessions.reviewer,requestId:'OFFLINE_JSON_REVIEWER_REQUEST'}};
 const packet={schema:'dream-maker.review-packet.v1',runId:run.id,specHash:run.specHash,spec:{hash:run.specHash},plan:structuredClone(run.plan),sourceHistory:[{treeHash:run.treeHash}],scope:{toolsAllowed:false},fixtureProvenance:'OFFLINE_JSON_REVIEW_SHAPE_ONLY'};
 const packetHash=hash(packet),packetId=h.store.record('ReviewPacket',p.id,run.id,{sha256:packetHash,packet,fixtureProvenance:'OFFLINE_TEST_ONLY'});
 run.review={verdict:'PASS',findings:[],source:'DSH',treeHash:run.treeHash};h.store.saveRun(run);
 const reviewId=h.store.record('Review',p.id,run.id,{...run.review,packetId,packetHash,fixtureProvenance:'OFFLINE_TEST_ONLY'}),data=new JsonDatasets(h.store,root);
 return{h,run,data,calls,packetId,reviewId};
}
test('Custom JSON edit and original Engine runtime commit retain mode, source and idempotency',async t=>{
 const x=await setup(t),operation=hash('OFFLINE_CUSTOM_JSON_EXECUTE');
 x.data.write(x.run.id,x.run.treeHash,{count:1},0,hash('OFFLINE_CUSTOM_JSON_INITIAL'),actor);
 const result=await x.h.engine.executeJsonData(x.run.id,x.run.treeHash,1,true,operation,actor);
 assert.equal(result.revision,2);assert.deepEqual(result.document,{count:2});assert.equal(x.calls.classic,0);assert.ok(x.calls.custom>=2);assert.equal(x.calls.worker,1);
 const replay=await x.h.engine.executeJsonData(x.run.id,x.run.treeHash,1,true,operation,actor);assert.equal(replay.operation.replayed,true);assert.equal(x.calls.worker,1);assert.equal(x.h.store.run(x.run.id).state,'READY_FOR_DELIVERY');assert.equal(treeHash(x.run.workspace),x.run.treeHash);
});
test('Custom JSON refuses reviewer identity drift and missing/tampered original review packets',async t=>{
 const x=await setup(t);const original=x.h.store.run(x.run.id);
 const changed=structuredClone(original);changed.roleIdentities.reviewer.accountRef='OFFLINE_FOREIGN_ACCOUNT';x.h.store.saveRun(changed);assert.throws(()=>x.data.readRun(x.run.id,x.run.treeHash),{code:'JSON_DATA_SOURCE_UNVERIFIED'});const restored=x.h.store.run(x.run.id);restored.roleIdentities=original.roleIdentities;x.h.store.saveRun(restored);
 const saved=x.h.store.db.prepare('SELECT data FROM records WHERE id=?').get(x.packetId).data;
 const packet=JSON.parse(saved);packet.packet.scope.toolsAllowed=true;packet.sha256=hash(packet.packet);x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(packet),x.packetId);
 assert.throws(()=>x.data.readRun(x.run.id,x.run.treeHash),{code:'JSON_DATA_SOURCE_UNVERIFIED'});x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(saved,x.packetId);
 x.h.store.db.prepare('DELETE FROM records WHERE id=?').run(x.reviewId);assert.throws(()=>x.data.readRun(x.run.id,x.run.treeHash),{code:'JSON_DATA_SOURCE_UNVERIFIED'});assert.equal(x.calls.worker,0);
});
