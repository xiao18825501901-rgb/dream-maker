// Real isolated SQLite reopen, OFFLINE dispatch records. No Native session or model.
import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../../dist/server/store.js';import {reviewSupplementFixture} from '../fixtures/review-supplement.mjs';
import {reviewSupplementEvidence,reserveReviewSupplementCall} from '../../dist/server/review-supplement.js';
test('reopening the original Store preserves approved and consumed supplemental authority without resetting the old cap',async t=>{
 const x=await reviewSupplementFixture(t),r=await x.h.engine.approveReviewSupplement(x.r.id,x.request,x.actor);
 let reopened=new Store(x.h.store.path);try{assert.deepEqual(reopened.run(r.id).reviewSupplement,r.reviewSupplement);assert.equal(reviewSupplementEvidence(reopened,reopened.run(r.id)).used,0);}finally{reopened.close();}
 const dispatch={dispatchId:'OFFLINE_PERSISTED_REVIEW',generation:'OFFLINE_PERSISTED_GENERATION'};x.h.store.record('DispatchGranted',x.p.id,r.id,{...dispatch,kind:'reviewer',mode:'live'});reserveReviewSupplementCall(x.h.store,r,'reviewer',dispatch);
 reopened=new Store(x.h.store.path);try{const read=reopened.run(r.id);assert.equal(read.calls,read.maxCalls);assert.equal(read.calls,r.calls);assert.equal(read.review.verdict,'BLOCKED');assert.equal(reviewSupplementEvidence(reopened,read).used,1);assert.throws(()=>reserveReviewSupplementCall(reopened,read,'reviewer',dispatch),{code:'REVIEW_SUPPLEMENT_CALL_EXHAUSTED'});}finally{reopened.close();}
});
