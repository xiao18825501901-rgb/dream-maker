// OFFLINE Engine/Store authorization fixtures only. Zero models or formal writes.
import test from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';
import {hash} from '../../dist/server/security.js';import {checkDuration} from '../../dist/server/budget.js';
const load=()=>import('../../dist/server/review-window.js');
const grant=x=>Promise.resolve().then(()=>x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor));

test('expired zero-dispatch review offers a read-only candidate, never a time approval',async t=>{
 const x=await reviewWindowFixture(t),before=hash(x.h.store.run(x.r.id));
 assert.deepEqual(x.h.engine.reviewWindowCandidate(x.r.id),{kind:'EXPIRED_REVIEW_WINDOW',sourceHash:x.r.treeHash,version:x.r.version,maxSeconds:7200});
 assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(x.h.store.records(x.p.id,'ReviewWindowApproval').length,0);
 x.h.store.record('DispatchQueued',x.p.id,x.r.id,{kind:'reviewer'});
 assert.equal(x.h.engine.reviewWindowCandidate(x.r.id),null);
});

test('explicit review window preserves original run limits and stays blocked without a model',async t=>{
 const x=await reviewWindowFixture(t),before=x.h.store.run(x.r.id);assert.throws(()=>checkDuration(before),{code:'RUN_WALL_TIME_BUDGET_EXCEEDED'});
 const approved=await grant(x),after=x.h.store.run(x.r.id),m=await load();assert.equal(approved.reviewWindow.recordId,after.reviewWindow.recordId);
 const original=({version,updatedAt,reviewWindow,...rest})=>rest;assert.deepEqual(original(after),original(before));
 const evidence=m.reviewWindowEvidence(x.h.store,after);assert.equal(evidence.originalDeadline,new Date(Date.parse(before.createdAt)+1000).toISOString());
 assert.equal(m.runDeadline(x.h.store,after),Date.now()+3600000);assert.doesNotThrow(()=>checkDuration(after,x.h.store));
 assert.equal(after.state,'BLOCKED');assert.equal(after.calls,4);assert.equal(after.repairCount,1);assert.equal(x.h.store.records(x.p.id,'ReviewWindowApproval').length,1);
 assert.equal(x.h.store.records(x.p.id,'DispatchGranted').length,0);assert.equal(x.h.store.records(x.p.id,'Review').length,0);
 assert.equal(x.h.engine.reviewPreparationCandidate(after.id).kind,'SOURCE_VERSION');
 await assert.rejects(grant({...x,request:{...x.request,expectedVersion:after.version}}));
 t.mock.timers.tick(3600001);assert.throws(()=>checkDuration(after,x.h.store),{code:'RUN_WALL_TIME_BUDGET_EXCEEDED'});
});
for(const [name,alter]of [
 ['no explicit confirmation',x=>x.request.confirmed=false],
 ['unknown source',x=>x.request.sourceHash='b'.repeat(64)],
 ['stale version',x=>x.request.expectedVersion--],
 ['zero duration',x=>x.request.seconds=0],
 ['more than two hours',x=>x.request.seconds=7201],
 ['fractional duration',x=>x.request.seconds=60.5],
 ['invalid actor',x=>x.actor='MODEL_CLAIM'],
 ['source changed',x=>writeFileSync(join(x.r.workspace,'main.mjs'),'changed')],
 ['prior verdict',x=>{const r=x.h.store.run(x.r.id);r.review={verdict:'BLOCKED'};x.h.store.saveRun(r);x.request.expectedVersion=r.version;}],
 ['call limit',x=>{const r=x.h.store.run(x.r.id);r.calls=r.maxCalls;x.h.store.saveRun(r);x.request.expectedVersion=r.version;}]
])test('review window refuses '+name+' before any authorization or dispatch',async t=>{
 const x=await reviewWindowFixture(t);alter(x);const before=hash(x.h.store.run(x.r.id));await assert.rejects(grant(x));
 assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(x.h.store.records(x.p.id,'ReviewWindowApproval').length,0);
 assert.equal(x.h.store.records(x.p.id,'DispatchGranted').length,0);
});
for(const [name,mutate]of [
 ['missing receipt',x=>x.h.store.db.prepare('DELETE FROM records WHERE id=?').run(x.h.store.run(x.r.id).reviewWindow.recordId)],
 ['changed receipt',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.seconds',7200) WHERE id=?").run(x.h.store.run(x.r.id).reviewWindow.recordId)],
 ['changed original clock',x=>{const r=x.h.store.run(x.r.id);r.maxSeconds++;x.h.store.saveRun(r);}],
 ['changed call ceiling',x=>{const r=x.h.store.run(x.r.id);r.maxCalls++;x.h.store.saveRun(r);}],
 ['counter reset',x=>{const r=x.h.store.run(x.r.id);r.calls=0;x.h.store.saveRun(r);}],
 ['corrupt excessive counter',x=>{const r=x.h.store.run(x.r.id);r.calls=r.maxCalls+1;x.h.store.saveRun(r);}],
 ['corrupt fractional counter',x=>{const r=x.h.store.run(x.r.id);r.calls=4.5;x.h.store.saveRun(r);}]
])test('runtime clock refuses '+name+' instead of trusting an unbound deadline',async t=>{
 const x=await reviewWindowFixture(t);await grant(x);mutate(x);const m=await load();
 assert.throws(()=>m.runDeadline(x.h.store,x.h.store.run(x.r.id)));
});
test('approval snapshots caller input before asynchronous preparation',async t=>{
 const x=await reviewWindowFixture(t),pending=x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);
 x.request.seconds=7200;x.request.sourceHash='b'.repeat(64);await pending;
 const m=await load(),body=m.reviewWindowEvidence(x.h.store,x.h.store.run(x.r.id));assert.equal(body.seconds,3600);assert.equal(body.sourceHash,x.r.treeHash);
});
test('original Engine launch timer uses the verified additional deadline, not the expired original clock',async t=>{
 const x=await reviewWindowFixture(t);await grant(x);let observed;
 // Explicit OFFLINE loop spy, never role dispatch or a completed product stage.
 x.h.engine.loop=async(_rid,signal)=>{await new Promise(resolve=>setTimeout(resolve,30));observed=signal.aborted;};
 Object.getPrototypeOf(x.h.engine).launch.call(x.h.engine,x.r.id);await x.h.engine.settled(x.r.id);
 assert.equal(observed,false);assert.equal(x.h.store.records(x.p.id,'DispatchGranted').length,0);
});

test('an unrelated observation changes the preparation basis and must not be hidden by CAS',async t=>{
 const x=await reviewWindowFixture(t),{reviewPreparationBasis}=await import('../../dist/server/review-preparation-retry.js');
 const basis=()=>reviewPreparationBasis(x.h.store,x.h.store.run(x.r.id),'a'.repeat(64),{expiredWindowApproval:true});
 const before=basis().basisHash;
 x.h.store.record('WindowsIntentRecoveryObservation',x.p.id,x.r.id,{scope:'OFFLINE_UNRELATED_OBSERVATION'});
 assert.notEqual(basis().basisHash,before);
});
