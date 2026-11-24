// OFFLINE original-Store boundary. No model, network, WSL, generated project or shared config.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,root} from '../helpers.mjs';
import {inspectDispatchOwnership} from '../../dist/server/flow/ownership-recovery.js';

const POWER_SHELL='f307e73a3447b10444e67233700c1aa5ca8e3673dd2f292084bf485583caad6f';
const NETSTAT='2ef44474b8c0169065388a9b666cb4eb5b2015901fd790d502aa83d4690f4769';
const OBSERVER_ARGV='98e23d86fa2bee25deab4f37a0198fc066a666ce7d1cb2a74ce66e4f300365c5';
const NETSTAT_ARGV='91b7f09f4c369777edd998210c510994db44591968188369b434902662a6d182';

function rig(t,{kind='planner2',commandSha256=POWER_SHELL,argvSha256=OBSERVER_ARGV,exitCode=0,mainCleanup=true,duplicateStart=false}={}){
    const h=harness(t),p=h.interviews.create('OFFLINE legacy observers','no model','demo');
    const dispatchId='dispatch_offline_legacy_observers',generation='generation_offline_legacy_observers';
    const record=(recordKind,value)=>h.store.record(recordKind,p.id,'run_offline_legacy_observers',{dispatchId,generation,...value});
    record('DispatchGranted',{kind,mode:'live'});
    record('OwnedProcessIntent',{processId:'owned_process_main',commandSha256:'a'.repeat(64),argvSha256:'b'.repeat(64),platform:'win32'});
    record('OwnedProcessRootStarted',{processId:'owned_process_main',pid:100,identity:'win32:1000',identityState:'OS_START_IDENTITY'});
    record('OwnedWindowsJobIntent',{processId:'owned_process_main',jobId:'windows_job_main',requestSha256:'c'.repeat(64),helperSha256:'d'.repeat(64),parentPid:50,parentTicks:'50'});
    record('OwnedWindowsJobPinned',{processId:'owned_process_main',jobId:'windows_job_main',markerSha256:'e'.repeat(64),helperSha256:'d'.repeat(64)});
    record('OwnedProcessIntent',{processId:'owned_process_observer',commandSha256,argvSha256,platform:'win32'});
    record('OwnedProcessRootStarted',{processId:'owned_process_observer',pid:101,identity:commandSha256===NETSTAT?null:'win32:2000',identityState:commandSha256===NETSTAT?'NOT_CAPTURED':'OS_START_IDENTITY'});
    if(duplicateStart)record('OwnedProcessRootStarted',{processId:'owned_process_observer',pid:102,identity:'win32:3000',identityState:'OS_START_IDENTITY'});
    record('OwnedProcessRootExited',{processId:'owned_process_observer',rootClosed:true,code:exitCode,signal:null});
    record('OwnedProcessRootExited',{processId:'owned_process_main',rootClosed:true,code:1,signal:null});
    record('OwnedWindowsJobClosed',{processId:'owned_process_main',jobId:'windows_job_main',activeProcesses:0});
    if(mainCleanup)record('OwnedProcessCleanup',{processId:'owned_process_main',kind:'TRUSTED_WINDOWS_JOB',scopeId:'windows_job_main',receiptSha256:'f'.repeat(64),cleanupReturned:true});
    record('DispatchFinished',{cleanupReturned:false,outcome:'PROCESS_CLEANUP_UNPROVEN'});
    return()=>inspectDispatchOwnership(h.store,root,h.config,p.id,'run_offline_legacy_observers',dispatchId);
}

test('only the exact legacy read-only observers pass after the enclosing Windows Job cleanup is proven',async t=>{
    const proof=await rig(t)();
    assert.equal(proof.proven,true);
    assert.equal(proof.dispatchId,'dispatch_offline_legacy_observers');
    assert.match(proof.basisSha256,/^[a-f0-9]{64}$/);
});

for(const [name,alter,code] of [
    ['an arbitrary PowerShell argv hash',{argvSha256:'9'.repeat(64)},'DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED'],
    ['a nonzero read-only exit',{exitCode:1},'LEGACY_OBSERVER_PROCESS_CLOSURE_INVALID'],
    ['duplicate observer starts',{duplicateStart:true},'LEGACY_OBSERVER_PROCESS_RECORDS_AMBIGUOUS'],
    ['a missing enclosing Windows Job cleanup',{mainCleanup:false},['LEGACY_OBSERVER_MAIN_CLEANUP_UNPROVEN','WINDOWS_JOB_RECOVERY_BINDING_INVALID']],
    ['a non-Codex dispatch',{kind:'executor'},'DISPATCH_PROCESS_OWNERSHIP_PROOF_REQUIRED']
])test(name+' stays fail-closed',async t=>{
    await assert.rejects(rig(t,alter)(),error=>Array.isArray(code)?code.includes(error.code):error.code===code);
});

test('the separately captured netstat observer is accepted only with its exact hash',async t=>{
    const proof=await rig(t,{commandSha256:NETSTAT,argvSha256:NETSTAT_ARGV})();
    assert.equal(proof.proven,true);
});
