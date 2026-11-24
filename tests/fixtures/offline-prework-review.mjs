// OFFLINE TEST ONLY. References the packet produced by this test's original
// Engine/verifier; never creates model receipts, cases, role identity or approval.
import assert from 'node:assert/strict';
import {assertOfflineHarness} from './offline-prework.mjs';
import {expandReviewTestDataPool} from '../../dist/server/review-source-pool.js';

export function offlinePreworkReview(h,runId){
 assertOfflineHarness(h);
 const run=h.store.run(runId);
 assert.ok(run.prework,'the test must reach the real mandatory handoff');
 const record=h.store.records(run.projectId,'ReviewPacket').filter(row=>row.runId===run.id).at(-1);
 assert.ok(record,'the original Engine must publish the review packet first');
 const packet=record.data.packet,contract=packet.prework.contract;
 assert.equal(contract.contractId,run.prework.contractId);
 const artifacts=packet.sourceHistory.at(-1).files.map(file=>file.path);
 const evidence=JSON.parse(expandReviewTestDataPool(packet).at(-1).data.stdout);
 const acceptance=h.store.spec(run.specId).acceptanceItems??[];
 const preworkCoverage=contract.requirements.map(req=>{
  const cases=evidence.cases.filter(item=>item.requirementIds.includes(req.requirementId));
  assert.ok(cases.length&&cases.every(item=>item.status==='EXECUTED'&&item.ok===true));
  assert.ok(artifacts.length);
  return{requirementId:req.requirementId,artifactPaths:artifacts,
   caseIds:cases.map(item=>item.id),acceptanceIds:acceptance.filter(item=>item.requirementIds.includes(req.requirementId)).map(item=>item.id)};
 });
 return{verdict:'PASS',findings:[],preworkCoverage};
}
