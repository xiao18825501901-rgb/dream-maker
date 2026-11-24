// OFFLINE original-Engine/Store boundary fixtures only. Not native or model evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {harness,ready} from '../helpers.mjs';import * as packets from '../../dist/server/review-packet.js';
import {hash,DomainError} from '../../dist/server/security.js';import {checkVerifierCase} from '../../dist/server/wsl-verifier.js';

async function setup(t){
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{};const made=h.engine.create(p.id,s.hash,true),r=h.store.run(made.id);
 Object.assign(r,{mode:'live',state:'REPAIRING',phase:'REPAIRING',repairCount:1,reason:'VERIFIER_EXIT_1: CASE SORT stdoutMatched=false'});
 mkdirSync(r.workspace,{recursive:true});writeFileSync(join(r.workspace,'main.mjs'),'// OFFLINE not executed\n');
 const snapshot=packets.captureSource(r.workspace,{runId:r.id,specHash:r.specHash},'VERIFIER_INPUT');r.treeHash=snapshot.treeHash;
 h.store.record('SourceSnapshot',p.id,r.id,snapshot);
 const expected={items:['\ue000','😀']},actual={items:['😀','\ue000']},ids=s.requirements.map(x=>x.id);
 const definition={id:'SORT',requirementIds:ids,runtime:'node',entry:'main.mjs',args:[],stdin:'[{"category":"😀","amount":1}]',expectedExitCode:0,expectedJson:expected,expectedStderr:''};
 const success={id:'EMPTY',requirementIds:ids,runtime:'node',entry:'main.mjs',args:[],stdin:'[]',expectedExitCode:0,expectedJson:{items:[]},expectedStderr:''};
 const plan={schema:'dream-maker.cli-verifier.v1',specHash:r.specHash,cases:[definition,success]},planText=JSON.stringify(plan)+'\n',planHash=hash(planText);
 const observed=(c,stdout)=>({id:c.id,requirementIds:c.requirementIds,...checkVerifierCase(c,{stdout,stderr:'',exitCode:0}),expectedExitCode:0,actualExitCode:0,stdinHash:hash(c.stdin),sourceHash:r.treeHash,workerHash:'b'.repeat(64),jobId:'OFFLINE_WSL_JOB',status:'EXECUTED',command:['/usr/bin/node','/workspace/main.mjs'],stdout,stderr:'',stderrTail:'',fixtureCount:0});
 const raw={schema:'dream-maker.trusted-cli-evidence.v1',specHash:r.specHash,sourceHash:r.treeHash,planHash,planText,ok:false,cases:[observed(definition,JSON.stringify(actual)+'\n'),observed(success,'{"items":[]}\n')]};
 const evidence={stepId:'OFFLINE_STEP',attempt:1,specHash:r.specHash,treeHash:r.treeHash,command:['dream-maker-controller-cli-oracle',r.specHash,planHash],stdout:JSON.stringify(raw),stderr:'CASE SORT failed',code:1,at:new Date().toISOString(),scope:'LIVE_VERIFIER'};
 const evidenceId=h.store.record('Evidence',p.id,r.id,evidence),approvalId=h.store.record('VerifierApproval',p.id,null,{specHash:r.specHash,planHash,source:'OFFLINE_EXPLICIT_APPROVAL'});
 r.verification={ok:false,exitCode:1,stdout:evidence.stdout,stderr:evidence.stderr,command:evidence.command,treeHash:r.treeHash,at:evidence.at,evidenceId};r.findings=[{id:'OFFLINE_FINDING',severity:'high',description:'确定性验证失败，必须修复后重测。',evidence:evidenceId,status:'open'}];h.store.saveRun(r);
 return{h,p,s,r,raw,evidence,evidenceId,approvalId,expected,actual,get:()=>{assert.equal(typeof packets.buildRepairDiagnostics,'function','ORIGINAL_REPAIR_DIAGNOSTICS_MISSING');return packets.buildRepairDiagnostics(h.store,r,s);}};
}

test('repair receives exact approved failed input, expected JSON and actual output, with passing cases counted separately',async t=>{
 const f=await setup(t),before=hash(f.h.store.run(f.r.id)),d=f.get();assert.equal(d.schema,'dream-maker.repair-diagnostics.v1');
 assert.equal(d.evidenceId,f.evidenceId);assert.equal(d.verifierApproval.recordId,f.approvalId);assert.equal(d.sourceHash,f.r.treeHash);
 assert.equal(d.caseCount,2);assert.equal(d.passedCount,1);assert.equal(d.failedCount,1);assert.equal(d.cases.length,1);
 assert.equal(d.cases[0].id,'SORT');assert.equal(d.cases[0].input.stdin,JSON.parse(f.raw.planText).cases[0].stdin);
 assert.deepEqual(d.cases[0].expected.expectedJson,f.expected);assert.deepEqual(JSON.parse(d.cases[0].actual.stdout),f.actual);
 assert.equal(hash(f.h.store.run(f.r.id)),before);
});

test('original Engine passes trusted diagnostics to executor before any repair model result',async t=>{
 const f=await setup(t);let body;
 f.h.engine.role=async(_r,role,prompt)=>{assert.equal(role,'executor');body=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1));throw new DomainError('OFFLINE_STOP_BEFORE_MODEL',409);};
 await f.h.engine.loop(f.r.id,new AbortController().signal);
 assert.ok(body?.repairDiagnostics,'ENGINE_DID_NOT_DELIVER_RAW_FAILURE_CONTEXT');assert.equal(body.repairDiagnostics.evidenceId,f.evidenceId);
 assert.deepEqual(body.repairDiagnostics.cases[0].expected.expectedJson,f.expected);assert.equal(f.h.store.run(f.r.id).repairCount,1);
});

for(const [name,alter] of [
 ['foreign evidence',f=>f.h.store.db.prepare('UPDATE records SET run_id=? WHERE id=?').run('OFFLINE_OTHER_RUN',f.evidenceId)],
 ['missing verifier approval',f=>f.h.store.db.prepare('DELETE FROM records WHERE id=?').run(f.approvalId)],
 ['changed source',f=>writeFileSync(join(f.r.workspace,'main.mjs'),'// CHANGED OFFLINE\n')],
 ['corrupt raw expectation',f=>{f.raw.planText+=' ';f.evidence.stdout=JSON.stringify(f.raw);f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(f.evidence),f.evidenceId);}]
])test('repair refuses '+name+' before executor dispatch',async t=>{
 const f=await setup(t);alter(f);assert.throws(f.get);let calls=0;
 f.h.engine.role=async()=>{calls++;throw Error('MUST_NOT_REACH_OFFLINE_MODEL');};await f.h.engine.loop(f.r.id,new AbortController().signal);assert.equal(calls,0);
});

test('stored original evidence wins over a caller-supplied stdout claim',async t=>{
 const f=await setup(t);f.r.verification.stdout='OFFLINE_EXECUTOR_SUMMARY_IS_NOT_EVIDENCE';assert.deepEqual(JSON.parse(f.get().cases[0].actual.stdout),f.actual);
});

test('an exact bounded verification recovery receives the original failure diagnostics',async t=>{
 const f=await setup(t);
 f.r.phase='IMPLEMENTING';
 f.r.state='PAUSED';
 f.r.reason='BOUNDED_CODE_REPAIR_VERIFICATION_RECOVERY_PREPARED';
 assert.equal(f.get(),null);
 f.r.boundedCodeVerificationRecovery={recordId:'OFFLINE_RECOVERY',sha256:'a'.repeat(64)};
 const diagnostics=f.get();
 assert.equal(diagnostics.evidenceId,f.evidenceId);
 assert.equal(diagnostics.cases[0].id,'SORT');
 assert.equal(diagnostics.cases[0].input.stdin,JSON.parse(f.raw.planText).cases[0].stdin);
 assert.deepEqual(diagnostics.cases[0].expected.expectedJson,f.expected);
 assert.deepEqual(JSON.parse(diagnostics.cases[0].actual.stdout),f.actual);
});

test('a bounded verification recovery keeps diagnostics on the multi-task executor wave path',async t=>{
 const f=await setup(t);
 const template=f.r.tasks[0]??{
   id:'OFFLINE_TASK',title:'OFFLINE_TASK',dependsOn:[],requirementIds:f.s.requirements.map(x=>x.id),
   acceptance:['OFFLINE_ACCEPTANCE'],writePaths:['main.mjs'],status:'pending',
 };
 f.r.phase='IMPLEMENTING';
 f.r.state='IMPLEMENTING';
 f.r.reason='BOUNDED_CODE_REPAIR_VERIFICATION_RECOVERY_PREPARED';
 f.r.boundedCodeVerificationRecovery={recordId:'OFFLINE_RECOVERY',sha256:'a'.repeat(64)};
 f.r.tasks=[
   {...template,id:'OFFLINE_MAIN',title:'OFFLINE_MAIN',dependsOn:[],writePaths:['main.mjs'],status:'pending'},
   {...template,id:'OFFLINE_README',title:'OFFLINE_README',dependsOn:[],writePaths:['README.md'],status:'pending'},
 ];
 f.h.store.saveRun(f.r);
 const roleCalls=[];let body;
 f.h.engine.role=async(_r,role,prompt)=>{assert.equal(role,'executor');roleCalls.push({length:typeof prompt==='string'?prompt.length:null,tail:typeof prompt==='string'?prompt.slice(-200):String(prompt)});if(typeof prompt==='string'&&prompt.length)body=JSON.parse(prompt.slice(prompt.lastIndexOf('\n{')+1));throw new DomainError('OFFLINE_STOP_BEFORE_MODEL',409);};
 await f.h.engine.loop(f.r.id,new AbortController().signal);
 const persisted=f.h.store.run(f.r.id);
 assert.ok(body?.repairDiagnostics,'WAVE_PROMPT_DROPPED_ORIGINAL_FAILURE_CONTEXT '+JSON.stringify({
   roleCalls,phase:persisted.phase,state:persisted.state,reason:persisted.reason,
   bounded:persisted.boundedCodeVerificationRecovery,verificationOk:persisted.verification?.ok,
   taskIds:persisted.tasks.map(x=>x.id),
 }));
 assert.equal(body.repairDiagnostics.evidenceId,f.evidenceId);
 assert.equal(body.repairDiagnostics.cases[0].id,'SORT');
 assert.deepEqual(body.repairDiagnostics.cases[0].expected.expectedJson,f.expected);
 assert.deepEqual(JSON.parse(body.repairDiagnostics.cases[0].actual.stdout),f.actual);
});

test('Demo and non-verifier recovery do not inherit a new repair path',async t=>{
 const f=await setup(t);f.r.mode='demo';assert.equal(f.get(),null);f.r.mode='live';f.r.reason='RUNNER_RPC_ERROR';assert.equal(f.get(),null);
});

for(const [name,stdout,code] of [
 ['nested output secret',JSON.stringify({Authorization:'Bearer OFFLINE_TOKEN'}),'REVIEW_SECRET_IN_MATERIAL'],
 ['oversized exact output','X'.repeat(129000),'REPAIR_DIAGNOSTICS_LIMIT']
])test('repair rejects '+name+' without truncating or calling a model',async t=>{
 const f=await setup(t);f.raw.cases[0].stdout=stdout;f.evidence.stdout=JSON.stringify(f.raw);
 // Store.record redacts secrets; explicit isolated corruption tests the read boundary.
 f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(f.evidence),f.evidenceId);
 assert.throws(f.get,{code});let calls=0;
 f.h.engine.role=async()=>{calls++;throw Error('OFFLINE_MODEL_MUST_NOT_RUN');};await f.h.engine.loop(f.r.id,new AbortController().signal);
 assert.equal(calls,0);assert.equal(f.h.store.run(f.r.id).repairCount,1);
});

async function pauseAndResume(f){
 f.h.engine.pause(f.r.id);await f.h.engine.loop(f.r.id,new AbortController().signal);
 assert.equal(f.h.store.run(f.r.id).state,'PAUSED');
 // Isolated admission seam only: no actual role/runtime or production qualification.
 f.h.engine.assertNativeReadyForRun=(_r,role)=>assert.equal(role,'executor');
 await f.h.engine.resume(f.r.id);assert.equal(f.h.store.run(f.r.id).state,'REPAIRING');
}

test('pause and resume retain original verifier context in the next executor prompt',async t=>{
 const f=await setup(t);await pauseAndResume(f);let body;
 f.h.engine.role=async(_r,role,prompt)=>{assert.equal(role,'executor');body=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1));throw new DomainError('OFFLINE_STOP_BEFORE_MODEL',409);};
 await f.h.engine.loop(f.r.id,new AbortController().signal);
 assert.ok(body?.repairDiagnostics,'RESUME_DROPPED_ORIGINAL_FAILURE_CONTEXT');assert.equal(body.repairDiagnostics.evidenceId,f.evidenceId);
 assert.equal(body.repairDiagnostics.verifierApproval.recordId,f.approvalId);
 assert.deepEqual(body.repairDiagnostics.cases[0].expected.expectedJson,f.expected);assert.deepEqual(JSON.parse(body.repairDiagnostics.cases[0].actual.stdout),f.actual);
 assert.equal(f.h.store.run(f.r.id).repairCount,1);
});

for(const [name,alter] of [
 ['secret',f=>{f.raw.cases[0].stdout=JSON.stringify({Authorization:'Bearer OFFLINE_TOKEN'});f.evidence.stdout=JSON.stringify(f.raw);f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(f.evidence),f.evidenceId);}],
 ['oversize',f=>{f.raw.cases[0].stdout='X'.repeat(129000);f.evidence.stdout=JSON.stringify(f.raw);f.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(f.evidence),f.evidenceId);}],
 ['missing approval',f=>f.h.store.db.prepare('DELETE FROM records WHERE id=?').run(f.approvalId)]
])test('pause and resume cannot bypass '+name+' diagnostic refusal',async t=>{
 const f=await setup(t);alter(f);await pauseAndResume(f);let calls=0;
 f.h.engine.role=async()=>{calls++;throw new DomainError('OFFLINE_MODEL_MUST_NOT_RUN',409);};
 await f.h.engine.loop(f.r.id,new AbortController().signal);assert.equal(calls,0);assert.equal(f.h.store.run(f.r.id).repairCount,1);
});
