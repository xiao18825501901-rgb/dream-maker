// Original Store/Engine/files with explicit OFFLINE role records. No model, role qualification or execution authority.
import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
import {documentationCorrectionFixture as fixture} from '../fixtures/documentation-correction.mjs';
import {hash} from '../../dist/server/security.js';

test('original Engine freezes a read-only documentation candidate without model, source, approval or call mutation',async t=>{
 const x=await fixture(t),before=hash(x.h.store.run(x.r.id)),count=x.h.store.db.prepare('SELECT count(*) n FROM records').get().n;
 assert.equal(typeof x.h.engine.documentationCorrectionCandidate,'function');const c=x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md');
 assert.equal(c.executionGranted,false);assert.equal(c.roleQualification,'NOT_CHECKED_BY_CANDIDATE');assert.deepEqual(c.writePaths,['README.md']);assert.equal(c.taskId,'OFFLINE_DOC');assert.equal(c.sourceHash,x.r.treeHash);assert.ok(c.protectedFileExamples.some(v=>v.path==='main.mjs'));assert.match(c.candidateHash,/^[a-f0-9]{64}$/);
 assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM records').get().n,count);assert.equal(x.h.store.owns(x.p.id,x.r.id),false);
});
test('code files, unknown files, broad planned scopes and missing same-source review cannot propose a documentation correction',async t=>{
 const x=await fixture(t),read=p=>x.h.engine.documentationCorrectionCandidate(x.r.id,p);
 for(const p of ['main.mjs','../README.md','config/local.json','missing.md'])assert.throws(()=>read(p),{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
 const r=x.h.store.run(x.r.id);r.tasks[0].writePaths=['README.md','main.mjs'];x.h.store.saveRun(r);assert.throws(()=>read('README.md'),{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
 r.tasks[0].writePaths=['README.md'];r.review.treeHash='0'.repeat(64);x.h.store.saveRun(r);assert.throws(()=>read('README.md'),{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
});
test('unknown review process outcome, wrong packet and substituted role identity remain ineligible',async t=>{
 const x=await fixture(t),read=()=>x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md'),db=x.h.store.db;
 const row=db.prepare('SELECT data FROM records WHERE id=?').get(x.reviewId),original=JSON.parse(row.data);db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...original,packetHash:'0'.repeat(64)}),x.reviewId);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});db.prepare('UPDATE records SET data=? WHERE id=?').run(row.data,x.reviewId);
 const end=db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='DispatchFinished' ORDER BY rowid DESC LIMIT 1").get(x.r.id);db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(end.data),cleanupReturned:false}),end.id);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});db.prepare('UPDATE records SET data=? WHERE id=?').run(end.data,end.id);
 const r=x.h.store.run(x.r.id);r.roleIdentities.reviewer.sessionId='OFFLINE_FOREIGN';x.h.store.saveRun(r);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
});
test('external source edits and a project that switched its active Flow invalidate the read-only candidate',async t=>{
 const x=await fixture(t),read=()=>x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md');writeFileSync(x.r.workspace+'/README.md','# OFFLINE external edit');assert.throws(read,{code:'EXTERNAL_WORKSPACE_CHANGE'});
 writeFileSync(x.r.workspace+'/README.md','# OFFLINE documentation\nExample needs correction.\n');const p=x.h.store.project(x.p.id);p.activeRunId='OFFLINE_OTHER_FLOW';x.h.store.saveProject(p);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
});

test('reviewer request identity cannot be substituted while preserving the same session',async t=>{
 const x=await fixture(t),db=x.h.store.db,read=()=>x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md'),row=db.prepare('SELECT data FROM records WHERE id=?').get(x.sessionId),original=JSON.parse(row.data);
 for(const requestId of ['','OFFLINE_DIFFERENT_TURN']){
  db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...original,requestId}),x.sessionId);
  assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'},`session requestId=${requestId}`);
 }
 db.prepare('UPDATE records SET data=? WHERE id=?').run(row.data,x.sessionId);assert.equal(read().executionGranted,false);
 const r=db.prepare('SELECT data FROM runs WHERE id=?').get(x.r.id),stored=JSON.parse(r.data);delete stored.roleIdentities.reviewer.requestId;
 db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(stored),x.r.id);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
});

test('original AgentSession schema without requestId uses unique dispatch-bound completion, never patched history',async t=>{
 const x=await fixture(t),db=x.h.store.db,read=()=>x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md'),row=db.prepare('SELECT data FROM records WHERE id=?').get(x.sessionId),data=JSON.parse(row.data);delete data.requestId;
 db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),x.sessionId);
 assert.equal(read().executionGranted,false);
 const event=db.prepare('SELECT payload FROM events WHERE id=?').get(x.completionId),payload=JSON.parse(event.payload);
 for(const modified of [{...payload,dispatchId:'OFFLINE_OTHER'}, {...payload,params:{...payload.params,turnId:'OFFLINE_OTHER_TURN'}}, {...payload,params:{...payload.params,status:'interrupted'}}]){
  db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(modified),x.completionId);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
 }
 db.prepare('UPDATE events SET payload=? WHERE id=?').run(event.payload,x.completionId);
 x.h.store.event(x.p.id,x.r.id,'agent.event',payload);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
});

test('ordinary REPAIR_LIMIT uses unchanged untagged official completion plus adjacent original UsageLedger',async t=>{
 const x=await fixture(t),db=x.h.store.db,row=db.prepare('SELECT data FROM records WHERE id=?').get(x.sessionId),session=JSON.parse(row.data);delete session.requestId;db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(session),x.sessionId);
 const event=db.prepare('SELECT payload FROM events WHERE id=?').get(x.completionId),payload=JSON.parse(event.payload);delete payload.dispatchId;delete payload.generation;db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(payload),x.completionId);
 const read=()=>x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md');assert.equal(read().executionGranted,false);
 const usage=db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='UsageLedger' AND json_extract(data,'$.requestId')=?").get(x.r.id,'OFFLINE_DOC_REVIEW_TURN');
 db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(usage.data),requestId:'OFFLINE_FOREIGN_TURN'}),usage.id);assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
});

test('duplicate owned-process intents cannot reuse a single cleanup proof',async t=>{
 const x=await fixture(t,{secondProcess:true}),db=x.h.store.db,read=()=>x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md');
 const intent=db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='OwnedProcessIntent' ORDER BY rowid DESC LIMIT 1").get(x.r.id),second=JSON.parse(intent.data),firstId=second.processId.replace(/_SECOND$/,'');
 db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...second,processId:firstId}),intent.id);
 const cleanup=db.prepare("SELECT id FROM records WHERE run_id=? AND kind='OwnedProcessCleanup' AND json_extract(data,'$.processId')=?").get(x.r.id,second.processId);db.prepare('UPDATE records SET kind=? WHERE id=?').run('OFFLINE_UNUSED_RECORD',cleanup.id);
 assert.throws(read,{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});
});
