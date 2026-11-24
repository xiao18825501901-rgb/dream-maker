// OFFLINE controller serialization with an explicit sandbox double. No model or OS proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {harness} from './helpers.mjs';import {WslVerifier} from '../dist/server/wsl-verifier.js';
import {buildAcceptanceEvidence} from '../dist/server/acceptance-evidence.js';
import {hash} from '../dist/server/security.js';import {treeHash} from '../dist/server/workspace.js';
function setup(t,{stdout='OK\n',stderr='',stdin='中文输入\n',expectedStdout=stdout,status='EXECUTED',acceptance=false}={}){
 const h=harness(t),workspace=join(h.dir,'source'),registry=join(h.dir,'oracle');mkdirSync(workspace);mkdirSync(registry);writeFileSync(join(workspace,'main.mjs'),'// OFFLINE, never executed\n');
 const specHash='a'.repeat(64),definition={id:'C1',requirementIds:['R1'],...(acceptance?{acceptanceIds:['A1']}:{}),runtime:'node',entry:'main.mjs',args:[],stdin,expectedExitCode:0,expectedStdout,expectedStderr:stderr};
 const plan={schema:'dream-maker.cli-verifier.v1',specHash,cases:[definition]},planText=JSON.stringify(plan,null,2)+'\n';writeFileSync(join(registry,'plan.json'),planText);
 const verifier=new WslVerifier(h.dir,registry,()=>({relativePath:'plan.json',sha256:hash(planText)}));let calls=0;
 verifier.sandbox={async run(source,command){calls++;assert.equal(command.stdin,stdin);return{status,exitCode:0,stdout,stderr,command:['OFFLINE_SANDBOX_DOUBLE'],sourceHash:treeHash(source),workerHash:'b'.repeat(64),jobId:'OFFLINE_JOB'};}};
 const spec={hash:specHash,requirements:[{id:'R1'}],...(acceptance?{acceptanceItems:[{id:'A1',requirementIds:['R1'],criterion:'The approved command prints OK.',method:'manual'}]}:{})};
 const events=[],run=()=>verifier.verify({workspace,runId:'OFFLINE_RUN',specHash,prompt:JSON.stringify({spec}),signal:new AbortController().signal},event=>events.push(event));
 return{run,planText,definition,spec,events,calls:()=>calls};
}

test('trusted raw evidence includes exact approved plan bytes and all input/expectation fields',async t=>{
 const f=setup(t),result=await f.run(),summary=JSON.parse(result.stdout);
 assert.equal(summary.schema,'dream-maker.trusted-cli-evidence.v2');
 assert.equal(summary.planText,f.planText);assert.equal(hash(summary.planText),summary.planHash);
 assert.deepEqual(JSON.parse(summary.planText).cases[0],f.definition);assert.equal(summary.cases[0].stdinHash,hash(f.definition.stdin));
 assert.deepEqual(summary.cases[0].input,{runtime:'node',entry:'main.mjs',args:[],stdin:'中文输入\n'});
 assert.deepEqual(summary.cases[0].expected,{exitCode:0,stdout:'OK\n',stderr:''});
});

test('formal raw stdout and stderr are complete while UI progress remains bounded',async t=>{
 const stdout='中'.repeat(5001)+'\n',stderr='diagnostic '.repeat(301)+'\n',f=setup(t,{stdout,stderr}),summary=JSON.parse((await f.run()).stdout);
 assert.equal(summary.cases[0].stdout,stdout);assert.equal(summary.cases[0].stderr,stderr);
 assert.equal(f.events[0].stdout.length,4000);assert.equal(f.events[0].stderr,undefined);assert.equal(f.events[0].stderrTail,stderr.slice(-2000));
});

test('raw material over the review bound is refused rather than truncated into complete evidence',async t=>{
 const f=setup(t,{stdout:'x'.repeat(512001),expectedStdout:'x'});
 await assert.rejects(f.run(),{code:'REVIEW_RAW_EVIDENCE_LIMIT'});assert.equal(f.events.length,0);
});

test('a secret-shaped approved input is refused before execution or evidence publication',async t=>{
 const f=setup(t,{stdin:'sk-'+'A'.repeat(30)});await assert.rejects(f.run(),{code:'SECRET_IN_SANDBOX_INPUT'});
 assert.equal(f.calls(),0);assert.equal(f.events.length,0);
});

test('a secret-shaped program result cannot enter the complete raw record or progress event',async t=>{
 const f=setup(t,{stdout:'sk-'+'A'.repeat(30),expectedStdout:'safe'});
 await assert.rejects(f.run(),{code:'REVIEW_SECRET_IN_MATERIAL'});assert.equal(f.events.length,0);
});

test('nested JSON credentials in approved input are refused before any sandbox call',async t=>{
 const f=setup(t,{stdin:JSON.stringify({Authorization:'Bearer OFFLINE_TOKEN'})});
 await assert.rejects(f.run(),{code:'REVIEW_SECRET_IN_MATERIAL'});assert.equal(f.calls(),0);assert.equal(f.events.length,0);
});
test('JSON-line credentials in program output are refused before publication',async t=>{
 const stdout='diagnostic: '+JSON.stringify({headers:JSON.stringify({Authorization:'Bearer OFFLINE_TOKEN'})})+'\n{}\n',f=setup(t,{stdout,expectedStdout:'safe'});
 await assert.rejects(f.run(),{code:'REVIEW_SECRET_IN_MATERIAL'});assert.equal(f.events.length,0);
});
test('a timed-out job cannot become a pass even if its captured exit and output match',async t=>{
 const f=setup(t,{status:'TIMED_OUT'}),result=await f.run(),raw=JSON.parse(result.stdout);
 assert.equal(result.exitCode,1);assert.equal(raw.ok,false);assert.equal(raw.cases[0].ok,false);assert.equal(raw.cases[0].status,'TIMED_OUT');
});
test('real verifier evidence preserves acceptance bindings through raw output, progress, and review projection',async t=>{
 const f=setup(t,{acceptance:true}),result=await f.run(),raw=JSON.parse(result.stdout),plan=JSON.parse(raw.planText);
 assert.deepEqual(plan.cases[0].acceptanceIds,['A1']);
 assert.deepEqual(raw.cases[0].acceptanceIds,['A1']);
 assert.deepEqual(raw.cases[0].expected.acceptanceIds,['A1']);
 assert.deepEqual(f.events[0].acceptanceIds,['A1']);
 const projected=buildAcceptanceEvidence({spec:f.spec,plan,observed:raw.cases,evidenceId:'rec_offline',planHash:raw.planHash,sourceHash:raw.sourceHash});
 assert.equal(projected.items[0].executableEvidenceStatus,'PASS');
 assert.equal(projected.items[0].manualAcceptanceStatus,'NOT_RUN');
 assert.deepEqual(projected.items[0].caseIds,['C1']);
});
