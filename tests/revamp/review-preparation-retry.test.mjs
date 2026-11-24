// OFFLINE Store gate tests. Synthetic records do not qualify a product role or review.
import test from 'node:test';import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';import {hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';
import {buildReviewPacket} from '../../dist/server/review-packet.js';
import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
const modulePath='../../dist/server/review-preparation-retry.js';
async function rig(t,priorReview=false){
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{};
 const created=h.engine.create(p.id,s.hash,true),r=h.store.run(created.id);
 Object.assign(r,{mode:'live',state:'BLOCKED',phase:'REVIEWING',reason:'REVIEW_PACKET_LIMIT',treeHash:'a'.repeat(64),review:null,tasks:[{id:'T1',status:'implemented'}],verification:{ok:true,treeHash:'a'.repeat(64),evidenceId:'OFFLINE_EVIDENCE'}});
 h.store.saveRun(r);
 if(priorReview){r.sessions.reviewer='OFFLINE_OLD_REVIEWER';r.roleIdentities={...r.roleIdentities,reviewer:{sessionId:r.sessions.reviewer}};h.store.saveRun(r);h.store.record('Review',p.id,r.id,{source:'CODEX',treeHash:'b'.repeat(64),verdict:'CHANGES_REQUESTED'});}
 const packet={schema:'dream-maker.review-packet.v1',runId:r.id,specHash:r.specHash,...(priorReview?{sourceHistory:[{treeHash:r.treeHash}]}:{})};
 const packetHash=hash(packet);h.store.record('ReviewPacket',p.id,r.id,{sha256:packetHash,packet});
 h.store.record('DispatchGranted',p.id,r.id,{dispatchId:'OFFLINE_REVIEW_DISPATCH',kind:'reviewer',mode:'live',generation:'OFFLINE_GENERATION'});
 h.store.record('DispatchFinished',p.id,r.id,{dispatchId:'OFFLINE_REVIEW_DISPATCH',generation:'OFFLINE_GENERATION',outcome:'REVIEW_PACKET_LIMIT',cleanupReturned:true});
 return {h,r,packetHash,gate:(await import(modulePath)).reviewPreparationBasis};
}
async function postReviewRepairRig(t,reason='REVIEW_PACKET_LIMIT'){
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{};
 const created=h.engine.create(p.id,s.hash,true),r=h.store.run(created.id);
 Object.assign(r,{mode:'live',flowName:'classic',state:'BLOCKED',phase:'REVIEWING',reason,
  treeHash:'a'.repeat(64),review:null,calls:5,maxCalls:13,repairCount:1,maxRepairs:2,attempt:8,
  tasks:[{id:'T1',status:'implemented'},{id:'T2',status:'implemented'}],
  verification:{ok:true,treeHash:'a'.repeat(64),evidenceId:'OFFLINE_CURRENT_EVIDENCE'}});
 r.sessions.reviewer='OFFLINE_OLD_REVIEWER';
 r.roleIdentities={...r.roleIdentities,reviewer:{sessionId:r.sessions.reviewer,runner:'CODEX_CLI',model:'OFFLINE_CODEX'}};
 h.store.saveRun(r);
 h.store.record('Review',p.id,r.id,{source:'CODEX',treeHash:'b'.repeat(64),verdict:'CHANGES_REQUESTED'});
 const packet={schema:'dream-maker.review-packet.v1',runId:r.id,specHash:r.specHash,sourceHistory:[{treeHash:'b'.repeat(64)}]},
  oldPacketHash=hash(packet);
 h.store.record('ReviewPacket',p.id,r.id,{sha256:oldPacketHash,packet});
 for(const [kind,dispatchId] of [['executor','OFFLINE_REPAIR'],['verifier','OFFLINE_VERIFY']]){
  const generation=`${dispatchId}_GENERATION`;
  h.store.record('DispatchQueued',p.id,r.id,{kind,dispatchId,generation});
  h.store.record('DispatchGranted',p.id,r.id,{kind,dispatchId,generation});
  h.store.record('DispatchFinished',p.id,r.id,{dispatchId,generation,outcome:'COMPLETED',cleanupReturned:true});
 }
 h.store.record('Step',p.id,r.id,{phase:'REVIEWING',specHash:r.specHash,treeHash:r.treeHash,attempt:r.attempt});
 h.store.event(p.id,r.id,'run.phase',{state:'REVIEWING',phase:'REVIEWING'});
 h.store.event(p.id,r.id,'step.started',{state:'REVIEWING',phase:'REVIEWING'});
 h.store.event(p.id,r.id,'run.blocked',{state:'BLOCKED',phase:'REVIEWING',reason});
 const newPacket={schema:'dream-maker.review-packet.v1',runId:r.id,specHash:r.specHash,sourceHistory:[{treeHash:r.treeHash}]},
  newPacketHash=hash(newPacket);
 return {h,r,p,s,oldPacketHash,newPacket,newPacketHash,gate:(await import(modulePath)).reviewPreparationBasis};
}
async function multiReviewCustodyRig(t){
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{};
 const created=h.engine.create(p.id,s.hash,true),r=h.store.run(created.id);
 Object.assign(r,{mode:'live',flowName:'classic',state:'BLOCKED',phase:'REVIEWING',
  reason:'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE',treeHash:'a'.repeat(64),review:null,calls:10,maxCalls:13,repairCount:2,maxRepairs:2,attempt:12,
  tasks:[{id:'T1',status:'implemented'},{id:'T2',status:'implemented'}],
  verification:{ok:true,treeHash:'a'.repeat(64),evidenceId:'OFFLINE_CURRENT_EVIDENCE'}});
 h.store.saveRun(r);
 const histories=['b'.repeat(64),'e'.repeat(64)],reviewerDispatches=[];
 const repairsByCycle=[
  [['executor','OFFLINE_REPAIR_1','COMPLETED'],['verifier','OFFLINE_VERIFY_1','COMPLETED']],
  [
   ['executor','OFFLINE_REPAIR_2A','REVIEW_PREPARATION_REPLAY_INVALID'],
   ['executor','OFFLINE_REPAIR_2B','RUNNER_RPC_ERROR'],
   ['executor','OFFLINE_REPAIR_2C','COMPLETED'],['verifier','OFFLINE_VERIFY_2','COMPLETED']
  ]
 ];
 for(const [cycle,historyHash] of histories.entries()){
  const packet={schema:'dream-maker.review-packet.v1',runId:r.id,specHash:r.specHash,sourceHistory:[{treeHash:historyHash}]},
   packetHash=hash(packet);h.store.record('ReviewPacket',p.id,r.id,{sha256:packetHash,packet});
  const dispatchId=`OFFLINE_REVIEWER_${cycle+1}`,generation=`OFFLINE_REVIEWER_GENERATION_${cycle+1}`,sessionId=`OFFLINE_REVIEWER_SESSION_${cycle+1}`;
  reviewerDispatches.push(dispatchId);
  h.store.record('DispatchQueued',p.id,r.id,{kind:'reviewer',mode:'live',dispatchId,generation});
  h.store.record('DispatchGranted',p.id,r.id,{kind:'reviewer',mode:'live',dispatchId,generation});
  h.store.record('DispatchFinished',p.id,r.id,{dispatchId,generation,outcome:'COMPLETED',cleanupReturned:true});
  h.store.record('AgentSession',p.id,r.id,{role:'reviewer',dispatchId,sessionId});
   h.store.record('Review',p.id,r.id,{source:'CODEX',treeHash:historyHash,verdict:'CHANGES_REQUESTED',findings:[],packetHash});
   for(const [kind,dispatchId,outcome] of repairsByCycle[cycle]){
    const repairGeneration=`${dispatchId}_GENERATION`;
    h.store.record('DispatchQueued',p.id,r.id,{kind,mode:'live',dispatchId,generation:repairGeneration});
    h.store.record('DispatchGranted',p.id,r.id,{kind,mode:'live',dispatchId,generation:repairGeneration});
    h.store.record('DispatchFinished',p.id,r.id,{dispatchId,generation:repairGeneration,outcome,cleanupReturned:true});
   }
 }
 const x={h,r,p,s,reviewerDispatches,lastPacketHash:hash({schema:'dream-maker.review-packet.v1',runId:r.id,specHash:r.specHash,
  sourceHistory:[{treeHash:histories.at(-1)}]}),gate:(await import(modulePath)).reviewPreparationBasis};
 x.newPacketHash='9'.repeat(64);attachReviewWindow(x);
 rewriteReviewWindow(x,body=>{body.sourceHash=histories[0];body.packetHash='8'.repeat(64);});
 const withWindow=h.store.run(r.id),waiver={
  schema:'dream-maker.task-deadline-waiver.v1',scope:'OWNER_PROJECT_TASK_DEADLINES_DISABLED',
  runId:withWindow.id,projectId:withWindow.projectId,specHash:withWindow.specHash,planVersionHash:withWindow.planVersionHash,
  flowConfigHash:withWindow.flowConfigHash,flowName:withWindow.flowName,sourceHashAtApproval:histories[0],
  originalCreatedAt:withWindow.createdAt,originalMaxSeconds:withWindow.maxSeconds,calls:9,maxCalls:withWindow.maxCalls,
  repairCount:withWindow.repairCount,maxRepairs:withWindow.maxRepairs,at:new Date().toISOString(),taskDeadline:null,
  technicalTimeoutsPreserved:true,actorHash:'f'.repeat(64),confirmed:true,modelDispatched:false
 };
 const waiverId=h.store.record('TaskDeadlineWaiverApproval',p.id,r.id,waiver);
 const current=h.store.run(r.id);current.taskDeadlineWaiver={recordId:waiverId,sha256:hash(waiver)};
 current.sessions.reviewer='OFFLINE_REVIEWER_SESSION_2';
 current.roleIdentities={...current.roleIdentities,reviewer:{sessionId:current.sessions.reviewer,runner:'CODEX_CLI',model:'OFFLINE_CODEX'}};
 h.store.saveRun(current);
 h.store.event(p.id,r.id,'run.task-deadline-waiver.approved',{recordId:waiverId,sha256:hash(waiver),taskDeadline:null,technicalTimeoutsPreserved:true,modelDispatched:false});
 h.store.record('Step',p.id,r.id,{phase:'REVIEWING',specHash:r.specHash,treeHash:r.treeHash,attempt:r.attempt});
 h.store.event(p.id,r.id,'run.phase',{state:'REVIEWING',phase:'REVIEWING'});
 h.store.event(p.id,r.id,'step.started',{state:'REVIEWING',phase:'REVIEWING'});
 h.store.event(p.id,r.id,'run.blocked',{state:'BLOCKED',phase:'REVIEWING',reason:r.reason});
 x.currentPacketHash=hash({schema:'dream-maker.review-packet.v1',runId:r.id,specHash:r.specHash,sourceHistory:[{treeHash:r.treeHash}]});
 return x;
}
function attachReviewWindow(x,approvalPacketHash=x.newPacketHash){
 const r=x.h.store.run(x.r.id);
 r.createdAt=new Date(Date.now()-10000).toISOString();r.maxSeconds=1;
 r.planVersionHash ||= 'c'.repeat(64);r.flowConfigHash ||= 'd'.repeat(64);
 x.h.store.saveRun(r);
 const proof={schema:'dream-maker.review-window-process-proofs.v1',runId:r.id,proofs:[]},
  proofId=x.h.store.record('ReviewWindowProcessProofs',r.projectId,r.id,proof),
  at=new Date().toISOString(),
  approval={schema:'dream-maker.review-window-approval.v1',runId:r.id,projectId:r.projectId,specHash:r.specHash,
   planVersionHash:r.planVersionHash,flowConfigHash:r.flowConfigHash,sourceHash:r.treeHash,evidenceId:r.verification.evidenceId,
   originalCreatedAt:r.createdAt,originalMaxSeconds:r.maxSeconds,
   originalDeadline:new Date(Date.parse(r.createdAt)+r.maxSeconds*1000).toISOString(),at,
   expiresAt:new Date(Date.parse(at)+7200*1000).toISOString(),seconds:7200,calls:r.calls,maxCalls:r.maxCalls,
   repairCount:r.repairCount,maxRepairs:r.maxRepairs,packetHash:approvalPacketHash,basisHash:'e'.repeat(64),
   actorHash:'f'.repeat(64),confirmed:true,modelDispatched:false,
   ownershipProofs:{recordId:proofId,sha256:hash(proof)}},
  recordId=x.h.store.record('ReviewWindowApproval',r.projectId,r.id,approval),
  sha256=hash(approval);
 const current=x.h.store.run(r.id);current.reviewWindow={recordId,sha256};x.h.store.saveRun(current);
 x.h.store.event(r.projectId,r.id,'run.review-window.approved',{recordId,sha256,expiresAt:approval.expiresAt,modelDispatched:false});
 return {recordId,sha256,approval};
}
function rewriteReviewWindow(x,mutate){
 const row=x.h.store.records(x.r.projectId,'ReviewWindowApproval')[0];
 mutate(row.data);
 x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(row.data),row.id);
 const sha256=hash(row.data),r=x.h.store.run(x.r.id);
 r.reviewWindow={...r.reviewWindow,sha256};x.h.store.saveRun(r);
 const event=x.h.store.db.prepare("SELECT id,payload FROM events WHERE run_id=? AND type='run.review-window.approved' ORDER BY id DESC LIMIT 1").get(x.r.id),
  payload=JSON.parse(event.payload);payload.sha256=sha256;
 x.h.store.db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(payload),event.id);
}
async function dispatchRecoveryRig(t){
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{};
 const created=h.engine.create(p.id,s.hash,true),r=h.store.run(created.id),source=treeHash(r.workspace),
  review={verdict:'CHANGES_REQUESTED',findings:[{id:'OFFLINE_F1',severity:'medium',description:'offline finding',evidence:'offline',status:'open'}],source:'CODEX',treeHash:source};
 Object.assign(r,{mode:'live',state:'BLOCKED',phase:'REPAIRING',reason:'REVIEW_PREPARATION_REPLAY_INVALID',treeHash:source,
  tasks:[{id:'T1',title:'OFFLINE',dependsOn:[],requirementIds:[s.requirements[0].id],acceptance:['OFFLINE'],writePaths:['main.mjs'],status:'implemented'}],
  verification:{ok:true,treeHash:source,evidenceId:'OFFLINE_EVIDENCE'},review,failedFingerprints:[hash(JSON.stringify(review.findings))],
  calls:6,maxCalls:13,repairCount:2,maxRepairs:2});
 h.store.saveRun(r);
 h.store.record('Review',p.id,r.id,review);
 const dispatchId='OFFLINE_EXECUTOR_REPAIR',generation='OFFLINE_EXECUTOR_REPAIR_GENERATION';
 h.store.record('DispatchQueued',p.id,r.id,{kind:'executor',mode:'live',dispatchId,generation});
 h.store.record('DispatchGranted',p.id,r.id,{kind:'executor',mode:'live',dispatchId,generation,cleanupReturned:false});
 h.store.record('DispatchFinished',p.id,r.id,{dispatchId,generation,outcome:r.reason,cleanupReturned:true});
 h.store.event(p.id,r.id,'run.blocked',{state:'BLOCKED',phase:'REPAIRING',reason:r.reason});
 return {h,r,p,s,source,dispatchId,generation,mod:await import(modulePath)};
}
const dispatchRecovery=async t=>{
 const x=await dispatchRecoveryRig(t);
 return {...x,basis:x.mod.reviewPreparationDispatchRecovery(x.h.store,x.h.store.run(x.r.id))};
};
test('an exact cleaned executor pre-turn rejection has a zero-model recovery basis',async t=>{
 const x=await dispatchRecovery(t);
 assert.equal(x.basis.dispatchId,x.dispatchId);
 assert.equal(x.basis.generation,x.generation);
 assert.equal(x.basis.sourceHash,x.source);
 assert.equal(x.basis.calls,x.r.calls);
 assert.equal(x.basis.repairCount,x.r.repairCount);
 assert.equal(x.h.store.records(x.p.id,'ReviewPreparationDispatchRecovery').length,0);
});
test('live resume reopens only that exact pre-turn rejection and preserves all counters',async t=>{
 const x=await dispatchRecoveryRig(t);x.h.engine.assertNativeReadyForRun=()=>{};let launched=0;x.h.engine.launch=()=>{launched++;};
 await assert.rejects(x.h.engine.resume(x.r.id),{code:'MANUAL_RECONCILIATION_REQUIRED'});
 assert.equal(x.h.store.records(x.p.id,'ReviewPreparationDispatchRecovery').length,0);
 const before=x.h.store.run(x.r.id),after=await x.h.engine.resume(x.r.id,true);
 assert.equal(after.state,'REPAIRING');assert.equal(after.reason,JSON.stringify(after.review.findings));
 assert.equal(hash(after.reason),after.failedFingerprints.at(-1));assert.equal(after.calls,before.calls);
 assert.equal(after.repairCount,before.repairCount);assert.equal(after.createdAt,before.createdAt);assert.equal(after.maxSeconds,before.maxSeconds);
 assert.equal(x.h.store.records(x.p.id,'ReviewPreparationDispatchRecovery').length,1);assert.equal(launched,1);
});
test('a pre-turn repair recovery requires the current findings to be the recorded failed cause',async t=>{
 const x=await dispatchRecoveryRig(t),r=x.h.store.run(x.r.id);r.failedFingerprints=[];x.h.store.saveRun(r);
 assert.throws(()=>x.mod.reviewPreparationDispatchRecovery(x.h.store,x.h.store.run(x.r.id)),{code:'REVIEW_PREPARATION_DISPATCH_RECOVERY_NOT_ALLOWED'});
});
for(const [name,mutate] of [
 ['an existing recovery',x=>x.h.store.record('ReviewPreparationDispatchRecovery',x.p.id,x.r.id,{dispatchId:x.dispatchId})],
 ['an owned process',x=>x.h.store.record('OwnedProcessIntent',x.p.id,x.r.id,{dispatchId:x.dispatchId,generation:x.generation,processId:'OFFLINE_PROCESS'})],
 ['an agent session',x=>x.h.store.record('AgentSession',x.p.id,x.r.id,{dispatchId:x.dispatchId,role:'executor'})],
 ['a tool side effect',x=>x.h.store.record('ToolIntent',x.p.id,x.r.id,{dispatchId:x.dispatchId,tool:'write_file'})],
 ['a later queued dispatch',x=>x.h.store.record('DispatchQueued',x.p.id,x.r.id,{kind:'executor',dispatchId:'OFFLINE_LATE_DISPATCH',generation:'OFFLINE_LATE_GENERATION'})],
 ['a review source mismatch',x=>{const row=x.h.store.records(x.p.id,'Review')[0];x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.source','OTHER') WHERE id=?").run(row.id);}],
 ['an unclean finish',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',0) WHERE run_id=? AND kind='DispatchFinished'").run(x.r.id)],
 ['a changed source',x=>{const current=x.h.store.run(x.r.id);current.treeHash='b'.repeat(64);x.h.store.saveRun(current);}],
 ['a changed outcome',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.outcome','COMPLETED') WHERE run_id=? AND kind='DispatchFinished'").run(x.r.id)],
 ['a missing block event',x=>x.h.store.db.prepare("DELETE FROM events WHERE run_id=? AND type='run.blocked'").run(x.r.id)]
])test('executor pre-turn recovery refuses '+name,async t=>{
 const x=await dispatchRecoveryRig(t);mutate(x);
 assert.throws(()=>x.mod.reviewPreparationDispatchRecovery(x.h.store,x.h.store.run(x.r.id)),{code:'REVIEW_PREPARATION_DISPATCH_RECOVERY_NOT_ALLOWED'});
});
test('only a clean local pre-turn packet rejection can produce a recovery basis, without changing Store',async t=>{
 const x=await rig(t),before=hash(x.h.store.run(x.r.id)),result=x.gate(x.h.store,x.r,x.packetHash);
 assert.equal(result.dispatchId,'OFFLINE_REVIEW_DISPATCH');assert.equal(result.packetHash,x.packetHash);
 assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(x.h.store.records(x.r.projectId,'Review').length,0);
});
test('a repaired source with older real-review history can prepare its clean current pre-turn rejection',async t=>{const x=await rig(t,true),before=hash(x.h.store.run(x.r.id)),basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.packetHash);assert.equal(basis.preDispatch,true);assert.equal(hash(x.h.store.run(x.r.id)),before);});
test('a current-source preparation marker prevents another repaired-source recovery',async t=>{const x=await rig(t,true);x.h.store.record('ReviewPreparationRecovery',x.r.projectId,x.r.id,{sourceHash:x.r.treeHash});assert.throws(()=>x.gate(x.h.store,x.h.store.run(x.r.id),x.packetHash));});
test('any current reviewer admission prevents the repaired-source pre-turn recovery',async t=>{const x=await rig(t,true);x.h.store.event(x.r.projectId,x.r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer'}});assert.throws(()=>x.gate(x.h.store,x.h.store.run(x.r.id),x.packetHash));});
test('a repaired source after a real review can rebuild the current final-review packet before reviewer dispatch',async t=>{
 const x=await postReviewRepairRig(t),before=hash(x.h.store.run(x.r.id)),
  basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true});
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRebuilt,true);
 assert.equal(basis.previousPacketHash,x.oldPacketHash);assert.equal(basis.packetHash,x.newPacketHash);
 assert.equal(basis.dispatchId,null);assert.equal(hash(x.h.store.run(x.r.id)),before);
 assert.deepEqual(x.h.engine.reviewPreparationCandidate(x.r.id),{kind:'SOURCE_VERSION',sourceHash:x.r.treeHash,version:x.r.version});
});
test('a repaired source blocked only by incomplete custody can rebuild the same final-review packet',async t=>{
 const x=await postReviewRepairRig(t,'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'),before=hash(x.h.store.run(x.r.id)),
  basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true});
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRebuilt,true);
 assert.equal(basis.preparationFailure,'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE');
 assert.equal(basis.previousPacketHash,x.oldPacketHash);assert.equal(basis.packetHash,x.newPacketHash);
 assert.equal(hash(x.h.store.run(x.r.id)),before);
 assert.deepEqual(x.h.engine.reviewPreparationCandidate(x.r.id),{kind:'SOURCE_VERSION',sourceHash:x.r.treeHash,version:x.r.version});
});
test('multiple completed real review cycles with an owner no-deadline waiver can rebuild only the current final packet',async t=>{
 const x=await multiReviewCustodyRig(t),before=hash(x.h.store.run(x.r.id)),
  basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.currentPacketHash,{allowPacketRebuild:true});
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRebuilt,true);
 assert.equal(basis.preparationFailure,'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE');
 assert.equal(basis.previousPacketHash,x.lastPacketHash);assert.equal(basis.packetHash,x.currentPacketHash);
 assert.equal(basis.dispatchId,null);assert.deepEqual(basis.dispatchIds,['OFFLINE_REPAIR_2A','OFFLINE_REPAIR_2B','OFFLINE_REPAIR_2C','OFFLINE_VERIFY_2']);
 assert.equal(hash(x.h.store.run(x.r.id)),before);
});
for(const [name,mutate]of [
 ['missing owner waiver',x=>{const r=x.h.store.run(x.r.id);delete r.taskDeadlineWaiver;x.h.store.saveRun(r);}],
 ['reviewer dispatch after the last completed review',x=>x.h.store.record('DispatchQueued',x.p.id,x.r.id,{kind:'reviewer',mode:'live',dispatchId:'OFFLINE_CURRENT_REVIEWER',generation:'OFFLINE_CURRENT_REVIEWER_GENERATION'})],
 ['unclean post-review verifier',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',0) WHERE run_id=? AND kind='DispatchFinished' AND json_extract(data,'$.dispatchId')='OFFLINE_VERIFY_2'").run(x.r.id)],
 ['historical review already represents the current source',x=>{const rows=x.h.store.records(x.p.id,'Review'),row=rows.at(-1);x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.treeHash',?) WHERE id=?").run(x.r.treeHash,row.id);}]
])test('multi-review custody recovery refuses '+name,async t=>{
 const x=await multiReviewCustodyRig(t);mutate(x);
 assert.throws(()=>x.gate(x.h.store,x.h.store.run(x.r.id),x.currentPacketHash,{allowPacketRebuild:true}),{code:'REVIEW_PREPARATION_RECOVERY_NOT_ALLOWED'});
});
test('an expired post-review repair offers only the original Engine time-window candidate',async t=>{
 const x=await postReviewRepairRig(t),expired=x.h.store.run(x.r.id);
 expired.createdAt=new Date(Date.now()-10000).toISOString();expired.maxSeconds=1;x.h.store.saveRun(expired);
 const current=x.h.store.run(x.r.id);
 assert.deepEqual(x.h.engine.reviewWindowCandidate(x.r.id),{kind:'EXPIRED_REVIEW_WINDOW',sourceHash:current.treeHash,version:current.version,maxSeconds:7200});
 assert.equal(x.h.store.records(x.r.projectId,'ReviewWindowApproval').length,0);
});
test('a post-review rebuild accepts exactly the original window approval appended after its block',async t=>{
 const x=await postReviewRepairRig(t);attachReviewWindow(x);
 const basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true});
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRebuilt,true);assert.equal(basis.packetHash,x.newPacketHash);
 assert.deepEqual(x.h.engine.reviewPreparationCandidate(x.r.id),{kind:'SOURCE_VERSION',sourceHash:x.r.treeHash,version:x.h.store.run(x.r.id).version});
});
test('a valid technical window survives packet-only role-evidence requalification',async t=>{
 const x=await postReviewRepairRig(t),approvalPacketHash='9'.repeat(64);
 attachReviewWindow(x,approvalPacketHash);
 assert.notEqual(approvalPacketHash,x.newPacketHash);
 assert.deepEqual(x.h.engine.reviewPreparationCandidate(x.r.id),{kind:'SOURCE_VERSION',sourceHash:x.r.treeHash,version:x.h.store.run(x.r.id).version});
 const basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true});
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRebuilt,true);
 assert.equal(basis.packetHash,x.newPacketHash);assert.equal(basis.approvalPacketHash,approvalPacketHash);
});
for(const [name,mutate]of [
 ['window source mismatch',body=>{body.sourceHash='8'.repeat(64);}],
 ['window verifier evidence mismatch',body=>{body.evidenceId='OFFLINE_OTHER_EVIDENCE';}],
 ['window packet digest malformed',body=>{body.packetHash='NOT_A_SHA256';}]
])test('technical-window recovery refuses '+name,async t=>{
 const x=await postReviewRepairRig(t);attachReviewWindow(x,'9'.repeat(64));rewriteReviewWindow(x,mutate);
 assert.throws(()=>x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true}));
});
for(const reason of ['REVIEW_PACKET_LIMIT','REVIEW_CUSTODY_EVIDENCE_INCOMPLETE'])test('post-review packet rebuild reserves a new reviewer call instead of replaying the old review: '+reason,async t=>{
 const x=await postReviewRepairRig(t,reason),basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true});
 x.h.store.record('ReviewPreparationRecovery',x.r.projectId,x.r.id,{...basis,actorHash:'a'.repeat(64),
  sourceHash:x.r.treeHash,specHash:x.r.specHash,planVersionHash:x.r.planVersionHash,calls:x.r.calls,repairCount:x.r.repairCount,
  createdAt:x.r.createdAt,maxSeconds:x.r.maxSeconds,modelDispatched:false});
 const paused=x.h.store.run(x.r.id);paused.state='PAUSED';paused.reason='REVIEW_PREPARATION_RECHECKED';x.h.store.saveRun(paused);
 x.h.store.record('ReviewPacket',x.r.projectId,x.r.id,{packet:x.newPacket,sha256:x.newPacketHash});
 const dispatchId='OFFLINE_REBUILT_REVIEW',generation='OFFLINE_REBUILT_GENERATION';
 x.h.store.record('DispatchGranted',x.r.projectId,x.r.id,{kind:'reviewer',mode:'live',dispatchId,generation});
 const mod=await import(modulePath);
 assert.equal(mod.reserveReviewPreparationReplay(x.h.store,x.h.store.run(x.r.id),'reviewer',{dispatchId,generation}),false);
 assert.equal(x.h.store.records(x.r.projectId,'ReviewPreparationReplayReservation').length,0);
});
test('an executor repair never consumes or validates reviewer preparation replay state',async t=>{
 const x=await postReviewRepairRig(t),basis=x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true});
 x.h.store.record('ReviewPreparationRecovery',x.r.projectId,x.r.id,{...basis,actorHash:'a'.repeat(64),
  sourceHash:x.r.treeHash,specHash:x.r.specHash,planVersionHash:x.r.planVersionHash,calls:x.r.calls,repairCount:x.r.repairCount,
  createdAt:x.r.createdAt,maxSeconds:x.r.maxSeconds,modelDispatched:false});
 const dispatchId='OFFLINE_EXECUTOR_REPAIR',generation='OFFLINE_EXECUTOR_REPAIR_GENERATION';
 x.h.store.record('DispatchGranted',x.r.projectId,x.r.id,{kind:'executor',mode:'live',dispatchId,generation});
 const mod=await import(modulePath),before=x.h.store.run(x.r.id);
 assert.equal(mod.reserveReviewPreparationReplay(x.h.store,before,'executor',{dispatchId,generation}),false);
 const after=x.h.store.run(x.r.id);
 assert.equal(after.calls,before.calls);
 assert.equal(x.h.store.records(x.r.projectId,'ReviewPreparationReplayReservation').length,0);
});
for(const [name,mutate]of [
 ['reviewer queued after review',x=>x.h.store.record('DispatchQueued',x.r.projectId,x.r.id,{kind:'reviewer',dispatchId:'OFFLINE_LATE_REVIEWER'})],
 ['reviewer admission after review',x=>x.h.store.event(x.r.projectId,x.r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer'}})],
 ['reviewer session mismatch',x=>{const r=x.h.store.run(x.r.id);r.sessions.reviewer='OFFLINE_OTHER_REVIEWER';x.h.store.saveRun(r);}],
 ['old review is current source',x=>{const row=x.h.store.records(x.r.projectId,'Review')[0];x.h.store.db.prepare('UPDATE records SET data=json_set(data,\'$.treeHash\',?) WHERE id=?').run(x.r.treeHash,row.id);}],
 ['saved packet already current',x=>{const row=x.h.store.records(x.r.projectId,'ReviewPacket')[0];row.data.packet.sourceHistory[0].treeHash=x.r.treeHash;x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(row.data),row.id);}],
 ['current preparation already recorded',x=>x.h.store.record('ReviewPreparationRecovery',x.r.projectId,x.r.id,{sourceHash:x.r.treeHash})],
 ['missing current block event',x=>x.h.store.db.prepare("DELETE FROM events WHERE run_id=? AND type='run.blocked'").run(x.r.id)],
 ['unfinished verifier dispatch',x=>x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',0) WHERE run_id=? AND kind='DispatchFinished' AND json_extract(data,'$.dispatchId')='OFFLINE_VERIFY'").run(x.r.id)]
])test('post-review packet recovery refuses '+name,async t=>{
 const x=await postReviewRepairRig(t);mutate(x);
 assert.throws(()=>x.gate(x.h.store,x.h.store.run(x.r.id),x.newPacketHash,{allowPacketRebuild:true}));
});
async function localRig(t,reason='REVIEW_PACKET_LIMIT'){
 const x=await rig(t);x.h.store.db.prepare("DELETE FROM records WHERE run_id=? AND kind IN ('ReviewPacket','DispatchGranted','DispatchFinished')").run(x.r.id);
 x.h.store.record('Step',x.r.projectId,x.r.id,{phase:'REVIEWING',specHash:x.r.specHash,treeHash:x.r.treeHash,attempt:x.r.attempt});
 const current=x.h.store.run(x.r.id);current.reason=reason;x.h.store.saveRun(current);x.r=current;
 x.h.store.event(x.r.projectId,x.r.id,'run.blocked',{state:'BLOCKED',phase:'REVIEWING',reason});
 return x;
}
async function localRoleEvidenceReservationRig(t){
  const x=await reviewWindowFixture(t,{configure:h=>{h.config.codex.model='OFFLINE_CODEX_REVIEWER';}}),
    current=x.h.store.run(x.r.id);
  current.reason='REVIEW_ROLE_EVIDENCE_REQUIRED';current.maxSeconds=3600;x.h.store.saveRun(current);
  x.h.store.event(current.projectId,current.id,'run.blocked',{state:'BLOCKED',phase:'REVIEWING',reason:current.reason});
  fixedControllerCapacity(x.h.engine);
  x.h.engine.nativeExecution={assertReady:()=>{},executor(){throw Error('EXECUTOR_FORBIDDEN');},
    verify:async()=>{throw Error('VERIFIER_FORBIDDEN');},close:async()=>{}};
  const prepared=await x.h.engine.prepareUndispatchedReviewRetry(current.id,current.treeHash,current.version,x.actor),
    packet=buildReviewPacket(x.h.store,prepared,x.h.store.spec(prepared.specId)),
    dispatchId='OFFLINE_MATERIAL_REVIEW',generation='OFFLINE_MATERIAL_REVIEW_GENERATION';
  return {x,current,prepared,packet,dispatchId,generation,mod:await import(modulePath)};
}

test('Custom local role-evidence failure can rebuild only before any Reviewer dispatch',async t=>{
 const x=await localRig(t,'REVIEW_ROLE_EVIDENCE_REQUIRED'),r={...x.r,flowName:'custom',flowConfig:{...x.r.flowConfig,mode:'custom'}};
 const before=hash(x.h.store.run(r.id)),basis=x.gate(x.h.store,r,x.packetHash);
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRecordId,null);assert.equal(basis.dispatchId,null);
 assert.equal(basis.packetHash,x.packetHash);assert.equal(hash(x.h.store.run(r.id)),before);
});
for(const [name,change] of [
 ['another failure reason',({r})=>{r.reason='REVIEW_PACKET_LIMIT';}],
 ['Reviewer already queued',({h,r})=>h.store.record('DispatchQueued',r.projectId,r.id,{kind:'reviewer',dispatchId:'OFFLINE_ALREADY_QUEUED'})],
 ['a saved review packet',({h,r,packetHash})=>h.store.record('ReviewPacket',r.projectId,r.id,{sha256:packetHash,packet:{}})],
 ['missing executor cleanup',({h,r})=>h.store.record('DispatchGranted',r.projectId,r.id,{kind:'executor',dispatchId:'OFFLINE_UNSETTLED',generation:'OFFLINE_GEN'})],
 ['a Reviewer result',({h,r})=>h.store.record('AgentSession',r.projectId,r.id,{role:'reviewer',sessionId:'OFFLINE_OLD_REVIEWER'})]
])test('Custom role-evidence recovery refuses '+name,async t=>{
 const x=await localRig(t,'REVIEW_ROLE_EVIDENCE_REQUIRED'),r={...x.r,flowName:'custom',flowConfig:{...x.r.flowConfig,mode:'custom'}};change({...x,r});
 assert.throws(()=>x.gate(x.h.store,r,x.packetHash),{code:'REVIEW_PREPARATION_RECOVERY_NOT_ALLOWED'});
});
test('local packet construction failure before any reviewer dispatch retains an explicit new-material binding',async t=>{
 const x=await localRig(t),before=hash(x.h.store.run(x.r.id)),basis=x.gate(x.h.store,x.r,x.packetHash);
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRecordId,null);assert.equal(basis.dispatchId,null);
 assert.equal(basis.packetHash,x.packetHash);assert.equal(hash(x.h.store.run(x.r.id)),before);
});
test('local role-evidence packet construction failure can rebuild once before reviewer dispatch',async t=>{
 const x=await localRig(t,'REVIEW_ROLE_EVIDENCE_REQUIRED'),before=hash(x.h.store.run(x.r.id)),basis=x.gate(x.h.store,x.r,x.packetHash);
 assert.equal(basis.preDispatch,true);assert.equal(basis.packetRecordId,null);assert.equal(basis.dispatchId,null);
 assert.equal(basis.packetHash,x.packetHash);assert.equal(hash(x.h.store.run(x.r.id)),before);
});
test('resuming a role-evidence packet recovery dispatches exactly one Reviewer and no earlier role',async t=>{
 const x=await reviewWindowFixture(t,{configure:h=>{h.config.codex.model='OFFLINE_CODEX_REVIEWER';}}),current=x.h.store.run(x.r.id);
 current.reason='REVIEW_ROLE_EVIDENCE_REQUIRED';current.maxSeconds=3600;x.h.store.saveRun(current);
 x.h.store.event(current.projectId,current.id,'run.blocked',{state:'BLOCKED',phase:'REVIEWING',reason:current.reason});
 fixedControllerCapacity(x.h.engine);
 const calls={planner2:0,executor:0,verifier:0,reviewer:0};
 x.h.engine.nativeExecution={assertReady:()=>{},
  executor(){calls.executor++;throw Error('EXECUTOR_FORBIDDEN');},
  verify:async()=>{calls.verifier++;throw Error('VERIFIER_FORBIDDEN');},
  close:async()=>{},
  codex(input){
   if(input.role==='planner2')calls.planner2++;
   if(input.role!=='reviewer')throw Error('NON_REVIEWER_FORBIDDEN');
   return{run:async(input,emit)=>{
    calls.reviewer++;
    const ownership=currentProcessOwnership(),processId='OFFLINE_ROLE_EVIDENCE_REVIEW_PROCESS',
     identity={runner:'CODEX_CLI',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',model:x.h.config.codex.model,
      sessionId:'OFFLINE_ROLE_EVIDENCE_REVIEWER',requestId:'OFFLINE_ROLE_EVIDENCE_REVIEW_TURN'};
    assert.equal(identity.model,input.model);assert.ok(identity.sessionId);
    x.h.store.record('OwnedProcessIntent',x.p.id,input.runId,{dispatchId:ownership.dispatchId,generation:ownership.generation,processId,platform:'win32'});
    emit({method:'dm/codexAdmission',params:{role:'reviewer',threadId:identity.sessionId,model:identity.model,
     provider:'openai',authentication:identity.authentication,includedUsageAllowed:true,paidFallback:false,
     permissionProfile:'dream-maker-supervisor-data',policyHash:'d'.repeat(64),
     reviewPacketHash:hash(JSON.parse(JSON.parse(input.prompt).taskData))}});
    emit({method:'dm/codexCompletion',params:{role:'reviewer',threadId:identity.sessionId,turnId:identity.requestId,
     model:identity.model,provider:'openai',status:'completed',runId:input.runId,specHash:input.specHash}});
    x.h.store.record('OwnedProcessCleanup',x.p.id,input.runId,{dispatchId:ownership.dispatchId,
     generation:ownership.generation,processId,cleanupReturned:true});
    return{text:'{"verdict":"PASS","findings":[]}',sessionId:identity.sessionId,model:identity.model,identity,
     usage:{role:'reviewer',requestId:identity.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'OFFLINE_TEST'}};
   }};
  }};
 const before=x.h.store.run(current.id),
  prepared=await x.h.engine.prepareUndispatchedReviewRetry(before.id,before.treeHash,before.version,x.actor);
 assert.equal(prepared.state,'PAUSED');assert.equal(prepared.reason,'REVIEW_PREPARATION_RECHECKED');
 assert.equal(prepared.calls,before.calls);assert.equal(prepared.repairCount,before.repairCount);
 x.h.engine.launch=Object.getPrototypeOf(x.h.engine).launch.bind(x.h.engine);
 await x.h.engine.resume(prepared.id);await x.h.engine.settled(prepared.id);
 const after=x.h.store.run(prepared.id);
 assert.equal(after.state,'READY_FOR_DELIVERY',JSON.stringify({state:after.state,reason:after.reason,calls:after.calls}));
 assert.deepEqual(calls,{planner2:0,executor:0,verifier:0,reviewer:1});
 assert.equal(after.review.verdict,'PASS');
 assert.equal(after.calls,before.calls+1);assert.equal(after.repairCount,before.repairCount);
 assert.deepEqual(x.h.store.records(x.p.id,'DispatchGranted').map(row=>row.data.kind),['reviewer']);
 assert.equal(x.h.store.records(x.p.id,'Review').length,1);
 const reservations=x.h.store.records(x.p.id,'ReviewPreparationReplayReservation');
 assert.equal(reservations.length,1);assert.equal(reservations[0].data.replayedCall,false);
 await assert.rejects(x.h.engine.resume(after.id),{code:'RUN_NOT_RESUMABLE'});
});
test('a role-evidence material reservation is consumed at most once',async t=>{
  const x=await localRoleEvidenceReservationRig(t),packetHash=hash(x.packet);
  x.x.h.store.record('ReviewPacket',x.x.p.id,x.x.r.id,{packet:x.packet,sha256:packetHash});
  x.x.h.store.record('DispatchGranted',x.x.p.id,x.x.r.id,{kind:'reviewer',mode:'live',dispatchId:x.dispatchId,generation:x.generation});
  assert.equal(x.mod.reserveReviewPreparationReplay(x.x.h.store,x.x.h.store.run(x.x.r.id),'reviewer',
    {dispatchId:x.dispatchId,generation:x.generation}),false);
  assert.throws(()=>x.mod.reserveReviewPreparationReplay(x.x.h.store,x.x.h.store.run(x.x.r.id),'reviewer',
    {dispatchId:x.dispatchId,generation:x.generation}),{code:'REVIEW_PREPARATION_REPLAY_INVALID'});
  assert.equal(x.x.h.store.records(x.x.p.id,'ReviewPreparationReplayReservation').length,1);
});
test('a role-evidence material reservation requires the one current packet',async t=>{
  const x=await localRoleEvidenceReservationRig(t);
  x.x.h.store.record('DispatchGranted',x.x.p.id,x.x.r.id,{kind:'reviewer',mode:'live',dispatchId:x.dispatchId,generation:x.generation});
  assert.throws(()=>x.mod.reserveReviewPreparationReplay(x.x.h.store,x.x.h.store.run(x.x.r.id),'reviewer',
    {dispatchId:x.dispatchId,generation:x.generation}),{code:'REVIEW_PREPARATION_REPLAY_INVALID'});
  assert.equal(x.x.h.store.records(x.x.p.id,'ReviewPreparationReplayReservation').length,0);
});
for(const [name,record] of [
  ['review',h=>h.store.record('Review',h.p.id,h.r.id,{source:'CODEX',treeHash:h.r.treeHash,verdict:'PASS'})],
  ['reviewer session',h=>h.store.record('AgentSession',h.p.id,h.r.id,{role:'reviewer',sessionId:'OFFLINE_LATE_REVIEWER'})]
])test('a role-evidence material reservation refuses an existing '+name,async t=>{
  const x=await localRoleEvidenceReservationRig(t);
  x.x.h.store.record('ReviewPacket',x.x.p.id,x.x.r.id,{packet:x.packet,sha256:hash(x.packet)});
  record({store:x.x.h.store,p:x.x.p,r:x.x.r});
  x.x.h.store.record('DispatchGranted',x.x.p.id,x.x.r.id,{kind:'reviewer',mode:'live',dispatchId:x.dispatchId,generation:x.generation});
  assert.throws(()=>x.mod.reserveReviewPreparationReplay(x.x.h.store,x.x.h.store.run(x.x.r.id),'reviewer',
    {dispatchId:x.dispatchId,generation:x.generation}),{code:'REVIEW_PREPARATION_REPLAY_INVALID'});
  assert.equal(x.x.h.store.records(x.x.p.id,'ReviewPreparationReplayReservation').length,0);
});
test('only server-verified zero-dispatch source/version is exposed as a UI candidate',async t=>{
 const x=await localRig(t),before=hash(x.h.store.run(x.r.id));
 assert.deepEqual(x.h.engine.reviewPreparationCandidate(x.r.id),{kind:'SOURCE_VERSION',sourceHash:x.r.treeHash,version:x.r.version});
 assert.equal(hash(x.h.store.run(x.r.id)),before);
 x.h.store.record('DispatchQueued',x.r.projectId,x.r.id,{kind:'reviewer'});
 assert.equal(x.h.engine.reviewPreparationCandidate(x.r.id),null);
});
for(const [name,mutate]of [
 ['missing step',x=>x.h.store.db.prepare("DELETE FROM records WHERE run_id=? AND kind='Step'").run(x.r.id)],
 ['wrong source step',x=>x.h.store.record('Step',x.r.projectId,x.r.id,{phase:'REVIEWING',specHash:x.r.specHash,treeHash:'b'.repeat(64),attempt:x.r.attempt})],
 ['reviewer queued',x=>x.h.store.record('DispatchQueued',x.r.projectId,x.r.id,{kind:'reviewer'})],
 ['reviewer admission',x=>x.h.store.event(x.r.projectId,x.r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer'}})],
 ['unfinished earlier dispatch',x=>x.h.store.record('DispatchGranted',x.r.projectId,x.r.id,{dispatchId:'UNSETTLED',kind:'executor'})],
 ['missing failure trail',x=>x.h.store.db.prepare("DELETE FROM events WHERE run_id=? AND type='run.blocked'").run(x.r.id)]
])test('local pre-dispatch preparation refuses '+name,async t=>{const x=await localRig(t);mutate(x);assert.throws(()=>x.gate(x.h.store,x.r,x.packetHash));});
for(const [name,mutate]of [
 ['review verdict',x=>{x.r.review={verdict:'BLOCKED'};}],
 ['different reason',x=>{x.r.reason='REVIEW_BLOCKED';}],
 ['Custom flow',x=>{x.r.flowName='custom';}],
 ['unfinished task',x=>{x.r.tasks[0].status='running';}],
 ['expired original wall',x=>{x.r.createdAt='2000-01-01T00:00:00Z';}],
 ['call limit',x=>{x.r.calls=x.r.maxCalls;}],
 ['completed reviewer identity',x=>{x.r.roleIdentities={reviewer:{sessionId:'OFFLINE'}};}],
 ['prior recovery',x=>{x.h.store.record('ReviewPreparationRecovery',x.r.projectId,x.r.id,{});}],
 ['uncertain cleanup',x=>{x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',0) WHERE run_id=? AND kind='DispatchFinished'").run(x.r.id);}],
 ['prior reviewer admission',x=>{x.h.store.event(x.r.projectId,x.r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer'}});}],
 ['saved packet corruption',x=>{x.h.store.db.prepare("UPDATE records SET data=json_set(data,'$.packet.specHash','changed') WHERE run_id=? AND kind='ReviewPacket'").run(x.r.id);}],
 ['wrong caller packet binding',x=>{x.packetHash='b'.repeat(64);}]
])test('preparation retry refuses '+name+' without creating review or accepting',async t=>{
 const x=await rig(t);mutate(x);assert.throws(()=>x.gate(x.h.store,x.r,x.packetHash));
 assert.equal(x.h.store.records(x.r.projectId,'Review').length,0);assert.notEqual(x.h.store.run(x.r.id).state,'ACCEPTED');
});
