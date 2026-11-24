// Isolated original Engine/Store/workspaces; explicitly OFFLINE identities. No product model evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {documentationCorrectionFixture} from '../fixtures/documentation-correction.mjs';import {hash} from '../../dist/server/security.js';
async function fixture(t){const x=await documentationCorrectionFixture(t,{includeMainTask:true}),candidate=x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md');
 return {...x,candidate,input:{confirmed:true,file:'README.md',candidateHash:candidate.candidateHash,taskDeadline:null},actor:'local-session:'+'a'.repeat(64)};}

test('approved preparation creates one paused original Run, with inherited plan/task provenance and exact protected source',async t=>{
 const x=await fixture(t),before=hash(x.h.store.run(x.r.id)),oldCount=x.h.store.runs().length;
 const child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor);
 assert.equal(child.state,'PAUSED');assert.equal(child.phase,'IMPLEMENTING');assert.equal(child.reason,'DOCUMENTATION_CONTINUATION_PREPARED');assert.equal(child.calls,0);assert.equal(child.maxCalls,2);assert.equal(child.maxRepairs,1);assert.equal(child.repairCount,0);
 assert.equal(child.treeHash,x.r.treeHash);assert.deepEqual(child.plan,x.r.plan);assert.equal(child.planVersionHash,x.r.planVersionHash);assert.equal(child.review,null);assert.equal(child.verification,null);
 assert.equal(child.roleIdentities?.planner2,undefined,'no current P2 role identity manufactured');assert.equal(child.sessions.planner2,undefined);assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(v=>v.runId===child.id).length,0);
 assert.equal(x.h.store.records(x.p.id,'Plan').filter(v=>v.runId===child.id).length,0,'original Plan referenced, not created anew');
 assert.deepEqual(child.tasks.filter(t=>t.status==='pending').map(t=>t.id),['OFFLINE_DOC']);
 assert.deepEqual(child.tasks.find(t=>t.id==='OFFLINE_MAIN').inheritedFrom,{runId:x.r.id,taskId:'OFFLINE_MAIN'});
 assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(x.h.store.runs().length,oldCount+1);assert.equal(x.h.store.project(x.p.id).activeRunId,child.id);assert.equal(x.h.store.owns(x.p.id,child.id),true);
 for(const path of ['main.mjs','README.md'])assert.deepEqual(readFileSync(join(child.workspace,path)),readFileSync(join(x.r.workspace,path)));
 assert.ok(child.documentationContinuation?.recordId);assert.equal(child.flowConfig.runId,child.id);
});

test('failed preparation transaction leaves parent, lease and counts unchanged, retains the Intent and forbids recopy',async t=>{
 const x=await fixture(t),before=hash(x.h.store.run(x.r.id)),original=x.h.store.insertRun.bind(x.h.store),mock=t.mock.method(x.h.store,'insertRun',()=>{throw Error('OFFLINE_BEFORE_RUN_COMMIT');});
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),/OFFLINE_BEFORE_RUN_COMMIT/);mock.mock.restore();
 assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(x.h.store.runs(x.p.id).length,1);assert.equal(x.h.store.project(x.p.id).activeRunId,x.r.id);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);
 assert.equal(x.h.store.records(x.p.id,'DocumentationContinuationIntent').length,1);assert.equal(x.h.store.records(x.p.id,'DocumentationContinuationApproval').length,0);
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{code:'REQUEST_RESULT_UNCERTAIN'});assert.equal(x.h.store.records(x.p.id,'DocumentationContinuationIntent').length,1);
});

test('fresh Engine/Store reopening reads the one original prepared successor without new Plan or source writes',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),before=hash(x.h.store.run(child.id));
 const {Store}=await import('../../dist/server/store.js'),{Engine}=await import('../../dist/server/engine.js'),{root}=await import('../helpers.mjs'),s=new Store(join(x.h.dir,'state.sqlite')),e=new Engine(s,x.h.laya,()=>x.h.config,root,x.h.dir,0);
 try{e.recover();const again=await e.approveDocumentationContinuation(x.r.id,x.input,x.actor);assert.equal(again.id,child.id);assert.equal(hash(s.run(child.id)),before);assert.equal(s.runs(x.p.id).length,2);assert.equal(s.records(x.p.id,'Plan').filter(r=>r.runId===child.id).length,0);}finally{await e.close();s.close();}
});

test('replay rejects altered inherited Plan and P2 references rather than fabricating new planning',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),db=x.h.store.db,row=db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='Plan'").get(x.r.id),data=JSON.parse(row.data);
 db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...data,plan:{tasks:[]}}),row.id);
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});assert.equal(x.h.store.run(child.id).calls,0);
});

test('different request keys or actor sessions cannot create another continuation from the same review',async t=>{
 const x=await fixture(t),first=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),again=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,'local-session:'+'b'.repeat(64));
 assert.equal(again.id,first.id);assert.equal(x.h.store.runs(x.p.id).length,2);
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,{...x.input,candidateHash:'0'.repeat(64)},x.actor),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});
});

test('preparation cannot invent time, call, model or path authority',async t=>{
 const x=await fixture(t),call=input=>x.h.engine.approveDocumentationContinuation(x.r.id,input,x.actor);
 await assert.rejects(call({...x.input,confirmed:false}),{code:'DOCUMENTATION_CONTINUATION_CONFIRMATION_REQUIRED'});
 for(const input of [{...x.input,maxCalls:99},{...x.input,taskDeadline:3600},{confirmed:true,file:'README.md',candidateHash:x.candidate.candidateHash}])await assert.rejects(call(input),{code:'DOCUMENTATION_CONTINUATION_INPUT_INVALID'});
 assert.equal(x.h.store.runs(x.p.id).length,1);assert.equal(x.h.store.owns(x.p.id,x.r.id),false);
});

test('a prepared continuation cannot dispatch without the original qualified runtime',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),before=hash(x.h.store.run(child.id));
 await assert.rejects(x.h.engine.resume(child.id),{code:'NATIVE_RUNTIME_FACTORY_REQUIRED'});
 assert.equal(hash(x.h.store.run(child.id)),before);assert.equal(child.calls,0);
});

test('direct internal launch cannot bypass the prepared continuation resume boundary',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{Engine}=await import('../../dist/server/engine.js');
 assert.throws(()=>Engine.prototype.launch.call(x.h.engine,child.id),{code:'DOCUMENTATION_CONTINUATION_RESUME_REQUIRED'});assert.equal(x.h.engine.activeJobCount,0);assert.equal(x.h.store.run(child.id).calls,0);
});

test('changed source on replay cannot be accepted as another prepared or executed continuation',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor);writeFileSync(join(child.workspace,'main.mjs'),'OFFLINE altered protected source');
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});assert.equal(x.h.store.runs(x.p.id).length,2);assert.equal(x.h.store.run(child.id).state,'PAUSED');
});

test('missing or substituted original P2 completion is refused before a successor can be created',async t=>{
 const x=await fixture(t),db=x.h.store.db,row=db.prepare("SELECT id,payload FROM events WHERE run_id=? AND type='agent.event' AND json_extract(payload,'$.method')='dm/codexCompletion' AND json_extract(payload,'$.params.role')='planner2'").get(x.r.id),event=JSON.parse(row.payload);
 db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify({...event,params:{...event.params,status:'interrupted'}}),row.id);
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});assert.equal(x.h.store.runs(x.p.id).length,1);
});

test('replay cannot invent task completion without a real executor turn',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),r=x.h.store.run(child.id);r.tasks.find(t=>t.id==='OFFLINE_DOC').status='done';x.h.store.saveRun(r);
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});
});

test('changing protected source and its recorded treeHash cannot redefine frozen preparation source',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor);writeFileSync(join(child.workspace,'main.mjs'),'OFFLINE new protected implementation');const {treeHash}=await import('../../dist/server/workspace.js'),r=x.h.store.run(child.id);r.treeHash=treeHash(child.workspace);x.h.store.saveRun(r);
 await assert.rejects(x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{code:'DOCUMENTATION_CONTINUATION_CHANGED'});
});

test('explicit approved null task deadline is the original effective clock, not just response metadata',async t=>{
 const x=await fixture(t),child=await x.h.engine.approveDocumentationContinuation(x.r.id,x.input,x.actor),{runDeadline}=await import('../../dist/server/review-window.js'),{checkDuration}=await import('../../dist/server/budget.js');
 t.mock.timers.setTime(Date.now()+365*86400*1000);
 assert.equal(runDeadline(x.h.store,x.h.store.run(child.id)),Infinity);assert.doesNotThrow(()=>checkDuration(x.h.store.run(child.id),x.h.store));assert.throws(()=>checkDuration(x.h.store.run(child.id)),{code:'REVIEW_WINDOW_STORE_REQUIRED'});
 assert.equal(x.h.store.run(x.r.id).createdAt,x.r.createdAt);assert.equal(x.h.store.run(child.id).createdAt,child.createdAt);
});
