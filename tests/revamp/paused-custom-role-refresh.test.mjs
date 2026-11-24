// OFFLINE original Store fixtures; no accounts, models, Native qualification or product result claims.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';
import {customBudgetSupplementFixture} from '../fixtures/custom-budget-supplement.mjs';
import {CustomFlowPreparations} from '../../dist/server/custom-flow-preparation.js';
import {treeHash} from '../../dist/server/workspace.js';
async function fixture(t){const x=await customBudgetSupplementFixture(t),store=x.h.store;for(const r of store.runs(x.run.projectId).filter(r=>r.id!==x.run.id)){r.state='CANCELLED';r.reason='OFFLINE_SETUP_COMPLETE';store.saveRun(r);}const r=store.run(x.run.id);r.state='PAUSED';r.reason='EXECUTOR_CHECKPOINT_PREPARED';r.treeHash=treeHash(r.workspace);store.saveRun(r);const prepared=store.records(r.projectId,'CustomFlowPrepared').find(row=>row.data.flowConfig.runId===r.id).data;const ref={identityHash:prepared.identityHash,contentHash:prepared.contentHash};const grant=store.record('DispatchGranted',r.projectId,r.id,{dispatchId:'dispatch_'+'a'.repeat(20),generation:'dispatch_owner_'+'b'.repeat(20),kind:'executor',mode:'live',cleanupReturned:false});const finish=store.record('DispatchFinished',r.projectId,r.id,{dispatchId:'dispatch_'+'a'.repeat(20),generation:'dispatch_owner_'+'b'.repeat(20),cleanupReturned:true,outcome:'COMPLETED'});const service=new CustomFlowPreparations(store,()=>x.h.config);return{...x,store,r,prepared,ref,grant,finish,service,read:(reference=ref)=>service.prepare(r.projectId,r.specHash,r.flowConfig.profile.contentHash,reference)};}
test('exact prepared configuration is readable for same paused owned Flow without creating or changing anything',async t=>{const x=await fixture(t),before=x.store.run(x.r.id),records=x.store.records(x.r.projectId);assert.deepEqual(x.read(),x.prepared);assert.deepEqual(x.read(),x.prepared);assert.deepEqual(x.store.run(x.r.id),before);assert.deepEqual(x.store.records(x.r.projectId),records);assert.equal(x.store.owns(x.r.projectId,x.r.id),true);});
test('paused Flow still refuses unbound/new preparation and user profile or plan changes',async t=>{const x=await fixture(t);assert.throws(()=>x.service.prepare(x.r.projectId,x.r.specHash,x.r.flowConfig.profile.contentHash),{code:'FLOW_TERMINATION_REQUIRED'});assert.equal(x.store.records(x.r.projectId,'CustomFlowPrepared').length,1);});
for(const [name,change]of [
 ['active execution',x=>{const r=x.store.run(x.r.id);r.state=r.phase;x.store.saveRun(r);}],
 ['missing lease',x=>x.store.release(x.r.projectId,x.r.id)],
 ['workspace missing',x=>fs.renameSync(x.r.workspace,x.r.workspace+'-retained-offline-test')],
 ['workspace becomes a file',x=>{fs.renameSync(x.r.workspace,x.r.workspace+'-retained-offline-test');fs.writeFileSync(x.r.workspace,'OFFLINE_NOT_DIRECTORY');}],
 ['source changed',x=>fs.writeFileSync(join(x.r.workspace,'README.md'),'OFFLINE_CHANGED_SOURCE')],
 ['empty matching dispatch id',x=>x.store.db.prepare("UPDATE records SET data=json_set(data,'$.dispatchId','') WHERE id IN (?,?)").run(x.grant,x.finish)],
 ['malformed matching generation',x=>x.store.db.prepare("UPDATE records SET data=json_set(data,'$.generation','dispatch_owner_invalid') WHERE id IN (?,?)").run(x.grant,x.finish)],
 ['empty matching generation',x=>x.store.db.prepare("UPDATE records SET data=json_set(data,'$.generation','') WHERE id IN (?,?)").run(x.grant,x.finish)],
 ['missing cleanup',x=>x.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',json('false')) WHERE id=?").run(x.finish)],
 ['foreign cleanup generation',x=>x.store.db.prepare("UPDATE records SET data=json_set(data,'$.generation','foreign_generation') WHERE id=?").run(x.finish)],
 ['duplicate cleanup',x=>x.store.record('DispatchFinished',x.r.projectId,x.r.id,{dispatchId:'dispatch_'+'a'.repeat(20),generation:'dispatch_owner_'+'b'.repeat(20),cleanupReturned:true})],
 ['another unfinished Flow',x=>{const old=x.store.runs(x.r.projectId).find(r=>r.id!==x.r.id);old.state='PAUSED';x.store.saveRun(old);}],
 ['foreign active pointer',x=>{const p=x.store.project(x.r.projectId);p.activeRunId='run_OFFLINE_FOREIGN';x.store.saveProject(p);}]
])test('paused preparation remains blocked after '+name,async t=>{const x=await fixture(t);change(x);const before=x.store.records(x.r.projectId,'CustomFlowPrepared');assert.throws(()=>x.read());assert.deepEqual(x.store.records(x.r.projectId,'CustomFlowPrepared'),before);});
test('wrong immutable reference and engineering drift cannot become a replacement preparation',async t=>{const x=await fixture(t);assert.throws(()=>x.read({...x.ref,contentHash:'0'.repeat(64)}));x.h.config.limits.maxCalls++;assert.throws(()=>x.read());assert.equal(x.store.records(x.r.projectId,'CustomFlowPrepared').length,1);});

async function blockedReviewFixture(t,reason='REVIEW_ROLE_EVIDENCE_REQUIRED'){
 const x=await fixture(t),r=x.store.run(x.r.id);
 Object.assign(r,{state:'BLOCKED',phase:'REVIEWING',reason,review:null,
  verification:{ok:true,treeHash:r.treeHash,evidenceId:'OFFLINE_VERIFIER'},tasks:r.tasks.map(t=>({...t,status:'implemented'}))});
 x.store.saveRun(r);x.store.record('Step',r.projectId,r.id,{phase:r.phase,specHash:r.specHash,treeHash:r.treeHash,attempt:r.attempt});
 x.store.event(r.projectId,r.id,'run.blocked',{state:r.state,phase:r.phase,reason:r.reason});
 return{...x,r};
}
test('blocked first-review material recovery can refresh only its exact metadata without state or proof changes',async t=>{
 const x=await blockedReviewFixture(t),before=x.store.run(x.r.id),records=x.store.records(x.r.projectId);
 assert.deepEqual(x.read(),x.prepared);assert.deepEqual(x.store.run(x.r.id),before);assert.deepEqual(x.store.records(x.r.projectId),records);
 assert.equal(x.store.owns(x.r.projectId,x.r.id),true);
 assert.throws(()=>x.service.prepare(x.r.projectId,x.r.specHash,x.r.flowConfig.profile.contentHash),{code:'FLOW_TERMINATION_REQUIRED'});
});
test('blocked reviewer transport parse recovery can read only its exact frozen preparation metadata',async t=>{
 const x=await blockedReviewFixture(t,'UPSTREAM_HTTP_502'),before=x.store.run(x.r.id),records=x.store.records(x.r.projectId);
 assert.deepEqual(x.read(),x.prepared);assert.deepEqual(x.store.run(x.r.id),before);assert.deepEqual(x.store.records(x.r.projectId),records);
 assert.equal(x.store.owns(x.r.projectId,x.r.id),true);
 assert.throws(()=>x.service.prepare(x.r.projectId,x.r.specHash,x.r.flowConfig.profile.contentHash),{code:'FLOW_TERMINATION_REQUIRED'});
});
for(const[name,change]of[
 ['a Reviewer session',x=>{const r=x.store.run(x.r.id);r.sessions={...(r.sessions??{}),reviewer:'OFFLINE_REVIEWER_SESSION'};x.store.saveRun(r);}],
 ['a Reviewer identity',x=>{const r=x.store.run(x.r.id);r.roleIdentities={...(r.roleIdentities??{}),reviewer:{sessionId:'OFFLINE_REVIEWER_SESSION'}};x.store.saveRun(r);}],
 ['an existing transport retry',x=>x.store.record('ReviewTransportRetryPreparation',x.r.projectId,x.r.id,{modelDispatched:false})]
])test('transport parse metadata refresh refuses '+name,async t=>{
 const x=await blockedReviewFixture(t,'UPSTREAM_HTTP_502');change(x);const before=x.store.records(x.r.projectId);
 assert.throws(()=>x.read(),{code:'FLOW_TERMINATION_REQUIRED'});assert.deepEqual(x.store.records(x.r.projectId),before);
});
for(const[name,change]of[
 ['another block reason',x=>{const r=x.store.run(x.r.id);r.reason='PROCESS_CLEANUP_UNPROVEN';x.store.saveRun(r);}],
 ['an existing Reviewer queue',x=>x.store.record('DispatchQueued',x.r.projectId,x.r.id,{kind:'reviewer',dispatchId:'OFFLINE_REVIEWER'})],
 ['an existing ReviewPacket',x=>x.store.record('ReviewPacket',x.r.projectId,x.r.id,{packet:{},sha256:'a'.repeat(64)})],
 ['failed verification',x=>{const r=x.store.run(x.r.id);r.verification.ok=false;x.store.saveRun(r);}],
 ['exhausted call allowance',x=>{const r=x.store.run(x.r.id);r.calls=r.maxCalls;x.store.saveRun(r);}],
 ['lost cleanup',x=>x.store.db.prepare("UPDATE records SET data=json_set(data,'$.cleanupReturned',json('false')) WHERE id=?").run(x.finish)]
])test('blocked review metadata refresh refuses '+name,async t=>{
 const x=await blockedReviewFixture(t);change(x);const before=x.store.records(x.r.projectId);
 assert.throws(()=>x.read(),{code:'FLOW_TERMINATION_REQUIRED'});assert.deepEqual(x.store.records(x.r.projectId),before);
});
