// Original Engine + actual local Demo subprocesses; no paid/native role acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,ready } from '../helpers.mjs';
test('two projects enter their own real Flow while dispatch journals serialize executor work',async t=>{
 const h=harness(t,30),a=await ready(h),b=await ready(h);
 const first=h.engine.create(a.p.id,a.s.hash,true),second=h.engine.create(b.p.id,b.s.hash,true);
 assert.notEqual(first.id,second.id);assert.equal(h.engine.jobs.size,2);
 assert.throws(()=>h.engine.create(a.p.id,a.s.hash,true),{code:'WORKSPACE_BUSY'});
 await Promise.all([h.engine.settled(first.id),h.engine.settled(second.id)]);
 assert.equal(h.store.run(first.id).state,'READY_FOR_DELIVERY');assert.equal(h.store.run(second.id).state,'READY_FOR_DELIVERY');
 for(const {p}of [a,b]){
  const grants=h.store.records(p.id,'DispatchGranted'),ends=h.store.records(p.id,'DispatchFinished');
  assert.ok(grants.some(r=>r.data.kind==='executor'));assert.ok(grants.some(r=>r.data.kind==='reviewer'));assert.ok(grants.some(r=>r.data.kind==='verifier'));
  assert.equal(grants.length,ends.length);assert.ok(ends.every(r=>r.data.cleanupReturned===true));
 }
 assert.equal(h.engine.dispatchStatus().active.length,0);
 assert.equal(h.engine.dispatchStatus().quarantined.length,0);
});
test('failed dispatch settlement preserves the uncertain writer even when cancellation is requested',async t=>{
 const h=harness(t),{p,s}=await ready(h),record=h.store.record.bind(h.store);let failed=false;
 h.store.record=(kind,...args)=>{if(kind==='DispatchFinished'&&!failed){failed=true;throw Error('offline settlement failure');}return record(kind,...args);};
 const r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);h.store.record=record;
 assert.equal(h.store.owns(p.id,r.id),true);
 await assert.rejects(h.engine.cancel(r.id),{code:'PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED'});
 assert.equal(h.store.owns(p.id,r.id),true);assert.equal(h.store.run(r.id).state,'BLOCKED');
});
test('a whole-Flow route still holds the writer until its own restoration is proven',async t=>{
 const h=harness(t,100),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);h.engine.pause(r.id);await h.engine.settled(r.id);
 // Offline controller boundary: exercise the actual route slot without touching Clash or a model.
 const error=Object.assign(new Error('offline route restore uncertainty'),{code:'CLASH_RESTORE_REQUIRES_LOCAL_RECOVERY'});
 const work=h.engine.dispatch.run({projectId:p.id,runId:r.id,kind:'route',mode:'demo',signal:new AbortController().signal},async()=>{
  h.engine.advance(r.id,'READY_FOR_DELIVERY');assert.equal(h.store.owns(p.id,r.id),true);throw error;
 });
 await assert.rejects(work,{code:'PROCESS_CLEANUP_UNPROVEN'});
 assert.equal(h.store.owns(p.id,r.id),true);
 await assert.rejects(h.engine.cancel(r.id),{code:'PROCESS_OWNERSHIP_RECONCILIATION_REQUIRED'});
});
test('restart replays a persisted safe release after settled blocked work',async t=>{
 const h=harness(t,100),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);h.engine.pause(r.id);await h.engine.settled(r.id);
 const current=h.store.run(r.id);current.state='BLOCKED';current.reason='REVIEW_BLOCKED';current.pendingLeaseRelease=true;h.store.saveRun(current);
 h.engine.recover();assert.equal(h.store.owns(p.id,r.id),false);assert.equal(h.store.run(r.id).pendingLeaseRelease,undefined);
 assert.equal(h.store.run(r.id).state,'BLOCKED');assert.equal(h.store.run(r.id).reason,'REVIEW_BLOCKED');
});
