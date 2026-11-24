import test from 'node:test';import assert from 'node:assert/strict';
import {partialSourceCustodyFixture} from '../fixtures/partial-source-custody.mjs';import {buildReviewPacket} from '../../dist/server/review-packet.js';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';
test('packet includes original incomplete-turn custody and later completed adoption without inventing a failed session',async t=>{
 const x=await partialSourceCustodyFixture(t),packet=buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),custody=packet.executionEvidence.incompleteTurnCustody;
 assert.ok(custody,'actual retention records must reach reviewer');
 assert.deepEqual(custody.records.find(row=>row.recordId===x.custodyId).data,x.h.store.records(x.p.id,'PartialRepairContinuation')[0].data);
 assert.equal(custody.failedAgentSessionCompletion,'NOT_RECORDED');assert.equal(custody.modelDispatchedFlagScope,'RECONCILIATION_ACTION_ONLY');
 const link=custody.links.find(row=>row.custodyRecordId===x.custodyId);assert.equal(link.failedDispatchId,x.failedDispatchId);assert.equal(link.retainedSourceHash,x.retainedHash);assert.equal(link.adoptingSessionRecordId,x.sessionId);assert.equal(link.adoptingDispatchId,x.adoptDispatchId);
 assert.equal(packet.executionEvidence.sessions.some(row=>row.data.dispatchId===x.failedDispatchId),false);
 assert.ok(link.adoptingModelReceiptRecordIds.length>0);assert.ok(link.adoptingModelReceiptRecordIds.every(id=>packet.executionEvidence.modelReceipts.some(row=>row.recordId===id)));
});

test('empty admission recovery is carried separately and never promoted into another model completion',async t=>{
 const x=await partialSourceCustodyFixture(t,{admissionRecovery:true}),p=buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),c=p.executionEvidence.incompleteTurnCustody;
 assert.equal(c.records.length,2);assert.equal(c.links.length,2);assert.equal(c.records[1].recordId,x.admissionRecoveryId);assert.equal(c.records[1].data.taskCompletionAssumed,false);assert.equal(c.links[0].adoptingSessionRecordId,c.links[1].adoptingSessionRecordId);
});

test('review carries a zero-model admission recovery without inventing a partial executor turn',async t=>{
 const x=await partialSourceCustodyFixture(t,{admissionOnly:true}),p=buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),c=p.executionEvidence.incompleteTurnCustody;
 assert.equal(c.records.length,1);assert.equal(c.records[0].recordId,x.admissionRecoveryId);assert.equal(c.records[0].data.admissionRecovery,true);
 assert.equal(c.links.length,1);assert.equal(c.links[0].failedDispatchId,x.failedDispatchId);assert.equal(c.links[0].modelReceiptRecordIds.length,1);
 const receipt=x.h.store.records(x.p.id,'NativeBudgetReceipt').find(row=>row.id===c.links[0].modelReceiptRecordIds[0]);
 assert.deepEqual(receipt.data.params.requests,[]);assert.ok(c.links[0].adoptingSessionRecordId);
});

test('review carries up to three bounded zero-request receipts for one admission recovery',async t=>{
 const x=await partialSourceCustodyFixture(t,{admissionOnly:true,emptyReceiptCount:3}),p=buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),link=p.executionEvidence.incompleteTurnCustody.links[0];
 assert.equal(link.modelReceiptRecordIds.length,3);
 const receipts=x.h.store.records(x.p.id,'NativeBudgetReceipt').filter(row=>link.modelReceiptRecordIds.includes(row.id));
 assert.equal(receipts.length,3);assert.ok(receipts.every(row=>row.data.method==='dm/budget'&&Array.isArray(row.data.params.requests)&&row.data.params.requests.length===0));
});

test('a multi-receipt admission recovery still rejects any model request',async t=>{
 const x=await partialSourceCustodyFixture(t,{admissionOnly:true,emptyReceiptCount:3}),row=x.h.store.db.prepare(`SELECT r.id,r.data FROM records r
  JOIN records g ON g.run_id=r.run_id AND g.kind='DispatchGranted' AND json_extract(g.data,'$.dispatchId')=?
  JOIN records f ON f.run_id=r.run_id AND f.kind='DispatchFinished' AND json_extract(f.data,'$.dispatchId')=?
  WHERE r.run_id=? AND r.kind='NativeBudgetReceipt' AND r.rowid>g.rowid AND r.rowid<f.rowid ORDER BY r.rowid LIMIT 1`).get(x.failedDispatchId,x.failedDispatchId,x.r.id);
 const data=structuredClone(JSON.parse(row.data));data.params.requests.push({id:'OFFLINE_HIDDEN_REQUEST',observedModel:'OFFLINE_DSH',outcome:'COMPLETE',completionObserved:true,responseModelMatched:true});
 x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});
});

test('an unbounded admission receipt history is rejected',async t=>{
 const x=await partialSourceCustodyFixture(t,{admissionOnly:true,emptyReceiptCount:4});
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});
});

test('zero-model admission custody cannot carry a model request',async t=>{
 const x=await partialSourceCustodyFixture(t,{admissionOnly:true}),row=x.h.store.records(x.p.id,'NativeBudgetReceipt').find(r=>Array.isArray(r.data.params?.requests)&&r.data.params.requests.length===0);
 const data=structuredClone(row.data);data.params.requests.push({id:'OFFLINE_HIDDEN_REQUEST',observedModel:'OFFLINE_DSH',outcome:'COMPLETE',completionObserved:true,responseModelMatched:true});
 x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});
});

test('duplicate process identities cannot manufacture custody with a single cleanup',async t=>{
 const x=await partialSourceCustodyFixture(t,{duplicateProcess:true});assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});
});

test('a known foreign model response cannot hide beside one matching receipt',async t=>{
 const x=await partialSourceCustodyFixture(t),r=x.h.store.records(x.p.id,'NativeBudgetReceipt').find(r=>r.id===x.partialReceiptId),data=structuredClone(r.data);
 data.params.requests.push({...data.params.requests[0],id:'OFFLINE_FOREIGN_RESPONSE',observedModel:'FOREIGN_MODEL',responseModelMatched:false});x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),r.id);
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});
});

for(const [name,alter]of [
 ['completion flag',x=>{const r=x.h.store.records(x.p.id,'PartialRepairContinuation')[0],data={...r.data,taskCompletionAssumed:true};x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),r.id);}],
 ['missing original cleanup',x=>x.h.store.db.prepare("DELETE FROM records WHERE run_id=? AND kind='OwnedProcessCleanup' AND json_extract(data,'$.dispatchId')=?").run(x.r.id,x.failedDispatchId)],
 ['foreign cleanup generation',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.generation','FOREIGN') WHERE run_id=? AND kind='OwnedProcessCleanup' AND json_extract(data,'$.dispatchId')=?").run(x.r.id,x.failedDispatchId)],
 ['broken source chain',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.sourceHash',?) WHERE id=?").run('f'.repeat(64),x.resultId)],
 ['missing adoption snapshot',x=>x.h.store.db.prepare('DELETE FROM records WHERE id=?').run(x.beforeId)],
 ['foreign adopting generation',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.generation','FOREIGN') WHERE id=?").run(x.sessionId)],
 ['invented failed session completion',x=>x.h.store.record('AgentSession',x.p.id,x.r.id,{role:'executor',dispatchId:x.failedDispatchId,sessionId:'OFFLINE_FALSE_COMPLETION'})]
])test('custody rejects '+name,async t=>{const x=await partialSourceCustodyFixture(t);alter(x);assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});});

test('corrupt retained bytes cannot be carried as an intact source snapshot',async t=>{
 const x=await partialSourceCustodyFixture(t),row=x.h.store.records(x.p.id,'PartialRepairContinuation')[0],data=structuredClone(row.data);data.source.files[0].content+='OFFLINE_TAMPER';x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_SOURCE_SNAPSHOT_CORRUPT'});
});

test('custody supplements never bypass the original credential scanner',async t=>{
 const x=await partialSourceCustodyFixture(t),row=x.h.store.records(x.p.id,'PartialRepairContinuation')[0],data={...row.data,extra:'Authorization: Bearer OFFLINE_PRIVATE'};x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_SECRET_IN_MATERIAL'});
});

test('ordinary live packets without a failed-source retention do not gain synthetic custody',async t=>{
 const x=await reviewWindowFixture(t),p=buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s);assert.equal(Object.hasOwn(p.executionEvidence,'incompleteTurnCustody'),false);
});

test('a completed adopting session cannot hide a tool source hash inconsistent with its final snapshot',async t=>{
 const x=await partialSourceCustodyFixture(t);x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.sourceHash',?) WHERE id=?").run('f'.repeat(64),x.adoptResultId);
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});
});

for(const [name,alter]of [
 ['missing model receipts',requests=>[]],
 ['known foreign model',requests=>requests.map(q=>({...q,observedModel:'OFFLINE_FOREIGN_MODEL',responseModelMatched:false}))]
])test('a completed adopter cannot borrow the failed turn proof: '+name,async t=>{
 const x=await partialSourceCustodyFixture(t),row=x.h.store.records(x.p.id,'NativeBudgetReceipt').at(-1),data=structuredClone(row.data);
 data.params.requests=alter(data.params.requests);x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
 assert.throws(()=>buildReviewPacket(x.h.store,x.h.store.run(x.r.id),x.s),{code:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'});
});
