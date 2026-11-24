// Controller contract tests, not OS or Live model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSandboxCommand, checkSandboxResult } from '../dist/server/wsl-sandbox.js';
import { checkVerifierCase, validateVerifierPlan } from '../dist/server/wsl-verifier.js';
import { createAuditedWslVerifier } from '../adapters/wsl-verifier.mjs';
import { harness,root } from './helpers.mjs';
import { writeFileSync,mkdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from '../dist/server/security.js';
import {resourceImplementationFiles} from '../dist/server/sandbox-resource.js';

test('sandbox accepts only explicit supported runtime, safe entry and bounded argument/input data',()=>{
 assert.deepEqual(validateSandboxCommand({runtime:'node',entry:'src/main.mjs',args:['hello'],stdin:'input'}),{runtime:'node',entry:'src/main.mjs',args:['hello'],stdin:'input'});
 for(const entry of ['../main.js','/root/auth.json','a\\b.js','x:stream','node_modules/x.js','.env'])
  assert.throws(()=>validateSandboxCommand({runtime:'node',entry,args:[],stdin:''}));
 assert.throws(()=>validateSandboxCommand({runtime:'sh',entry:'main.sh',args:[],stdin:''}));
 assert.throws(()=>validateSandboxCommand({runtime:'node',entry:'main.mjs',args:['x'.repeat(9000)],stdin:''}));
 assert.equal(validateSandboxCommand({runtime:'python',entry:'main.py',args:[' space '],stdin:' input\n'}).stdin,' input\n');
 assert.throws(()=>validateSandboxCommand({runtime:'python',entry:'main.py',args:[],stdin:'sk-SYNTHETIC_SANDBOX_KEY'}),{code:'SECRET_IN_SANDBOX_INPUT'});
});
test('sandbox result cannot claim completion without exact job binding and proven cleanup',()=>{
 const expected={jobId:'wsl_job_test',sourceHash:'a'.repeat(64),workerHash:'b'.repeat(64)};
 const result={schema:'dream-maker.wsl-result.v1',...expected,status:'EXECUTED',exitCode:0,stdout:'ok',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true}};
 assert.equal(checkSandboxResult(result,expected).stdout,'ok');
 for(const patch of [{jobId:'wrong'},{sourceHash:'c'.repeat(64)},{cleanup:{...result.cleanup,remainingPids:['123']}}])
  assert.throws(()=>checkSandboxResult({...result,...patch},expected));
});
test('a declared sandbox environment must match the worker receipt before cleanup is trusted',()=>{
 const expected={jobId:'wsl_job_f_storage',sourceHash:'a'.repeat(64),workerHash:'b'.repeat(64),environment:'DreamMaker-Acceptance-F-20261101-R2'};
 const result={schema:'dream-maker.wsl-result.v1',...expected,status:'EXECUTED',exitCode:0,stdout:'ok',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true}};
 assert.equal(checkSandboxResult(result,expected).stdout,'ok');
 for(const environment of ['DreamMaker-Acceptance-20261011',undefined,'unknown'])assert.throws(()=>checkSandboxResult({...result,environment},expected),{code:'SANDBOX_RESULT_OR_CLEANUP_UNPROVEN'});
});
test('controller oracle rejects exit0/PASS text and binds exact outputs, not generated test summaries',()=>{
 const c={id:'A1',requirementIds:['R1'],runtime:'node',entry:'main.mjs',args:[],stdin:'',expectedExitCode:0,expectedStdout:'{"answer":42}\n'};
 assert.equal(checkVerifierCase(c,{exitCode:0,stdout:'PASS',stderr:''}).ok,false);
 assert.equal(checkVerifierCase(c,{exitCode:0,stdout:c.expectedStdout,stderr:''}).ok,true);
 assert.equal(checkVerifierCase(c,{exitCode:1,stdout:c.expectedStdout,stderr:''}).ok,false);
});
test('trusted plan is fixed to spec and must cover frozen requirements without duplicate IDs',()=>{
 const specHash='a'.repeat(64),c={id:'A1',requirementIds:['R1'],runtime:'python',entry:'main.py',args:[],stdin:'',expectedExitCode:0,expectedStdout:'done\n'};
 const plan={schema:'dream-maker.cli-verifier.v1',specHash,cases:[c]};
 assert.equal(validateVerifierPlan(plan,specHash,['R1']).cases.length,1);
 assert.equal(validateVerifierPlan(plan,specHash,['R1']).cases[0].expectedStdout,'done\n');
 for(const p of [{...plan,specHash:'b'.repeat(64)},{...plan,cases:[c,c]},{...plan,cases:[]}])
  assert.throws(()=>validateVerifierPlan(p,specHash,['R1']));
 assert.throws(()=>validateVerifierPlan(plan,specHash,['R1','R2']));
});
test('production verifier refuses unaudited or edited oracle before invoking any sandbox',async t=>{
 const h=harness(t),dir=resolve(h.dir,'oracle');mkdirSync(dir);const path=resolve(dir,'plan.json'),body='{"test":"controller only"}';writeFileSync(path,body);
 const specHash='a'.repeat(64),config={schema:'dream-maker.wsl-verifier-binding.v1',registryRoot:dir,plans:{[specHash]:{relativePath:'plan.json',sha256:hash(body)}}};
 const input={specHash,workspace:resolve(h.dir,'source')};
 const implementation=['dist/server/wsl-sandbox.js','dist/server/wsl-verifier.js','scripts/isolation/wsl-worker.py','dist/server/security.js','dist/server/workspace.js','dist/server/process.js',...resourceImplementationFiles].map(name=>{const path=resolve(root,name);return{path,sha256:hash(readFileSync(path))};});
 const missingHelper=createAuditedWslVerifier(config,{evidenceFiles:implementation.filter(f=>!f.path.endsWith('wsl-resource-context.py'))});
 await assert.rejects(missingHelper(input,()=>{},new AbortController().signal),{code:'VERIFIER_IMPLEMENTATION_NOT_AUDITED'});
 const noImplementation=createAuditedWslVerifier(config,{evidenceFiles:[]});await assert.rejects(noImplementation(input,()=>{},new AbortController().signal),{code:'VERIFIER_IMPLEMENTATION_NOT_AUDITED'});
 const noAudit=createAuditedWslVerifier(config,{evidenceFiles:implementation});await assert.rejects(noAudit(input,()=>{},new AbortController().signal),{code:'TRUSTED_VERIFIER_PLAN_NOT_AUDITED'});
 const bound=createAuditedWslVerifier(config,{evidenceFiles:[...implementation,{path,sha256:hash(body)}]});writeFileSync(path,'changed');
 await assert.rejects(bound(input,()=>{},new AbortController().signal),{code:'TRUSTED_VERIFIER_PLAN_NOT_AUDITED'});
});
