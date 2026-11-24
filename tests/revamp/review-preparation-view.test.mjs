// OFFLINE view contracts only. No account, native qualification or product review.
import test from 'node:test';import assert from 'node:assert/strict';
const load=()=>import('../../dist/web/review-preparation-view.js');
function snapshot(){return {project:{id:'OFFLINE_PROJECT',activeRunId:'OFFLINE_RUN'},runs:[{id:'OFFLINE_RUN',projectId:'OFFLINE_PROJECT',flowName:'classic',mode:'live',state:'BLOCKED',phase:'REVIEWING',reason:'REVIEW_PACKET_LIMIT',version:9,treeHash:'a'.repeat(64),review:null,verification:{ok:true},tasks:[{status:'implemented'}],calls:9,maxCalls:29,repairCount:0,maxRepairs:2,createdAt:'2026-11-05T08:32:25.811Z',maxSeconds:10136}],records:[{runId:'OFFLINE_RUN',kind:'ReviewPacket',data:{sha256:'b'.repeat(64)}}]};}
test('only the retained local pre-turn case offers a preparation action',async()=>{
 const m=await load(),s=snapshot();assert.equal(m.reviewPreparationBinding(s)?.packetHash,'b'.repeat(64));
 const html=m.reviewPreparationNotice(s,true);assert.match(html,/data-action="review-preparation"/);assert.match(html,/不调用模型/);
 assert.equal(m.reviewPreparationNotice(s,false),'');assert.doesNotMatch(m.reviewPreparationConfirmation(),/data-action="resume"/);
 assert.match(m.reviewPreparationConfirmation(),/name="reviewPreparationConsent" required/);
});
test('a cleaned pre-admission refusal offers the same no-model recovery action',async()=>{
 const m=await load(),s=snapshot();
 Object.assign(s.runs[0],{reason:'REVIEW_ADMISSION_BINDING_INVALID',calls:29,repairCount:2});
 const binding=m.reviewPreparationBinding(s);
 assert.equal(binding?.kind,'RECORDED_PACKET');
 assert.equal(binding?.packetHash,'b'.repeat(64));
 assert.match(m.reviewPreparationNotice(s,true),/data-action="review-preparation"/);
});
test('a stale role-probe binding offers the server-candidate source recovery, not the old packet',async()=>{
 const m=await load(),s=snapshot(),r=s.runs[0];
 Object.assign(r,{reason:'NATIVE_PROBE_MISSING',calls:r.maxCalls,repairCount:r.maxRepairs});
 s.records.push({runId:r.id,kind:'ReviewPacket',data:{sha256:'d'.repeat(64)}});
 r.reviewPreparationCandidate={kind:'SOURCE_VERSION',sourceHash:r.treeHash,version:r.version};
 const b=m.reviewPreparationBinding(s);
 assert.equal(b?.kind,'SOURCE_VERSION');
 assert.equal(b?.packetHash,null);
 assert.deepEqual(m.reviewPreparationRequest(b),{confirmed:true,bindingKind:'SOURCE_VERSION',sourceHash:r.treeHash,expectedVersion:r.version});
 const withoutCandidate=structuredClone(s);delete withoutCandidate.runs[0].reviewPreparationCandidate;
 assert.equal(m.reviewPreparationBinding(withoutCandidate),null);
 const wrongSource=structuredClone(s);wrongSource.runs[0].reviewPreparationCandidate.sourceHash='e'.repeat(64);
 assert.equal(m.reviewPreparationBinding(wrongSource),null);
});
test('probe missing and binding changed have distinct plain-language explanations',async()=>{
 const m=await load(),missing=m.reviewPreparationError('NATIVE_PROBE_MISSING'),changed=m.reviewPreparationError('NATIVE_PROBE_BINDING_CHANGED');
 assert.match(missing,/没有可用的角色最小调用|重新核验/);
 assert.match(changed,/源码或配置已更新|旧证明/);
 assert.notEqual(missing,changed);
});
for(const [name,alter]of [
 ['a verdict already exists',s=>s.runs[0].review={verdict:'BLOCKED'}],
 ['an actual review refusal',s=>s.runs[0].reason='REVIEW_BLOCKED'],
 ['custom',s=>s.runs[0].flowName='custom'],
 ['demo',s=>s.runs[0].mode='demo'],
 ['old inactive run',s=>s.project.activeRunId='OTHER'],
 ['foreign packet',s=>s.records[0].runId='OTHER'],
 ['bad packet binding',s=>s.records[0].data.sha256='<script>'],
 ['an unfinished task',s=>s.runs[0].tasks[0].status='running']
])test('no recovery button for '+name,async()=>{const m=await load(),s=snapshot();alter(s);assert.equal(m.reviewPreparationBinding(s),null);assert.equal(m.reviewPreparationNotice(s,true),'');});
test('response must preserve the original source, counters and deadline and remain paused',async()=>{
 const m=await load(),before=snapshot(),binding=m.reviewPreparationBinding(before),after=structuredClone(before);
 Object.assign(after.runs[0],{state:'PAUSED',reason:'REVIEW_PREPARATION_RECHECKED',version:10});
 assert.equal(m.readReviewPreparationResult(after,binding),after);
 for(const alter of [s=>s.runs[0].state='READY_FOR_DELIVERY',s=>s.runs[0].treeHash='c'.repeat(64),s=>s.runs[0].calls=0,s=>s.runs[0].maxSeconds++,s=>s.runs[0].createdAt='2026-11-05T10:00:00Z',s=>s.runs[0].review={verdict:'PASS'},s=>s.project.id='OTHER']){
  const bad=structuredClone(after);alter(bad);assert.throws(()=>m.readReviewPreparationResult(bad,binding),{code:'REVIEW_PREPARATION_RESPONSE_INVALID'});
 }
});
test('zero-packet action requires a fresh explicit server source/version candidate',async()=>{
 const m=await load(),s=snapshot();s.records=[];assert.equal(m.reviewPreparationBinding(s),null);
 s.runs[0].reviewPreparationCandidate={kind:'SOURCE_VERSION',sourceHash:s.runs[0].treeHash,version:s.runs[0].version};
 const b=m.reviewPreparationBinding(s);assert.equal(b.kind,'SOURCE_VERSION');assert.equal(b.packetHash,null);
 assert.deepEqual(m.reviewPreparationRequest(b),{confirmed:true,bindingKind:'SOURCE_VERSION',sourceHash:s.runs[0].treeHash,expectedVersion:9});
 for(const mutate of [s=>s.runs[0].reviewPreparationCandidate.sourceHash='c'.repeat(64),s=>s.runs[0].reviewPreparationCandidate.version++,s=>s.runs[0].reviewPreparationCandidate.kind='OTHER']){
  const wrong=structuredClone(s);mutate(wrong);assert.equal(m.reviewPreparationBinding(wrong),null);
 }
});
test('recorded packet request retains the original packet hash contract',async()=>{
 const m=await load(),binding=m.reviewPreparationBinding(snapshot());assert.equal(binding.kind,'RECORDED_PACKET');
 assert.deepEqual(m.reviewPreparationRequest(binding),{confirmed:true,packetHash:'b'.repeat(64)});
});
