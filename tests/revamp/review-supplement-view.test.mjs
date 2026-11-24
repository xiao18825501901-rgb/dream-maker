// OFFLINE view and data-boundary tests, never real authorization or model evidence.
import test from 'node:test';import assert from 'node:assert/strict';
const load=()=>import('../../dist/web/review-supplement-view.js');
function snapshot(){return {project:{id:'P',activeRunId:'R',specId:'S'},spec:{id:'S',hash:'d'.repeat(64),stale:false},runs:[{id:'R',projectId:'P',specId:'S',specHash:'d'.repeat(64),mode:'live',flowName:'classic',state:'BLOCKED',phase:'REVIEWING',reason:'REVIEW_BLOCKED',version:79,treeHash:'a'.repeat(64),planVersionHash:'e'.repeat(64),flowConfigHash:'f'.repeat(64),verification:{ok:true,treeHash:'a'.repeat(64)},review:{verdict:'BLOCKED',treeHash:'a'.repeat(64),source:'CODEX',findings:[]},tasks:[{id:'T1',status:'implemented'}],calls:13,maxCalls:13,repairCount:2,maxRepairs:2,createdAt:'2026-11-05T12:00:00.000Z',maxSeconds:10800}]};}
function candidate(){return {candidate:{sourceHash:'a'.repeat(64),expectedVersion:79,packetHash:'b'.repeat(64),previousReviewRecordId:'rec_OFFLINE',additionalCalls:1,scope:'REVIEWER_ONLY_NO_REPAIR',modelDispatched:false}};}
test('local notice only offers a separate bounded review confirmation, never starts a role',async()=>{
 const m=await load(),s=snapshot(),b=m.reviewSupplementBinding(s);assert.ok(b);assert.match(m.reviewSupplementNotice(s,true),/data-action="review-supplement"/);assert.equal(m.reviewSupplementNotice(s,false),'');
 const preview=m.readReviewSupplementPreview(candidate(),b),html=m.reviewSupplementConfirmation(preview);assert.match(html,/name="reviewSupplementConsent" required/);assert.doesNotMatch(html,/\bchecked\b|data-action="resume"|name="(?:seconds|maxCalls|apiKey|token)"/);
 assert.deepEqual(m.reviewSupplementRequest(preview),{confirmed:true,sourceHash:'a'.repeat(64),expectedVersion:79,packetHash:'b'.repeat(64),previousReviewRecordId:'rec_OFFLINE'});
});
test('stale or incompatible local states never offer supplemental authority',async()=>{
 const m=await load();for(const alter of [s=>s.project.activeRunId='other',s=>s.spec.stale=true,s=>s.runs[0].mode='demo',s=>s.runs[0].flowName='custom',s=>s.runs[0].calls--,s=>s.runs[0].review.verdict='PASS',s=>s.runs[0].review.treeHash='f'.repeat(64),s=>s.runs[0].verification.ok=false,s=>s.runs[0].verification.treeHash='f'.repeat(64),s=>s.runs[0].tasks[0].status='pending',s=>s.runs[0].reviewSupplement={}]){const s=snapshot();alter(s);assert.equal(m.reviewSupplementBinding(s),null);}
});
test('server preview cannot silently enlarge or retarget the single review',async()=>{
 const m=await load(),b=m.reviewSupplementBinding(snapshot());for(const alter of [v=>v.candidate.expectedVersion++,v=>v.candidate.sourceHash='c'.repeat(64),v=>v.candidate.packetHash='not-a-hash',v=>v.candidate.additionalCalls=2,v=>v.candidate.scope='BUILD',v=>v.candidate.modelDispatched=true]){const v=candidate();alter(v);assert.throws(()=>m.readReviewSupplementPreview(v,b));}
});
test('compact acknowledgement and refreshed state must preserve source, original counters and verdict',async()=>{
 const m=await load(),s=snapshot(),preview=m.readReviewSupplementPreview(candidate(),m.reviewSupplementBinding(s)),ref={recordId:'rec_APPROVAL',sha256:'c'.repeat(64)},raw={runId:'R',state:'PAUSED',version:80,sourceHash:'a'.repeat(64),calls:13,maxCalls:13,reviewSupplement:ref,additionalCalls:1,modelDispatched:false};
 const ack=m.readReviewSupplementResult(raw,preview),after=structuredClone(s);Object.assign(after.runs[0],{state:'PAUSED',reason:'REVIEW_SUPPLEMENT_PREPARED',version:80,reviewSupplement:ref});assert.equal(m.readReviewSupplementSnapshot(after,preview,ack),after);
 for(const alter of [v=>v.calls=0,v=>v.additionalCalls=2,v=>v.state='REVIEWING',v=>v.runId='other',v=>v.version=81,v=>v.reviewSupplement.sha256='bad']){const v=structuredClone(raw);alter(v);assert.throws(()=>m.readReviewSupplementResult(v,preview));}
 for(const alter of [v=>v.runs[0].review.verdict='PASS',v=>v.runs[0].repairCount=0,v=>v.runs[0].maxSeconds++,v=>v.runs[0].treeHash='d'.repeat(64),v=>v.runs[0].reviewSupplement.recordId='foreign',v=>v.spec.id='other',v=>v.runs[0].verification.ok=false,v=>v.runs[0].verification.treeHash='d'.repeat(64),v=>v.runs[0].tasks=[],v=>v.runs[0].tasks[0].status='pending']){const v=structuredClone(after);alter(v);assert.throws(()=>m.readReviewSupplementSnapshot(v,preview,ack));}
});

test('confirmation binding is invalidated by changes in source, run, counters, configuration or review',async()=>{
 const m=await load(),before=m.reviewSupplementBinding(snapshot());assert.equal(m.sameReviewSupplementBinding(structuredClone(before),before),true);assert.equal(m.sameReviewSupplementBinding(null,before),false);
 for(const alter of [b=>b.projectId='other',b=>b.runId='other',b=>b.version++,b=>b.sourceHash='e'.repeat(64),b=>b.calls--,b=>b.flowConfigHash='b'.repeat(64),b=>b.planVersionHash='b'.repeat(64),b=>b.originalReview.verdict='PASS',b=>b.createdAt='2026-11-06T12:00:00.000Z']){const b=structuredClone(before);alter(b);assert.equal(m.sameReviewSupplementBinding(b,before),false);}
});
