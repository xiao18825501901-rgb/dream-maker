import test from 'node:test';
import assert from 'node:assert/strict';
import {customReviewTransportRetryFixture,updateReceipt} from '../fixtures/custom-review-transport-retry.mjs';
import {hash} from '../../dist/server/security.js';
import {root} from '../helpers.mjs';

async function basis(x){
 const {readOnlyReviewRetryBasis}=await import('../../dist/server/review-transport-retry.js');
 return readOnlyReviewRetryBasis(
  x.h.store,
  x.h.store.run(x.runId),
  x.h.config,
  root,
  x.currentPacket,
 );
}

test('a Custom Reviewer JSON parse failure is recoverable only with the original packet and one appended failed receipt',async t=>{
 const x=await customReviewTransportRetryFixture(t);
 const value=await basis(x);
 assert.equal(value.recoveryKind,'CUSTOM_PARSE_FAILURE_ONE_SHOT');
 assert.equal(value.packetRecordId,x.packetRecordId);
 assert.equal(value.savedPacketHash,x.packetHash);
 assert.equal(value.retryPacketHash,hash(x.currentPacket));
 assert.equal(value.receiptRecordId,x.receiptRecordId);
 assert.equal(value.receiptOutcome,'MODEL_GATEWAY_UPSTREAM_JSON_INVALID');
 assert.equal(value.priorModelOutcome,'NOT_OBSERVED');
 assert.equal(value.priorUsage,'UNKNOWN_PRESERVED');
});

const rejections=[
 ['completed model output',x=>updateReceipt(x,'params.requests.0.completionObserved',true)],
 ['non-200 transport response',x=>updateReceipt(x,'params.requests.0.upstreamHttpStatus',403)],
 ['wrong protocol stage',x=>updateReceipt(x,'params.requests.0.protocolFailureStage','OBSERVE')],
 ['wrong terminal outcome',x=>updateReceipt(x,'params.requests.0.outcome','COMPLETE')],
 ['model output identified',x=>updateReceipt(x,'params.requests.0.outputTextHash','a'.repeat(64))],
 ['unexpected usage',x=>updateReceipt(x,'params.requests.0.usage',{inputTokens:1})],
 ['second reviewer grant',x=>x.h.store.record('DispatchGranted',x.p.id,x.runId,{dispatchId:'dispatch_second',kind:'reviewer',mode:'live',generation:'generation_second'})],
 ['missing owned-process cleanup',x=>updateRecord(x,'OwnedProcessCleanup',{cleanupReturned:false})],
 ['foreign cleanup generation',x=>updateRecord(x,'OwnedProcessCleanup',{generation:'foreign'})],
 ['previous recovery already prepared',x=>x.h.store.record('ReviewTransportRetryPreparation',x.p.id,x.runId,{dispatchId:x.dispatchId})],
 ['call ceiling exhausted',x=>{const run=x.h.store.run(x.runId);run.calls=run.maxCalls;x.h.store.saveRun(run);}],
 ['reviewer session already exists',x=>{const run=x.h.store.run(x.runId);run.sessions.reviewer='OFFLINE_REVIEWER_SESSION';x.h.store.saveRun(run);}],
 ['review already exists',x=>{const run=x.h.store.run(x.runId);run.review=new Proxy({verdict:'BLOCKED'},{});x.h.store.saveRun(run);}],
 ['packet changed beyond the failed receipt',x=>{x.currentPacket.plan={...x.currentPacket.plan,notes:'DRIFT'};}],
];

function updateRecord(x,kind,patch){
 const row=x.h.store.records(x.p.id,kind).at(-1);
 const data=JSON.parse(String(x.h.store.db.prepare('SELECT data FROM records WHERE id=?').get(row.id).data));
 x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...data,...patch}),row.id);
}

for(const [name,alter] of rejections){
 test('Custom parse recovery rejects '+name,async t=>{
  const x=await customReviewTransportRetryFixture(t);
  alter(x);
  await assert.rejects(()=>basis(x),{code:'REVIEW_TRANSPORT_RETRY_NOT_ALLOWED'});
 });
}

test('Custom parse recovery requires three distinct harnesses and models',async t=>{
 const x=await customReviewTransportRetryFixture(t,{diversified:false});
 await assert.rejects(()=>basis(x),{code:'REVIEW_TRANSPORT_RETRY_NOT_ALLOWED'});
});
