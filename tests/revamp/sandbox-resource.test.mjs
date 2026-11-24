// Offline receipt counterexamples, not actual kernel/process cleanup evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as boundary from '../../dist/server/sandbox-resource.js';
import {hash} from '../../dist/server/security.js';
import {cleanupUncertain} from '../../dist/server/cleanup-uncertainty.js';
const expected={jobId:'wsl_job_fixture',sourceHash:'a'.repeat(64),workerHash:'b'.repeat(64),resourceHelperHash:'c'.repeat(64)};
const result={schema:'dream-maker.wsl-result.v1',...expected,status:'EXECUTED',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true}};
function fixture(){return {final:{schema:'dream-maker.wsl-resource-final.v1',...expected,environment:'DreamMaker-Acceptance-F-20261101-R2',scopeId:'dm_scope_wsl_job_fixture',scopePath:'/sys/fs/cgroup/dm_scope_wsl_job_fixture',bootId:'00000000-0000-4000-8000-000000000001',parent:{pid:123,startTicks:'42'},child:{pid:124,startTicks:'43'},workerExitCode:0,resultHash:hash(result),isolation:{before:{mnt:'mnt:[1]',cgroup:'cgroup:[2]'},after:{mnt:'mnt:[3]',cgroup:'cgroup:[4]'},supervisorCgroup:'0::/supervisor',workerViewInitiallyEmpty:true,controlFdsClosed:true},cleanup:{scopeRemoved:true,rootRestored:true,remainingPids:[]}},observed:{scopeAbsent:true,parentAbsent:true,childAbsent:true}};}
test('nested worker completion needs separate exact outer cleanup and current OS observation',()=>{
 assert.equal(typeof boundary.checkResourceObservation,'function');
 const proof=fixture();assert.equal(boundary.checkResourceObservation(proof,expected,result),proof.final);
 for(const edit of [p=>delete p.final,p=>delete p.observed,p=>p.observed.scopeAbsent=false,p=>p.observed.parentAbsent=false,p=>p.observed.childAbsent=false,p=>p.final.cleanup.remainingPids=['55'],p=>p.final.cleanup.scopeRemoved=false,p=>p.final.cleanup.rootRestored=false,p=>p.final.scopePath='/sys/fs/cgroup/'+expected.jobId,p=>p.final.resourceHelperHash='d'.repeat(64),p=>p.final.resultHash='d'.repeat(64),p=>p.final.workerExitCode=7,p=>p.final.isolation.after.mnt=p.final.isolation.before.mnt,p=>p.final.isolation.controlFdsClosed=false,p=>p.final.isolation.supervisorCgroup='0::/']){
  const bad=fixture();edit(bad);assert.throws(()=>boundary.checkResourceObservation(bad,expected,result),{code:'SANDBOX_RESOURCE_CLEANUP_UNPROVEN'});
 }
});
test('resource cleanup uncertainty follows the original persistent unknown-result gate',()=>{
 assert.equal(cleanupUncertain({code:'SANDBOX_RESOURCE_CLEANUP_UNPROVEN'}),true);
});
