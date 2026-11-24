// OFFLINE module seam: synthetic ownership observations, never OS or Native proof.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
mock.module('../../dist/server/flow/ownership-recovery.js',{namedExports:{inspectDispatchOwnership:async(...args)=>{
 const dispatchId=args[5];args[7]({scope:'OFFLINE_DEFERRED_OBSERVATION',dispatchId});
 return {schema:'dream-maker.dispatch-recovery.v1',dispatchId,proven:true,basisSha256:'a'.repeat(64)};
}}});
const {reviewWindowFixture}=await import('./review-window.mjs');
function history(x){
 x.h.store.record('DispatchGranted',x.p.id,x.r.id,{dispatchId:'OFFLINE_DISPATCH',kind:'executor',generation:'OFFLINE_GENERATION'});
 x.h.store.record('DispatchFinished',x.p.id,x.r.id,{dispatchId:'OFFLINE_DISPATCH',generation:'OFFLINE_GENERATION',cleanupReturned:true});
}
const observations=x=>x.h.store.records(x.p.id,'WindowsIntentRecoveryObservation');
test('deferred observations commit with approval after the original basis comparison',async t=>{
 const x=await reviewWindowFixture(t);history(x);
 const approved=await x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);
 assert.equal(approved.state,'BLOCKED');assert.ok(approved.reviewWindow);assert.equal(observations(x).length,1);
 assert.equal(x.h.store.records(x.p.id,'ReviewWindowApproval').length,1);
 assert.equal(x.h.store.records(x.p.id,'Review').length,0);
});
for(const phase of ['approval','preparation'])test('a failed '+phase+' rolls back its deferred observation and state together',async t=>{
 const x=await reviewWindowFixture(t);history(x);
 if(phase==='preparation'){
  await x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);
  x.h.engine.assertNativeReadyForRun=()=>{}; // Explicit OFFLINE admission seam.
 }
 const before=x.h.store.run(x.r.id),count=observations(x).length;
 t.mock.method(x.h.store,'saveRun',()=>{throw Error('OFFLINE_COMMIT_FAILURE');});
 const action=()=>phase==='approval'?x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor):
  x.h.engine.prepareUndispatchedReviewRetry(x.r.id,before.treeHash,before.version,x.actor);
 await assert.rejects(action(),/OFFLINE_COMMIT_FAILURE/);
 assert.equal(observations(x).length,count);assert.deepEqual(x.h.store.run(x.r.id),before);
 assert.equal(x.h.store.records(x.p.id,'ReviewPreparationRecovery').length,0);
});
