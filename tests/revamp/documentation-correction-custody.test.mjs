// Original Engine/Store and actual local source copies; OFFLINE role/OS records only. No model.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';
import {documentationCorrectionFixture} from '../fixtures/documentation-correction.mjs';
import {hash} from '../../dist/server/security.js';

async function fixture(t,options={}){const x=await documentationCorrectionFixture(t,options),candidate=x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md');
 return {...x,candidate,actor:'local-session:'+'a'.repeat(64),request:{confirmed:true,file:'README.md',candidateHash:candidate.candidateHash}};}
const prepare=x=>(request=x.request,actor=x.actor)=>x.h.engine.prepareDocumentationCorrection(x.r.id,request,actor);
const rows=(x,kind)=>x.h.store.records(x.p.id,kind).filter(v=>v.runId===x.r.id);

test('prepare retains exact original source in owned staging without a new Run, lease, calls or model',async t=>{
 const x=await fixture(t),before=hash(x.h.store.run(x.r.id)),projects=hash(x.h.store.project(x.p.id)),runs=x.h.store.runs().length;
 const result=await prepare(x)();assert.equal(result.scope,'SOURCE_CUSTODY_ONLY');assert.equal(result.executionGranted,false);assert.equal(result.modelDispatched,false);assert.equal(result.additionalCallsGranted,0);
 assert.equal(result.sourceHash,x.r.treeHash);assert.equal(result.candidateHash,x.candidate.candidateHash);assert.equal(result.parentCalls,13);assert.equal(result.proposedAdditionalCalls,2);
 const saved=rows(x,'DocumentationCorrectionPrepared');assert.equal(saved.length,1);assert.equal(rows(x,'DocumentationCorrectionCustodyIntent').length,1);
 const source=join(x.h.dir,'controller','executor-waves',result.preparationId,'source');
 for(const path of ['main.mjs','README.md'])assert.deepEqual(readFileSync(join(source,path)),readFileSync(join(x.r.workspace,path)));
 assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(hash(x.h.store.project(x.p.id)),projects);assert.equal(x.h.store.runs().length,runs);assert.equal(x.h.store.owns(x.p.id,x.r.id),false);
 assert.equal(JSON.stringify(result).includes(x.h.dir),false);
});

test('same review reuses one copy across retries and actor changes, but revalidates retained bytes',async t=>{
 const x=await fixture(t),first=await prepare(x)(),again=await prepare(x)(x.request,'local-session:'+'b'.repeat(64));assert.deepEqual(again,first);assert.equal(rows(x,'DocumentationCorrectionPrepared').length,1);
 const source=join(x.h.dir,'controller','executor-waves',first.preparationId,'source');writeFileSync(join(source,'README.md'),'OFFLINE custody mutation');
 await assert.rejects(prepare(x)(),{code:'DOCUMENTATION_CUSTODY_CHANGED'});assert.equal(rows(x,'DocumentationCorrectionCustodyIntent').length,1);
});

test('explicit confirmation and exact candidate are required before preparation writes',async t=>{
 const x=await fixture(t),call=prepare(x);
 await assert.rejects(call({...x.request,confirmed:false}),{code:'DOCUMENTATION_CUSTODY_CONFIRMATION_REQUIRED'});
 await assert.rejects(call({...x.request,additionalCalls:9}),{code:'DOCUMENTATION_CUSTODY_INPUT_INVALID'});
 await assert.rejects(call({...x.request,candidateHash:'0'.repeat(64)}),{code:'DOCUMENTATION_CUSTODY_CHANGED'});
 assert.equal(rows(x,'DocumentationCorrectionCustodyIntent').length,0);
});

test('unknown process cleanup and a stable failed operation never produce another source copy',async t=>{
 const x=await fixture(t),db=x.h.store.db,row=db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='OwnedProcessCleanup' ORDER BY rowid DESC LIMIT 1").get(x.r.id);
 db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),cleanupReturned:false}),row.id);
 await assert.rejects(prepare(x)(),{code:'DOCUMENTATION_CORRECTION_UNAVAILABLE'});assert.equal(rows(x,'DocumentationCorrectionCustodyIntent').length,0);
 db.prepare('UPDATE records SET data=? WHERE id=?').run(row.data,row.id);
 const key='documentation-custody:'+x.r.id+':'+x.candidate.reviewRecordId;
 db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(key,hash({candidateHash:x.candidate.candidateHash}),'failed',null,new Date().toISOString());
 await assert.rejects(prepare(x)(),{code:'REQUEST_RESULT_UNCERTAIN'});assert.equal(rows(x,'DocumentationCorrectionCustodyIntent').length,0);
});

test('a preparation replay rejects changed original bytes without modifying parent state',async t=>{
 const x=await fixture(t);await prepare(x)();const before=hash(x.h.store.run(x.r.id));writeFileSync(join(x.r.workspace,'main.mjs'),'OFFLINE changed parent');
 await assert.rejects(prepare(x)(),{code:'EXTERNAL_WORKSPACE_CHANGE'});assert.equal(hash(x.h.store.run(x.r.id)),before);assert.equal(rows(x,'DocumentationCorrectionPrepared').length,1);
});

test('a crash after the durable Intent preserves the partial copy and forbids another attempt',async t=>{
 const x=await fixture(t),original=x.h.store.record.bind(x.h.store);let partial;
 const mocked=t.mock.method(x.h.store,'record',(kind,pid,rid,data)=>{
  const result=original(kind,pid,rid,data);if(kind==='DocumentationCorrectionCustodyIntent'){
   partial=join(x.h.dir,'controller','executor-waves',data.preparationId,'source');mkdirSync(partial,{recursive:true});writeFileSync(join(partial,'README.md'),'OFFLINE retained partial');throw Error('OFFLINE_CRASH_AFTER_DURABLE_INTENT');
  }return result;
 });
 await assert.rejects(prepare(x)(),/OFFLINE_CRASH_AFTER_DURABLE_INTENT/);mocked.mock.restore();
 await assert.rejects(prepare(x)(x.request,'local-session:'+'b'.repeat(64)),{code:'REQUEST_RESULT_UNCERTAIN'});
 assert.equal(readFileSync(join(partial,'README.md'),'utf8'),'OFFLINE retained partial');assert.equal(rows(x,'DocumentationCorrectionCustodyIntent').length,1);assert.equal(rows(x,'DocumentationCorrectionPrepared').length,0);
});

test('preparation is tracked by original shutdown and cannot publish after close begins',async t=>{
 const x=await fixture(t),work=prepare(x)(),denied=assert.rejects(work,{code:'ENGINE_PAUSING'});assert.equal(x.h.engine.activeJobCount,1);
 await x.h.engine.close();await denied;assert.equal(x.h.engine.activeJobCount,0);assert.equal(rows(x,'DocumentationCorrectionCustodyIntent').length,0);
});

test('self-consistent changed cached metadata cannot grant execution authority on replay',async t=>{
 const x=await fixture(t),first=await prepare(x)(),db=x.h.store.db,row=db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='DocumentationCorrectionPrepared'").get(x.r.id),saved=JSON.parse(row.data),{sha256,...body}=saved;
 body.result={...first,executionGranted:true,additionalCallsGranted:2};
 db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...body,sha256:hash(body)}),row.id);
 db.prepare('UPDATE requests SET response=? WHERE key=?').run(JSON.stringify(body.result),'documentation-custody:'+x.r.id+':'+x.candidate.reviewRecordId);
 await assert.rejects(prepare(x)(),{code:'DOCUMENTATION_CUSTODY_CHANGED'});
});

test('self-consistent changed stored ownership proof is rejected against current original inspection',async t=>{
 const x=await fixture(t);await prepare(x)();const db=x.h.store.db,row=rows(x,'DocumentationCorrectionPrepared')[0],{sha256,...body}=row.data;
 body.proof={...body.proof,basisSha256:'0'.repeat(64)};db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...body,sha256:hash(body)}),row.id);
 const intent=rows(x,'DocumentationCorrectionCustodyIntent')[0];db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...intent.data,proofHash:hash(body.proof)}),intent.id);
 await assert.rejects(prepare(x)(),{code:'DOCUMENTATION_CUSTODY_CHANGED'});
});

test('copy preflight reserves original staging allocation for actual file and directory count',async t=>{
 const extra=Object.fromEntries(Array.from({length:12},(_,i)=>['nested/'+i+'/small.txt','x'])),x=await fixture(t,{sourceFiles:extra});let reserved;
 const original=x.h.engine.executorSlices.reserveRecovery.bind(x.h.engine.executorSlices);t.mock.method(x.h.engine.executorSlices,'reserveRecovery',(bytes,nodes)=>{reserved={bytes,nodes};return original(bytes,nodes);});
 await prepare(x)();assert.ok(reserved,'original storage allocation guard used');assert.ok(reserved.nodes>=28,'14 files and at least14 new directories must be reserved');assert.ok(reserved.bytes>12);
});
