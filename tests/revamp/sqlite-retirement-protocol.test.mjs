import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {root} from '../helpers.mjs';import {hash,childEnv} from '../../dist/server/security.js';import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
const load=()=>import('../../dist/server/sqlite-retirement-protocol.js');
const basis={jobId:'wsl_job_offline_protocol',authorityHash:'a'.repeat(64),resourceHelperHash:'b'.repeat(64)},attemptId='retire_attempt_'+'c'.repeat(32),helperHash='d'.repeat(64);
function state(){const attempt={schema:'dream-maker.sqlite-retirement-attempt.v1',attemptId,jobId:basis.jobId,authorityHash:basis.authorityHash,helperHash,resourceHelperHash:basis.resourceHelperHash,bootId:'12345678-1234-1234-1234-123456789abc',identity:{pid:42,startTicks:'123'}};return {schema:'dream-maker.sqlite-retirement-observation.v1',attempt,helperAbsent:true,outcome:{schema:'dream-maker.sqlite-retirement-outcome.v1',attemptId,authorityHash:basis.authorityHash,attemptHash:hash(attempt),status:'RETIRED',errorCode:null,result:{schema:'dream-maker.sqlite-retirement-result.v1',jobId:basis.jobId,authorityHash:basis.authorityHash,retired:true,containerBytesAfter:0,reservationReleased:true,replayed:false,evidencePreserved:true}}};}
test('retirement observation binds exact attempt/helper/authority and never accepts a live process',async()=>{
 const m=await load(),original=state();assert.deepEqual(m.checkRetirementObservation(original,basis,attemptId,helperHash),original);
 for(const change of [v=>v.helperAbsent=false,v=>v.attempt.identity.pid=true,v=>v.attempt.identity.startTicks='0',v=>v.attempt.helperHash='0'.repeat(64),v=>v.attempt.authorityHash='0'.repeat(64),v=>v.attempt.attemptId='retire_attempt_'+'f'.repeat(32),v=>v.attempt.secret='OFFLINE_UNEXPECTED']){const bad=state();change(bad);assert.throws(()=>m.checkRetirementObservation(bad,basis,attemptId,helperHash));}
});
test('retirement result and uncertain/failure cleanup remain distinct',async()=>{
 const m=await load(),raw=state();for(const change of [v=>v.outcome.result.retired=false,v=>v.outcome.result.reservationReleased=false,v=>v.outcome.result.containerBytesAfter=1,v=>v.outcome.attemptHash='0'.repeat(64),v=>v.outcome.result.jobId='wsl_job_other',v=>v.outcome.result.stdout='OFFLINE_PRIVATE']){const bad=state();change(bad);assert.throws(()=>m.checkRetirementObservation(bad,basis,attemptId,helperHash));}
 raw.outcome=null;assert.equal(m.checkRetirementObservation(raw,basis,attemptId,helperHash).outcome,null);
 const failed=state();Object.assign(failed.outcome,{status:'FAILED',result:null,errorCode:'SQLITE_RETIREMENT_CANCELLED'});assert.equal(m.checkRetirementObservation(failed,basis,attemptId,helperHash).outcome.status,'FAILED');
});
test('fixed bootstrap rejects altered source, duplicate envelope keys and oversized metadata before any job effect',async()=>{
 const m=await load(),program=readFileSync(root+'/scripts/isolation/sqlite-retire.py','utf8'),resourceProgram=readFileSync(root+'/scripts/isolation/wsl-resource-context.py','utf8');
 const script=m.retirementBootstrap(hash(program),hash(resourceProgram),'read'),envelope={schema:'dream-maker.sqlite-retirement-input.v1',program,resourceProgram,request:{basis:{},attemptId}};
 const execute=input=>spawnSync('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',script],{cwd:root,env:childEnv(),input,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:64000});
 for(const input of [JSON.stringify({...envelope,program:program+'\n# altered'})+'\n','{"schema":"one","schema":"two"}\n','x'.repeat(262145)+'\n']){const r=execute(input);assert.notEqual(r.status,0);assert.equal(r.stdout,'');}
});
