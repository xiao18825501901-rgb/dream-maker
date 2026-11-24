// Synthetic records in the original isolated SQLite Store. No role/model or production actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chatEvidenceProjection} from '../../dist/server/chat-project.js';
import {hash} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';

function fixture(t) {
 const h=harness(t), p=h.interviews.create('证据投影合成用例','一个受控测试项目','demo');
 const s={id:'synthetic-spec',hash:'a'.repeat(64),stale:false};p.specId=s.id;p.activeRunId='synthetic-run';
 const r={id:p.activeRunId,projectId:p.id,version:8,specId:s.id,specHash:s.hash,mode:'live',state:'READY_FOR_DELIVERY',
  treeHash:'b'.repeat(64),prework:{contractId:'prework_'+ 'c'.repeat(64)},
  verification:{ok:true,treeHash:'b'.repeat(64),evidenceId:'synthetic-verification'},
  review:{verdict:'PASS',treeHash:'b'.repeat(64),source:'SYNTHETIC_BOUNDARY_TEST',findings:[]}};
 const binding={runId:r.id,runVersion:r.version,specHash:s.hash,reviewHash:hash(r.review),projectVersion:p.version};
 return {...h,p,s,r,binding};
}
function closeout(h,overrides={}) {
 return h.store.record('PreworkCloseout',h.p.id,h.r.id,{schema:'dm.prework.closeout.v1',contractId:h.r.prework.contractId,
  treeHash:h.r.treeHash,verificationEvidenceId:h.r.verification.evidenceId,coverageReached:true,
  matrix:[{requirementId:'R001',reached:true}],scope:'REAL_ROLE_AND_VERIFIER_EVIDENCE',...overrides});
}
test('bound feedback remains available after the recent-record window moves past it',t=>{
 const h=fixture(t);const id=h.store.record('SeekerReviewFeedback',h.p.id,h.r.id,{...h.binding,source:'MODEL',feedback:{summary:'合成边界记录'}});
 for(let i=0;i<110;i++)h.store.record('SyntheticAudit',h.p.id,h.r.id,{i});
 assert.equal(h.store.records(h.p.id).slice(-100).some(r=>r.id===id),false);
 const result=chatEvidenceProjection(h.store,h.p,h.r,h.s);
 assert.equal(result.reviewFeedback.id,id);assert.deepEqual(result.reviewFeedbackBinding,h.binding);
});
test('old review, run or project bindings cannot be reused as the current feedback',t=>{
 const h=fixture(t);
 for(const override of [{reviewHash:'d'.repeat(64)},{runVersion:7},{projectVersion:h.p.version+1},{specHash:'e'.repeat(64)}])
  h.store.record('SeekerReviewFeedback',h.p.id,h.r.id,{...h.binding,...override,source:'MODEL',feedback:{summary:'旧记录'}});
 assert.equal(chatEvidenceProjection(h.store,h.p,h.r,h.s).reviewFeedback,null);
});
test('Prework projection requires the current contract, tree, verifier and completed matrix',t=>{
 const h=fixture(t);
 for(const override of [{contractId:'other-contract'},{treeHash:'d'.repeat(64)},
  {verificationEvidenceId:'other-verifier'},{coverageReached:false},{matrix:[{requirementId:'R001',reached:false}]},
  {scope:'SYNTHETIC_DEMO_NOT_LIVE'}])closeout(h,override);
 assert.equal(chatEvidenceProjection(h.store,h.p,h.r,h.s).preworkCloseout,null);
 closeout(h);
 assert.deepEqual(chatEvidenceProjection(h.store,h.p,h.r,h.s).preworkCloseout,{
  contractId:h.r.prework.contractId,treeHash:h.r.treeHash,coverageReached:true,requirementIds:['R001']});
});
test('a stale or different current requirement version has no current completion projection',t=>{
 const h=fixture(t);closeout(h);
 for(const spec of [{...h.s,stale:true},{...h.s,id:'new-spec'},{...h.s,hash:'d'.repeat(64)}]) {
  const x=chatEvidenceProjection(h.store,h.p,h.r,spec);
  assert.equal(x.preworkCloseout,null);assert.equal(x.reviewFeedbackBinding,null);
 }
});
