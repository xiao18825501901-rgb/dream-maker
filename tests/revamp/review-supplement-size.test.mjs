// Actual Store/Engine transaction with OFFLINE material, never a model request.
import test from 'node:test';import assert from 'node:assert/strict';
import {reviewSupplementFixture} from '../fixtures/review-supplement.mjs';import {buildReviewPacket} from '../../dist/server/review-packet.js';import {hash} from '../../dist/server/security.js';
test('authorization that makes final complete material too large rolls back before acquiring a usable slot',async t=>{
 const x=await reviewSupplementFixture(t),s=x.h.store,r=s.run(x.r.id);r.plan={...r.plan,notes:''};s.saveRun(r);
 const target=511900,initial=Buffer.byteLength(JSON.stringify(buildReviewPacket(s,r,x.s)));r.plan.notes='z'.repeat(target-initial);s.saveRun(r);
 const before=s.run(r.id),packet=buildReviewPacket(s,before,x.s);assert.equal(Buffer.byteLength(JSON.stringify(packet)),target);
 await assert.rejects(x.h.engine.approveReviewSupplement(r.id,{...x.request,expectedVersion:before.version,packetHash:hash(packet)},x.actor));
 assert.deepEqual(s.run(r.id),before);assert.equal(s.owns(x.p.id,r.id),false);assert.equal(s.records(x.p.id,'ReviewSupplementApproval').length,0);
});
test('the stricter wire packet ceiling refuses oversized material before authorization or the Codex echo layer',async t=>{
 const x=await reviewSupplementFixture(t),s=x.h.store,r=s.run(x.r.id);r.plan={...r.plan,notes:''};s.saveRun(r);
 const initial=Buffer.byteLength(JSON.stringify(buildReviewPacket(s,r,x.s)));r.plan.notes='z'.repeat(1970000-initial);s.saveRun(r);
 const before=s.run(r.id);
 assert.throws(()=>buildReviewPacket(s,before,x.s),{code:'REVIEW_PACKET_LIMIT'});
 await assert.rejects(x.h.engine.approveReviewSupplement(r.id,{...x.request,expectedVersion:before.version},x.actor),{code:'REVIEW_PACKET_LIMIT'});
 assert.deepEqual(s.run(r.id),before);assert.equal(s.owns(x.p.id,r.id),false);assert.equal(s.records(x.p.id,'ReviewSupplementApproval').length,0);
});
