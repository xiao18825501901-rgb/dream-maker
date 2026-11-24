// OFFLINE factory boundary only: no credentials, process, model or Native qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {NativeOwner} from '../../dist/server/native-owner.js';import {WslSandbox} from '../../dist/server/wsl-sandbox.js';
import {prepareSqliteRuntimeCommand} from '../../dist/server/data-runtime-plan.js';import {withProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {harness,ready,root} from '../helpers.mjs';import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';import {hash} from '../../dist/server/security.js';
import {seedOfflineSqliteReview} from '../fixtures/sqlite-review.mjs';import {writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {readWorkspace} from '../../dist/server/workspace-location.js';
const plan={schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:'python',entry:'data.py',args:[]};
async function setup(t){
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h),made=h.engine.create(p.id,s.hash,true);await h.engine.settled(made.id);
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);const run=h.store.run(made.id);run.mode='live';run.review={...run.review,source:'CODEX'};run.plan={...run.plan,dataRuntime:plan};seedOfflineSqliteReview(h.store,run);
 const binding={inputHash:'a'.repeat(64),expectedRevision:0},input={runId:run.id,specHash:s.hash,sourceHash:run.treeHash,planHash:hash(plan),command:prepareSqliteRuntimeCommand(plan,binding),image:null,binding,signal:new AbortController().signal};
 const scope={store:h.store,projectId:p.id,runId:run.id,dispatchId:'OFFLINE_M61_NATIVE_BOUNDARY',generation:'OFFLINE_GENERATION',mode:'live'};
 const owner=Object.create(NativeOwner.prototype);owner.context={root,store:h.store,getConfig:()=>h.config,getSecret:()=>{throw Error('NO_CREDENTIAL_ACCESS');}};let readyCalls=0,workerCalls=0,seen;
 owner.assertReady=(role,context)=>{readyCalls++;assert.equal(role,'build');assert.deepEqual(context,{projectId:p.id,specHash:s.hash});};
 const sentinel={result:{marker:'OFFLINE_WORKER_NOT_LAUNCHED'},image:null,exchangeMetadata:{}};
 t.mock.method(WslSandbox.prototype,'runSqlite',async(...args)=>{workerCalls++;seen=args;return sentinel;});
 return {h,run,p,s,owner,input,scope,sentinel,readyCalls:()=>readyCalls,workerCalls:()=>workerCalls,seen:()=>seen,invoke:(change={})=>withProcessOwnership(scope,()=>owner.runSqliteData({...input,...change}))};
}
test('NativeOwner requires the original owned dispatch before admitting binary runtime',async t=>{
 const x=await setup(t);await assert.rejects(x.owner.runSqliteData(x.input),{code:'NATIVE_DATA_OWNERSHIP_REQUIRED'});assert.equal(x.readyCalls(),0);assert.equal(x.workerCalls(),0);
});
test('NativeOwner binds exact source, spec, plan and command before delegating to existing WSL binary transport',async t=>{
 const x=await setup(t);assert.equal(await x.invoke(),x.sentinel);assert.equal(x.workerCalls(),1);assert.deepEqual(x.seen().slice(0,4),[x.run.workspace,x.input.command,null,x.input.binding]);assert.equal(x.seen()[4].signal,x.input.signal);
 for(const change of [{specHash:'b'.repeat(64)},{sourceHash:'b'.repeat(64)},{planHash:'b'.repeat(64)},{command:{...x.input.command,entry:'unreviewed.py'}},{command:{...x.input.command,stdin:'SQL'}},{binding:{inputHash:'invalid',expectedRevision:0}}])await assert.rejects(x.invoke(change));
 assert.equal(x.workerCalls(),1);assert.equal(x.h.store.records(x.p.id,'ModelAttempt').length,0);
});
test('aborted and foreign owned dispatches never launch the binary transport or use a fallback runner',async t=>{
 const x=await setup(t);await assert.rejects(x.invoke({signal:AbortSignal.abort()}),{code:'RUN_CANCELLED'});
 await assert.rejects(withProcessOwnership({...x.scope,runId:'OFFLINE_OTHER'},()=>x.owner.runSqliteData(x.input)),{code:'NATIVE_DATA_OWNERSHIP_REQUIRED'});assert.equal(x.workerCalls(),0);
});

test('review counterexample: a valid historical read relocation grants no execution of the old workspace',async t=>{
 const x=await setup(t),target=x.run.workspace,old=resolve(x.h.dir,'OFFLINE_UNREAD_LEGACY',x.run.id),r=x.h.store.run(x.run.id);r.workspace=old;x.h.store.saveRun(r);
 const receipt=resolve(x.h.dir,'offline-copy-receipt.json'),bytes=Buffer.from(JSON.stringify({schema:'dream-maker.project-copy-receipt.v2',source:resolve(x.h.dir,'OFFLINE_UNREAD_LEGACY'),suite:resolve(x.h.dir,'..'),allFileHashes:'PASS',sourceSecondPass:'PASS',sourceNamespaces:'PASS'}));writeFileSync(receipt,bytes);
 writeFileSync(resolve(x.h.dir,'workspace-relocations.json'),JSON.stringify({schema:'dream-maker.workspace-relocations.v1',dataRoot:x.h.dir,copyReceipt:{path:receipt,sha256:hash(bytes)},provenance:'COPIED_BYTES_NOT_EXECUTION_PROOF',entries:[{runId:r.id,from:old,to:target,treeHash:r.treeHash,recordedTreeHash:r.treeHash}]}));
 assert.equal(readWorkspace(r,x.h.dir),target);await assert.rejects(x.invoke(),{code:'WORKSPACE_LOCATION_CHANGED'});assert.equal(x.workerCalls(),0);
});

test('missing, corrupted and cross-run review-packet links cannot qualify an existing binary command',async t=>{
 const x=await setup(t),reviewRow=x.h.store.db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='Review' ORDER BY rowid DESC LIMIT 1").get(x.run.id),originalReview=JSON.parse(reviewRow.data),packetRow=x.h.store.db.prepare('SELECT id,data FROM records WHERE id=?').get(originalReview.packetId),originalPacket=JSON.parse(packetRow.data);
 const replace=(id,data)=>x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),id);
 for(const mutate of [
  (review,_)=>{review.packetId='OFFLINE_MISSING_PACKET';},
  (review,_)=>{review.packetHash='b'.repeat(64);},
  (_,packet)=>{packet.packet.plan.dataRuntime.args=['unreviewed'];},
  (review,packet)=>{packet.packet.runId='OFFLINE_FOREIGN_RUN';packet.sha256=hash(packet.packet);review.packetHash=packet.sha256;},
  (review,packet)=>{packet.packet.scope.toolsAllowed=true;packet.sha256=hash(packet.packet);review.packetHash=packet.sha256;}
 ]){
  const review=structuredClone(originalReview),packet=structuredClone(originalPacket);mutate(review,packet);replace(reviewRow.id,review);replace(packetRow.id,packet);
  await assert.rejects(x.invoke(),{code:'SQLITE_DATA_REVIEW_BINDING_REQUIRED'});replace(reviewRow.id,originalReview);replace(packetRow.id,originalPacket);
 }
 assert.equal(x.workerCalls(),0);assert.equal(x.readyCalls(),0);
});
