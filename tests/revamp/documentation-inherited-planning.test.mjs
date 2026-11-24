// Explicit OFFLINE lineage in original isolated Store. No account, native model or formal data.
import test from 'node:test';import assert from 'node:assert/strict';
import {documentationCorrectionFixture} from '../fixtures/documentation-correction.mjs';import {hash} from '../../dist/server/security.js';
async function fixture(t){const x=await documentationCorrectionFixture(t,{includeMainTask:true}),candidate=x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md'),child=await x.h.engine.approveDocumentationContinuation(x.r.id,{confirmed:true,file:'README.md',candidateHash:candidate.candidateHash,taskDeadline:null},x.actor);return {...x,child};}
const load=()=>import('../../dist/server/documentation-continuation.js');

test('inherited planning exposes a digest-bound parent identity without copying full material or mutating records',async t=>{
 const x=await fixture(t),m=await load(),before=x.h.store.db.prepare('SELECT count(*) n FROM records').get().n;
 assert.equal(typeof m.inheritedDocumentationPlanning,'function');const view=m.inheritedDocumentationPlanning(x.h.store,x.child);
 const approval=JSON.parse(x.h.store.db.prepare('SELECT data FROM records WHERE id=?').get(x.child.documentationContinuation.recordId).data);
 assert.equal(view.origin,'INHERITED_NOT_NEW_PLANNING');assert.equal(view.parentRunId,x.r.id);assert.equal(view.planner.identity.sessionId,x.r.sessions.planner2);assert.equal(view.plan.data.specHash,x.r.specHash);assert.deepEqual(view.plan.data.plan,x.r.plan);assert.equal(view.review.data.verdict,'CHANGES_REQUESTED');assert.equal(view.packet.sha256,approval.parentReviewPacketHash);assert.equal(view.packet.packet.runId,x.r.id);
 assert.equal(view.packet.packet.sourceHistory,undefined);assert.deepEqual(view.packet.packet.executionEvidence.roleIdentities.planner2,view.planner.identity);
 assert.ok(view.codexEvents.some(e=>e.data.method==='dm/codexAdmission'));assert.ok(view.codexEvents.some(e=>e.data.method==='dm/codexCompletion'));
 assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM records').get().n,before);assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(r=>r.runId===x.child.id).length,0);assert.equal(x.h.store.run(x.child.id).roleIdentities?.planner2,undefined);
});

test('rewriting old packet and its review reference together cannot replace approved inherited evidence',async t=>{
 const x=await fixture(t),m=await load(),db=x.h.store.db,packet=db.prepare('SELECT data FROM records WHERE id=?').get(x.packetId),old=JSON.parse(packet.data),changed={...old.packet,unapprovedSource:'OFFLINE forged parent packet'};
 db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...old,packet:changed,sha256:hash(changed)}),x.packetId);
 const review=db.prepare('SELECT data FROM records WHERE id=?').get(x.reviewId),d=JSON.parse(review.data);db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...d,packetHash:hash(changed)}),x.reviewId);
 assert.throws(()=>m.inheritedDocumentationPlanning(x.h.store,x.child),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});
});

test('parent official admission cannot be replaced by a fixture label or paid fallback claim',async t=>{
 const x=await fixture(t),m=await load(),db=x.h.store.db,row=db.prepare("SELECT id,payload FROM events WHERE run_id=? AND type='agent.event' AND json_extract(payload,'$.method')='dm/codexAdmission' AND json_extract(payload,'$.params.role')='planner2'").get(x.r.id),d=JSON.parse(row.payload);
 db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify({...d,params:{...d.params,paidFallback:true}}),row.id);
 assert.throws(()=>m.inheritedDocumentationPlanning(x.h.store,x.child),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});
});
