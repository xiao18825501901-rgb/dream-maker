import test from 'node:test';import assert from 'node:assert/strict';
import {reviewTransportRetryFixture} from '../fixtures/review-transport-retry.mjs';
import {root} from '../helpers.mjs';
test('legacy read-only RPC rejection retains unknown model usage and permits only the last transport retry',async t=>{
 const x=await reviewTransportRetryFixture(t),{readOnlyReviewRetryBasis}=await import('../../dist/server/review-transport-retry.js');
 const basis=readOnlyReviewRetryBasis(x.h.store,x.h.store.run(x.r.id),x.h.config,root);
 assert.equal(basis.dispatchId,x.dispatchId);assert.equal(basis.priorModelOutcome,'UNKNOWN');assert.equal(basis.priorUsage,'UNKNOWN_PRESERVED');assert.equal(basis.targetEncoding,'PACKET_OBJECT_V1');
});

for(const [name,alter] of [
 ['new encoding already used',x=>{const row=x.h.store.db.prepare("SELECT id,payload FROM events WHERE run_id=? AND json_extract(payload,'$.method')='dm/codexAdmission' ORDER BY id DESC LIMIT 1").get(x.r.id);x.h.store.db.prepare("UPDATE events SET payload=json_set(payload,'$.params.materialEncoding','PACKET_OBJECT_V1') WHERE id=?").run(row.id);}],
 ['completed model output',x=>x.h.store.event(x.p.id,x.r.id,'agent.event',{method:'dm/codexCompletion',params:{role:'reviewer'}})],
 ['tool side effect',x=>x.h.store.record('ToolIntent',x.p.id,x.r.id,{tool:'desk_write'})],
 ['cleanup identity missing',x=>{const row=x.h.store.records(x.p.id,'OwnedProcessCleanup').at(-1);x.h.store.db.prepare("UPDATE records SET data=json_remove(data,'$.processId') WHERE id=?").run(row.id);}],
 ['foreign cleanup generation',x=>{const row=x.h.store.records(x.p.id,'OwnedProcessCleanup').at(-1);x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.generation','FOREIGN') WHERE id=?").run(row.id);}],
 ['source drift',x=>{const r=x.h.store.run(x.r.id);r.treeHash='f'.repeat(64);x.h.store.saveRun(r);}],
 ['call ceiling spent',x=>{const r=x.h.store.run(x.r.id);r.calls=r.maxCalls;x.h.store.saveRun(r);}],
 ['already prepared',x=>x.h.store.record('ReviewTransportRetryPreparation',x.p.id,x.r.id,{dispatchId:x.dispatchId})]
])test('read-only transport retry rejects '+name,async t=>{const x=await reviewTransportRetryFixture(t);alter(x);const {readOnlyReviewRetryBasis}=await import('../../dist/server/review-transport-retry.js');assert.throws(()=>readOnlyReviewRetryBasis(x.h.store,x.h.store.run(x.r.id),x.h.config,root));});

test('a later unbound marker cannot hide partial output from the actual grant',async t=>{
 const x=await reviewTransportRetryFixture(t),saved=JSON.parse(x.h.store.db.prepare("SELECT payload FROM events WHERE run_id=? AND json_extract(payload,'$.method')='dm/codexAdmission' ORDER BY id DESC LIMIT 1").get(x.r.id).payload);
 x.h.store.event(x.p.id,x.r.id,'agent.event',{method:'item/completed',params:{role:'reviewer',item:{type:'agentMessage',text:'OFFLINE_PARTIAL'}}});
 x.h.store.event(x.p.id,x.r.id,'role.dispatch',{state:'REVIEWING',phase:'REVIEWING'});x.h.store.event(x.p.id,x.r.id,'agent.event',saved);
 const {readOnlyReviewRetryBasis}=await import('../../dist/server/review-transport-retry.js');assert.throws(()=>readOnlyReviewRetryBasis(x.h.store,x.h.store.run(x.r.id),x.h.config,root));
});

test('legacy role policy is refused before consuming the one preparation',async t=>{
 const x=await reviewTransportRetryFixture(t),r=x.h.store.run(x.r.id);r.rolePolicy='LEGACY_CONFIGURED_V1';x.h.store.saveRun(r);
 const {readOnlyReviewRetryBasis}=await import('../../dist/server/review-transport-retry.js');assert.throws(()=>readOnlyReviewRetryBasis(x.h.store,x.h.store.run(r.id),x.h.config,root));assert.equal(x.h.store.records(x.p.id,'ReviewTransportRetryPreparation').length,0);
});

test('distinct dispatches from one Engine may share generation while each target chain stays bound',async t=>{
 const x=await reviewTransportRetryFixture(t,{sharedGeneration:true}),{readOnlyReviewRetryBasis}=await import('../../dist/server/review-transport-retry.js');
 assert.equal(readOnlyReviewRetryBasis(x.h.store,x.h.store.run(x.r.id),x.h.config,root).dispatchId,x.dispatchId);
});

test('a malformed dispatch marker timestamp cannot provide a matching interval',async t=>{
 const x=await reviewTransportRetryFixture(t),row=x.h.store.db.prepare("SELECT id FROM events WHERE run_id=? AND type='role.dispatch' ORDER BY id DESC LIMIT 1").get(x.r.id);x.h.store.db.prepare("UPDATE events SET at='zz-invalid' WHERE id=?").run(row.id);
 const {readOnlyReviewRetryBasis}=await import('../../dist/server/review-transport-retry.js');assert.throws(()=>readOnlyReviewRetryBasis(x.h.store,x.h.store.run(x.r.id),x.h.config,root));
});

test('original Engine prepares once with no model and preserves counters, lease and original approval',async t=>{
 const x=await reviewTransportRetryFixture(t),before=x.h.store.run(x.r.id);
 const r=await x.h.engine.prepareReviewTransportRetry(before.id,{confirmed:true,sourceHash:before.treeHash,expectedVersion:before.version},x.actor);
 assert.equal(r.state,'PAUSED');assert.equal(r.reason,'REVIEW_TRANSPORT_RETRY_PREPARED');
 for(const key of ['calls','maxCalls','repairCount','maxRepairs','treeHash','createdAt','maxSeconds'])assert.equal(r[key],before[key]);
 assert.deepEqual(r.reviewOnlyWindow,before.reviewOnlyWindow);assert.equal(x.h.store.owns(x.p.id,r.id),true);
 const record=x.h.store.records(x.p.id,'ReviewTransportRetryPreparation')[0].data;assert.equal(record.modelDispatched,false);assert.equal(record.basis.priorModelOutcome,'UNKNOWN');assert.equal(record.proof.proven,true);
 await assert.rejects(async()=>x.h.engine.prepareReviewTransportRetry(r.id,{confirmed:true,sourceHash:r.treeHash,expectedVersion:r.version},x.actor));
});

test('refused current Native qualification leaves the old failure and retry slot unchanged',async t=>{
 const x=await reviewTransportRetryFixture(t),before=x.h.store.run(x.r.id);x.h.engine.nativeExecution.assertReady=()=>{throw Object.assign(Error('OFFLINE_NOT_QUALIFIED'),{code:'PROBE_EVIDENCE_UNVERIFIED'});};
 await assert.rejects(x.h.engine.prepareReviewTransportRetry(before.id,{confirmed:true,sourceHash:before.treeHash,expectedVersion:before.version},x.actor),{code:'PROBE_EVIDENCE_UNVERIFIED'});
 assert.deepEqual(x.h.store.run(before.id),before);assert.equal(x.h.store.records(x.p.id,'ReviewTransportRetryPreparation').length,0);
});

test('failed preparation transaction rolls back its record and original state together',async t=>{
 const x=await reviewTransportRetryFixture(t),before=x.h.store.run(x.r.id);t.mock.method(x.h.store,'saveRun',()=>{throw Error('OFFLINE_COMMIT_FAILURE');});
 await assert.rejects(x.h.engine.prepareReviewTransportRetry(before.id,{confirmed:true,sourceHash:before.treeHash,expectedVersion:before.version},x.actor),/OFFLINE_COMMIT_FAILURE/);
 assert.deepEqual(x.h.store.run(before.id),before);assert.equal(x.h.store.records(x.p.id,'ReviewTransportRetryPreparation').length,0);assert.equal(x.h.store.owns(x.p.id,before.id),true);
});

test('cancelling preparation joins it and leaves no reusable retry preparation',async t=>{
 const x=await reviewTransportRetryFixture(t),before=x.h.store.run(x.r.id),pending=x.h.engine.prepareReviewTransportRetry(before.id,{confirmed:true,sourceHash:before.treeHash,expectedVersion:before.version},x.actor);pending.catch(()=>{});
 await x.h.engine.cancel(before.id);await assert.rejects(pending,{code:'RUN_CANCELLED'});assert.equal(x.h.store.records(x.p.id,'ReviewTransportRetryPreparation').length,0);assert.equal(x.h.store.run(before.id).state,'CANCELLED');
});
