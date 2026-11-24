import test from 'node:test';import assert from 'node:assert/strict';
import {reviewSupplementFixture} from '../fixtures/review-supplement.mjs';
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
import {buildReviewPacket} from '../../dist/server/review-packet.js';
import {reviewSupplementEvidence,assertReviewSupplementPacket,reserveReviewSupplementCall} from '../../dist/server/review-supplement.js';
import {DomainError} from '../../dist/server/security.js';
test('explicit supplemental review approval preserves the old cap, verdict and source, acquires one lease, and dispatches no model',async t=>{
 const x=await reviewSupplementFixture(t),before=x.h.store.run(x.r.id);
 const r=await x.h.engine.approveReviewSupplement(before.id,x.request,x.actor);
 assert.equal(r.state,'PAUSED');assert.equal(r.reason,'REVIEW_SUPPLEMENT_PREPARED');assert.equal(x.h.store.owns(x.p.id,r.id),true);
 for(const key of ['calls','maxCalls','repairCount','maxRepairs','createdAt','maxSeconds','treeHash'])assert.equal(r[key],before[key]);
 assert.deepEqual(r.review,before.review);assert.deepEqual(r.reviewWindow,before.reviewWindow);assert.deepEqual(r.reviewOnlyWindow,before.reviewOnlyWindow);
 const rows=x.h.store.records(x.p.id,'ReviewSupplementApproval');assert.equal(rows.length,1);assert.equal(rows[0].data.additionalCalls,1);assert.equal(rows[0].data.modelDispatched,false);assert.equal(rows[0].data.previousReviewRecordId,x.previousReviewRecordId);
 assert.equal(x.h.store.records(x.p.id,'ReviewSupplementCallReservation').length,0);
});

for(const [name,alter]of [
 ['unconfirmed',x=>({...x.request,confirmed:false})],['unexpected scope',x=>({...x.request,additionalCalls:100})],
 ['stale version',x=>({...x.request,expectedVersion:x.request.expectedVersion-1})],['changed source',x=>({...x.request,sourceHash:'e'.repeat(64)})],
 ['wrong packet',x=>({...x.request,packetHash:'e'.repeat(64)})],['wrong review',x=>({...x.request,previousReviewRecordId:'OFFLINE_FOREIGN_REVIEW'})]
])test('supplement approval refuses '+name+' without taking a lease',async t=>{
 const x=await reviewSupplementFixture(t),before=x.h.store.run(x.r.id);await assert.rejects(async()=>x.h.engine.approveReviewSupplement(x.r.id,alter(x),x.actor));
 assert.deepEqual(x.h.store.run(x.r.id),before);assert.equal(x.h.store.owns(x.p.id,x.r.id),false);assert.equal(x.h.store.records(x.p.id,'ReviewSupplementApproval').length,0);
});
test('duplicate approval cannot add a second extra call',async t=>{
 const x=await reviewSupplementFixture(t);const r=await x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor);
 await assert.rejects(x.h.engine.approveReviewSupplement(r.id,{...x.request,expectedVersion:r.version},x.actor));assert.equal(x.h.store.records(x.p.id,'ReviewSupplementApproval').length,1);
});
test('supplement and lease roll back when the original Store commit fails',async t=>{
 const x=await reviewSupplementFixture(t),before=x.h.store.run(x.r.id);t.mock.method(x.h.store,'saveRun',()=>{throw Error('OFFLINE_COMMIT_FAILURE');});
 await assert.rejects(x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor),/OFFLINE_COMMIT_FAILURE/);assert.deepEqual(x.h.store.run(x.r.id),before);
 assert.equal(x.h.store.owns(x.p.id,x.r.id),false);assert.equal(x.h.store.records(x.p.id,'ReviewSupplementApproval').length,0);
});
test('current source mutation blocks approval and does not dispatch',async t=>{
 const x=await reviewSupplementFixture(t);writeFileSync(join(x.r.workspace,'main.mjs'),'// OFFLINE changed source');
 await assert.rejects(x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor),{code:'EXTERNAL_WORKSPACE_CHANGE'});assert.equal(x.h.store.records(x.p.id,'ReviewSupplementApproval').length,0);
});
for(const kind of ['cleanup','completion'])test('missing prior '+kind+' cannot qualify a new review',async t=>{
 const x=await reviewSupplementFixture(t);if(kind==='cleanup')x.h.store.db.prepare("DELETE FROM records WHERE run_id=? AND kind='OwnedProcessCleanup' AND json_extract(data,'$.dispatchId')=?").run(x.r.id,x.dispatchId);
 else x.h.store.db.prepare("DELETE FROM events WHERE run_id=? AND json_extract(payload,'$.method')='dm/codexCompletion' AND json_extract(payload,'$.params.role')='reviewer'").run(x.r.id);
 await assert.rejects(x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor));assert.equal(x.h.store.owns(x.p.id,x.r.id),false);
});
test('a separate reservation is once-only, refuses other roles and leaves the old counter unchanged',async t=>{
 const x=await reviewSupplementFixture(t),r=await x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor);assert.equal(reviewSupplementEvidence(x.h.store,r).used,0);
 assert.doesNotThrow(()=>assertReviewSupplementPacket(x.h.store,r,buildReviewPacket(x.h.store,r,x.s)));
 for(const role of ['planner1','planner2','executor'])assert.throws(()=>reserveReviewSupplementCall(x.h.store,r,role,{dispatchId:'OFFLINE_NEW',generation:'OFFLINE_NEW_GEN'}),{code:'REVIEW_SUPPLEMENT_ROLE_DENIED'});
 x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId:'OFFLINE_NEW',generation:'OFFLINE_NEW_GEN',kind:'reviewer',mode:'live'});
 reserveReviewSupplementCall(x.h.store,r,'reviewer',{dispatchId:'OFFLINE_NEW',generation:'OFFLINE_NEW_GEN'});assert.equal(reviewSupplementEvidence(x.h.store,r).used,1);
 assert.throws(()=>reserveReviewSupplementCall(x.h.store,r,'reviewer',{dispatchId:'OFFLINE_NEW2',generation:'OFFLINE_NEW_GEN'}),{code:'REVIEW_SUPPLEMENT_CALL_EXHAUSTED'});assert.equal(x.h.store.run(r.id).calls,r.maxCalls);
});
test('supplemental reservation requires the matching actual original Dispatch grant',async t=>{
 const x=await reviewSupplementFixture(t),r=await x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor);
 assert.throws(()=>reserveReviewSupplementCall(x.h.store,r,'reviewer',{dispatchId:'OFFLINE_NO_GRANT',generation:'OFFLINE_NEW_GEN'}));
 assert.equal(x.h.store.records(x.p.id,'ReviewSupplementCallReservation').length,0);
});
test('native admission refusal leaves a prepared supplemental slot usable without a model',async t=>{
 const x=await reviewSupplementFixture(t),r=await x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor);x.h.engine.nativeExecution.assertReady=()=>{throw new DomainError('PROBE_EVIDENCE_UNVERIFIED',409);};
 await assert.rejects(x.h.engine.resume(r.id),{code:'PROBE_EVIDENCE_UNVERIFIED'});assert.equal(x.h.store.run(r.id).state,'PAUSED');assert.equal(reviewSupplementEvidence(x.h.store,r).used,0);
});
test('a new reviewer marker cannot borrow a preceding session completion event',async t=>{
 const x=await reviewSupplementFixture(t),r=x.h.store.run(x.r.id),old=x.h.store.db.prepare('SELECT type,payload FROM events WHERE id=?').get(x.markerId);
 x.h.store.db.prepare('DELETE FROM events WHERE id=?').run(x.markerId);x.h.store.event(x.p.id,r.id,old.type,JSON.parse(old.payload));
 const request={...x.request,packetHash:(await import('../../dist/server/security.js')).hash(buildReviewPacket(x.h.store,r,x.s))};
 await assert.rejects(x.h.engine.approveReviewSupplement(x.r.id,request,x.actor));assert.equal(x.h.store.records(x.p.id,'ReviewSupplementApproval').length,0);
});
