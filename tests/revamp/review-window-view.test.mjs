// OFFLINE view contracts. No real time approval, account or model request.
import test from 'node:test';import assert from 'node:assert/strict';
const load=()=>import('../../dist/web/review-window-view.js');
function snapshot(){return {project:{id:'P',activeRunId:'R'},runs:[{id:'R',projectId:'P',mode:'live',flowName:'classic',state:'BLOCKED',phase:'REVIEWING',reason:'REVIEW_PACKET_LIMIT',version:7,treeHash:'a'.repeat(64),review:null,calls:4,maxCalls:13,repairCount:1,maxRepairs:2,createdAt:'2026-11-05T13:32:05.672Z',maxSeconds:1800,reviewWindowCandidate:{kind:'EXPIRED_REVIEW_WINDOW',sourceHash:'a'.repeat(64),version:7,maxSeconds:7200}}]};}
test('an explicit server candidate enables only a separate bounded time confirmation',async()=>{
 const m=await load(),s=snapshot(),b=m.reviewWindowBinding(s);assert.ok(b);
 assert.match(m.reviewWindowNotice(s,true),/data-action="review-window"/);assert.equal(m.reviewWindowNotice(s,false),'');
 assert.match(m.reviewWindowConfirmation(),/name="reviewWindowConsent" required/);
 assert.match(m.reviewWindowConfirmation(),/<select[^>]*name="reviewWindowSeconds"/);
 assert.doesNotMatch(m.reviewWindowConfirmation(),/checked|data-action="resume"/);
 assert.deepEqual(m.reviewWindowRequest(b,900),{confirmed:true,sourceHash:b.sourceHash,expectedVersion:7,seconds:900});
 for(const n of [0,59,7201,NaN,60.5])assert.throws(()=>m.reviewWindowRequest(b,n));
});
test('missing, stale, foreign and already-approved candidates never offer time approval',async()=>{
 const m=await load();
 for(const alter of [s=>delete s.runs[0].reviewWindowCandidate,s=>s.runs[0].reviewWindowCandidate.version++,s=>s.runs[0].reviewWindowCandidate.sourceHash='b'.repeat(64),s=>s.runs[0].reviewWindow={},s=>s.project.activeRunId='other',s=>s.runs[0].flowName='custom',s=>s.runs[0].review={verdict:'PASS'},s=>s.runs[0].mode='demo']){
  const s=snapshot();alter(s);assert.equal(m.reviewWindowBinding(s),null);
 }
});
test('time approval response remains blocked and preserves source, counters and original clock',async()=>{
 const m=await load(),s=snapshot(),b=m.reviewWindowBinding(s),after=structuredClone(s);
 after.runs[0].version++;after.runs[0].reviewWindow={recordId:'receipt',sha256:'b'.repeat(64)};
 assert.equal(m.readReviewWindowResult(after,b),after);
 for(const alter of [s=>s.runs[0].state='REVIEWING',s=>s.runs[0].calls=0,s=>s.runs[0].maxSeconds++,s=>s.runs[0].repairCount=0,s=>s.runs[0].treeHash='c'.repeat(64),s=>s.project.id='other',s=>s.runs[0].review={verdict:'PASS'}]){
  const bad=structuredClone(after);alter(bad);assert.throws(()=>m.readReviewWindowResult(bad,b));
 }
});
