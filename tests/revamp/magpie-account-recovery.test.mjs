// OFFLINE original SQLite and OS-observer seams; never model or cleanup qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready,root} from '../helpers.mjs';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {MagpieAccountChecks} from '../../dist/server/magpie-account-check.js';
import {currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {magpieBlocksNative} from '../../dist/server/magpie-check.js';
import {DomainError,hash} from '../../dist/server/security.js';
import {Store} from '../../dist/server/store.js';

const actor='local-session:'+'a'.repeat(64);
async function fixture(t){
 const h=harness(t),{p,s}=await ready(h),account={provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'};
 const role=(id,write=false)=>({id,...account,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const configuration={mode:'custom',laya:false,accounts:[account],roles:{planner2:role('planner2'),executors:[role('worker',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const profile=new FlowProfiles(h.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},actor,'OFFLINE_RECOVERY_PROFILE'),prep=h.engine.prepareCustomFlow(p.id,s.hash,profile.contentHash);
 const input={projectId:p.id,specHash:s.hash,profileHash:profile.contentHash,preparation:{identityHash:prep.identityHash,contentHash:prep.contentHash}},operation=hash('OFFLINE_UNCERTAIN_ACCOUNT'),checks=new MagpieAccountChecks(h.store,()=>h.config,()=>({flowConfigHash:prep.flowConfigHash,sourceBindingHash:'f'.repeat(64)}));
 return{h,p,input,operation,checks};
}
function processRows(x,{pinned=true}={}){
 const scope=currentProcessOwnership();assert.ok(scope,'original process ownership must cover account inspection');
 const rec=(kind,data)=>x.h.store.record(kind,x.p.id,null,{dispatchId:scope.dispatchId,generation:scope.generation,processId:'owned_process_'+'1'.repeat(20),...data,at:new Date().toISOString()});
 rec('OwnedProcessIntent',{commandSha256:hash('F:/OFFLINE/magpie.exe'),argvSha256:hash([]),platform:'win32'});
 rec('OwnedWindowsJobIntent',{jobId:'windows_job_'+'2'.repeat(20),requestSha256:hash('request'),helperSha256:hash('helper'),parentPid:123,parentTicks:'111'});
 rec('OwnedProcessRootStarted',{pid:456,identity:'win32:222',identityState:'OS_START_IDENTITY',descendantsProven:false});
 if(pinned)rec('OwnedWindowsJobPinned',{jobId:'windows_job_'+'2'.repeat(20),markerSha256:hash('marker'),helperSha256:hash('helper'),marker:{requestSha256:hash('request'),wrapperPid:456,parentPid:123,parentTicks:'111'}});
}
async function uncertain(x,options){return x.checks.check(x.input,x.operation,actor,new AbortController().signal,async()=>{processRows(x,options);throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'PRIVATE_VALUE');});}
async function recovery(x,observers={}){
 const {MagpieAccountRecoveries}=await import('../../dist/server/magpie-account-recovery.js');
 return new MagpieAccountRecoveries(x.h.store,root,{
  processIdentity:()=>null,
  jobCleanup:(_root,b)=>({kind:'TRUSTED_WINDOWS_JOB',scopeId:b.jobId,receiptSha256:hash('OFFLINE_CLEANUP')}),
  ...observers
 });
}

test('M13 original durable process ownership exists before any account process is launched',async t=>{
 const x=await fixture(t);await uncertain(x);
 assert.equal(x.h.store.records(x.p.id,'MagpieAccountCheckOwnership').length,1);
 const state=await import('../../dist/server/magpie-account-check-state.js'),intent=x.h.store.records(x.p.id,'MagpieAccountCheckIntent')[0].data,owner=state.accountCheckOwnership(x.h.store,intent);
 assert.equal(state.accountCheckProcessJournal(x.h.store,intent,owner).length,4,'the scope binding is not itself an OS process event');
 assert.equal(magpieBlocksNative(x.h.store),true);
});
test('M13 proven recovery appends evidence and survives Store reopen without changing the original result',async t=>{
 const x=await fixture(t),original=await uncertain(x),before=x.h.store.records(x.p.id,'MagpieAccountCheckResult');
 const api=await recovery(x),target=api.latest(x.p.id);assert.equal(target.status,'REQUIRED');
 const result=await api.reconcile(x.p.id,target.targetHash,actor,new AbortController().signal);assert.equal(result.status,'RECOVERED');assert.equal(result.processClosed,true);assert.equal(result.restartRequired,true);
 for(const field of ['accountVerified','modelVerified','customExecutionGranted'])assert.equal(result[field],false);
 assert.equal(magpieBlocksNative(x.h.store),true,'the recovered controller instance must be reopened before another native launch');assert.deepEqual(x.h.store.records(x.p.id,'MagpieAccountCheckResult'),before);
 assert.deepEqual(x.checks.read(x.input,x.operation,actor),original);
 const db=new Store(x.h.store.path);try{const {MagpieAccountRecoveries}=await import('../../dist/server/magpie-account-recovery.js');assert.deepEqual(new MagpieAccountRecoveries(db,root).latest(x.p.id),{...result,restartRequired:false});assert.equal(magpieBlocksNative(db),false);}finally{db.close();}
});
test('M13 live root or nonempty OS job cannot clear quarantine',async t=>{
 for(const observers of [{processIdentity:()=> 'win32:222'},{jobCleanup:()=>{throw new DomainError('PROCESS_OWNERSHIP_ACTIVE',409);}}]){
  const x=await fixture(t);await uncertain(x);const api=await recovery(x,observers),target=api.latest(x.p.id);
  await assert.rejects(api.reconcile(x.p.id,target.targetHash,actor,new AbortController().signal));assert.equal(magpieBlocksNative(x.h.store),true);assert.equal(x.h.store.records(x.p.id,'MagpieAccountCheckRecovery').length,0);
 }
});
test('M13 missing pin and mismatched cleanup receipt refuse without modifying the old check',async t=>{
 for(const options of [{pinned:false},{}]){
  const x=await fixture(t);await uncertain(x,options);const api=await recovery(x,{jobCleanup:()=>({kind:'TRUSTED_WINDOWS_JOB',scopeId:'windows_job_'+'9'.repeat(20),receiptSha256:hash('FOREIGN')})}),target=api.latest(x.p.id);
  await assert.rejects(api.reconcile(x.p.id,target.targetHash,actor,new AbortController().signal));assert.equal(magpieBlocksNative(x.h.store),true);
 }
});
test('M13 stale target, cancellation, foreign project and damaged ownership stay closed',async t=>{
 const x=await fixture(t);await uncertain(x);const api=await recovery(x),target=api.latest(x.p.id),cancel=new AbortController();cancel.abort();
 await assert.rejects(api.reconcile(x.p.id,hash('FOREIGN'),actor,new AbortController().signal));await assert.rejects(api.reconcile(x.p.id,target.targetHash,actor,cancel.signal));
 const other=x.h.interviews.create('另一项目','不能解除别的进程','demo');await assert.rejects(api.reconcile(other.id,target.targetHash,actor,new AbortController().signal));
 x.h.store.db.prepare("UPDATE records SET data=? WHERE kind='MagpieAccountCheckOwnership'").run('{PRIVATE_CORRUPT');assert.throws(()=>api.latest(x.p.id));assert.equal(magpieBlocksNative(x.h.store),true);
});
test('M13 idempotent recovered reads never call OS a second time and altered process journal reblocks',async t=>{
 const x=await fixture(t);await uncertain(x);let calls=0;const api=await recovery(x,{jobCleanup:(_r,b)=>{calls++;return{kind:'TRUSTED_WINDOWS_JOB',scopeId:b.jobId,receiptSha256:hash('OFFLINE_CLEANUP')};}}),target=api.latest(x.p.id);
 const one=await api.reconcile(x.p.id,target.targetHash,actor,new AbortController().signal);assert.deepEqual(await api.reconcile(x.p.id,target.targetHash,actor,new AbortController().signal),one);assert.equal(calls,1);
 x.h.store.db.prepare("DELETE FROM records WHERE kind='OwnedWindowsJobPinned'").run();assert.equal(magpieBlocksNative(x.h.store),true);assert.throws(()=>api.latest(x.p.id));
});
