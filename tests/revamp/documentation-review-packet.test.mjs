import {savePreworkResult} from '../../dist/server/prework/runtime.js';
// Protocol only: explicit OFFLINE synthetic model/verifier records in isolated original Store.
// These records are never installed into product/formal data or treated as actual model evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
import {documentationCorrectionFixture} from '../fixtures/documentation-correction.mjs';import {hash} from '../../dist/server/security.js';import {treeHash} from '../../dist/server/workspace.js';
import {captureSource,buildReviewPacket} from '../../dist/server/review-packet.js';
async function fixture(t,{publishResult=true}={}){
 const x=await documentationCorrectionFixture(t,{includeMainTask:true}),c=x.h.engine.documentationCorrectionCandidate(x.r.id,'README.md'),child=await x.h.engine.approveDocumentationContinuation(x.r.id,{confirmed:true,file:'README.md',candidateHash:c.candidateHash,taskDeadline:null},x.actor),s=x.h.store,r=s.run(child.id),record=(kind,data)=>s.record(kind,x.p.id,r.id,kind==='SourceSnapshot'?data:{fixtureProvenance:'OFFLINE_ONLY_NOT_PRODUCT_QUALIFICATION',...data});
 const before=r.treeHash,dispatchId='OFFLINE_PACKET_DISPATCH',generation='OFFLINE_PACKET_GENERATION',taskId=r.tasks.find(t=>!t.inheritedFrom).id;
 record('DispatchGranted',{dispatchId,generation,kind:'executor',mode:'live'});
 record('SourceSnapshot',captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'EXECUTOR_BEFORE'));
 const intentId=record('ToolIntent',{tool:'desk_write',specHash:r.specHash,sourceHash:before,requestHash:hash('OFFLINE_PACKET_WRITE')});
 writeFileSync(join(r.workspace,'README.md'),'# OFFLINE corrected documentation\n');r.treeHash=treeHash(r.workspace);
 record('ToolResult',{intentId,tool:'desk_write',specHash:r.specHash,status:'COMPLETE',sourceHash:r.treeHash,responseHash:hash('OFFLINE_PACKET_RESULT')});
 record('SourceSnapshot',captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'EXECUTOR_AFTER'));record('SourceSnapshot',captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'VERIFIER_INPUT'));
 const original=JSON.parse(s.db.prepare('SELECT data FROM records WHERE id=?').get(x.r.verification.evidenceId).data),raw=JSON.parse(original.stdout);raw.sourceHash=r.treeHash;raw.cases=raw.cases.map(v=>({...v,sourceHash:r.treeHash,jobId:'OFFLINE_CHILD_CASE_NOT_EXECUTED'}));
 const evidenceId=record('Evidence',{...original,treeHash:r.treeHash,stdout:JSON.stringify(raw),at:new Date().toISOString()}),identity={...x.r.roleIdentities.executor,sessionId:'OFFLINE_CHILD_DSH',requestId:'OFFLINE_CHILD_REQUEST'},usage={role:'executor',requestId:identity.requestId,costUsd:null,source:'OFFLINE_ONLY_NOT_NATIVE'};
 record('DispatchFinished',{dispatchId,generation,outcome:'COMPLETED',cleanupReturned:true});
 record('AgentSession',{role:'executor',...identity,taskId,dispatchId,generation,modelEvidence:'ADAPTER_VERIFIED_RESPONSE'});record('UsageLedger',usage);record('NativeBudgetReceipt',{method:'dm/budget',params:{requests:[{observedModel:identity.model,outcome:'COMPLETE',completionObserved:true,responseModelMatched:true,usage:null}]}});
 Object.assign(r,{phase:'REVIEWING',state:'REVIEWING',reason:null,calls:1,repairCount:1,verification:{ok:true,evidenceId,treeHash:r.treeHash},roleIdentities:{executor:identity},sessions:{executor:identity.sessionId},usage:[usage],tasks:r.tasks.map(t=>({...t,status:'implemented'}))});s.saveRun(r);
 if(publishResult)savePreworkResult(s,s.run(r.id),{taskId,dispatchId,generation,sessionId:identity.sessionId,requestId:identity.requestId,beforeHash:before,afterHash:r.treeHash,changedPaths:['README.md']});
 return {...x,child:s.run(r.id)};
}

test('one original review packet distinguishes inherited P2 from current Executor and contains full parent/new source and raw tests',async t=>{
 const x=await fixture(t),packet=buildReviewPacket(x.h.store,x.child,x.s),e=packet.executionEvidence;
 assert.equal(packet.runId,x.child.id);assert.equal(packet.sourceHistory.at(-1).treeHash,x.child.treeHash);assert.equal(packet.rawTests.at(-1).data.treeHash,x.child.treeHash);
 assert.equal(e.inheritedPlanning.origin,'INHERITED_NOT_NEW_PLANNING');assert.equal(e.inheritedPlanning.parentRunId,x.r.id);assert.equal(e.inheritedPlanning.packet.packet.runId,x.r.id);assert.deepEqual(e.inheritedPlanning.plan.data.plan,x.r.plan);
 assert.deepEqual(Object.keys(e.inheritedPlanning.packet.packet).sort(),['executionEvidence','runId','schema','specHash']);
 assert.equal(e.roleIdentities.planner2,undefined);assert.equal(e.sessions.some(v=>v.data.role==='planner2'),false);assert.ok(e.sessions.some(v=>v.data.role==='executor'&&v.data.sessionId==='OFFLINE_CHILD_DSH'));
 assert.equal(x.h.store.records(x.p.id,'AgentSession').filter(v=>v.runId===x.child.id&&v.data.role==='planner2').length,0);assert.equal(x.h.store.records(x.p.id,'Plan').filter(v=>v.runId===x.child.id).length,0);
});

test('review packet still refuses a child with no current authorized package result',async t=>{const x=await fixture(t,{publishResult:false});assert.throws(()=>buildReviewPacket(x.h.store,x.child,x.s),{code:'PREWORK_RESULT_COVERAGE_GAP'});});
