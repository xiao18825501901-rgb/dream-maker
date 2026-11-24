// OFFLINE: validates the absence receipt shape and helper pin without starting WSL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {root} from '../helpers.mjs';
import {validateSandboxAbsence,probeSandboxAbsence} from '../../dist/server/wsl-sandbox-absence.js';

const jobId='wsl_job_offline_absence';
const proof={schema:'dream-maker.wsl-sandbox-absence.v1',jobId,
    jobDirAbsent:true,intentAbsent:true,finalAbsent:true,cgroupAbsent:true,processAbsent:true};

test('a complete fresh absence observation is accepted for its exact job',()=>{
    assert.deepEqual(validateSandboxAbsence(proof,jobId),proof);
});

for(const [name,alter] of [
    ['a surviving job directory',{jobDirAbsent:false}],
    ['an existing intent receipt',{intentAbsent:false}],
    ['an existing final receipt',{finalAbsent:false}],
    ['a surviving cgroup',{cgroupAbsent:false}],
    ['a process that names the scope',{processAbsent:false}],
    ['a different job id',{jobId:'wsl_job_other_absence'}],
    ['a foreign schema',{schema:'dream-maker.other.v1'}],
    ['a missing field',{processAbsent:undefined}]
])test(name+' stays uncertain',()=>{
    assert.throws(()=>validateSandboxAbsence({...proof,...alter},jobId),error=>error.code==='SANDBOX_RESOURCE_CLEANUP_UNPROVEN');
});

test('a changed resource helper refuses before any guest probe',async()=>{
    await assert.rejects(probeSandboxAbsence(root,jobId,'f'.repeat(64),'DreamMaker-Acceptance-F-20261101-R2'),
        error=>error.code==='SANDBOX_RESOURCE_CLEANUP_UNPROVEN');
});

test('an invalid job id refuses before spawning WSL',async()=>{
    await assert.rejects(probeSandboxAbsence(root,'wsl_job_bad id','f'.repeat(64),'DreamMaker-Acceptance-F-20261101-R2'),
        error=>error.code==='SANDBOX_RESOURCE_CLEANUP_UNPROVEN');
});
