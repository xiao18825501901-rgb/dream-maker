// ACTUAL_WINDOWS_LOCAL_BENIGN_PROCESS_TREE. No model, auth, generated project or shared config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync,readFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { own,capture } from '../../dist/server/process.js';
import { withProcessOwnership,processCleanupProven } from '../../dist/server/flow/process-ownership.js';
import { readWindowsJobCleanup,WindowsJobSession,WINDOWS_JOB_COMPILE_CEILING_MS } from '../../dist/server/flow/windows-job.js';
import { EngineDispatch } from '../../dist/server/flow/dispatch.js';
import { inspectDispatchOwnership } from '../../dist/server/flow/ownership-recovery.js';
import { probeProcessIdentity } from '../../dist/server/server-lock.js';
import { harness,root,until } from '../helpers.mjs';
const running=pid=>{assert.ok(Number.isSafeInteger(pid)&&pid>0,'a missing PID must never become process.kill(undefined)');try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const identityModule=new URL('../../dist/server/server-lock.js',import.meta.url).href;
test('Windows Job compile ceiling stays bounded and covers a cold Add-Type',()=>{
 // Measured cold PowerShell plus Add-Type on this host: 15-105s. The ceiling must
 // allow that compile to finish while still refusing an unbounded wait.
 assert.equal(WINDOWS_JOB_COMPILE_CEILING_MS,180000);
 assert.throws(
  ()=>new WindowsJobSession(root,process.execPath,[],root,{},'ceiling-check',WINDOWS_JOB_COMPILE_CEILING_MS+1),
  {code:'WINDOWS_JOB_START_LIMIT_INVALID'},
 );
});
function runningSame(value){assert.match(value.identity,/^win32:\d+$/);try{return probeProcessIdentity(value.pid)===value.identity;}catch(error){if(!running(value.pid))return false;throw error;}}
const heldSource=`(async()=>{const {probeProcessIdentity}=await import(${JSON.stringify(identityModule)});require('node:fs').writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,identity:probeProcessIdentity(process.pid)}));setTimeout(()=>process.exit(0),30000);})().catch(()=>process.exit(75));`;
test('Windows Job closes descendants even when their root already exited; unrelated canary survives',{skip:process.platform!=='win32'},async t=>{
 const h=harness(t),p=h.interviews.create('Windows Job ownership','benign process tree','demo'),pidfile=resolve(h.dir,'orphan.json'),entry=resolve(h.dir,'orphan-parent.cjs');
 writeFileSync(entry,`(async()=>{const {probeProcessIdentity}=await import(${JSON.stringify(identityModule)});const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),30000)'],{stdio:'ignore'});if(!Number.isSafeInteger(child.pid))throw Error('BENIGN_CHILD_NOT_CREATED');const identity=probeProcessIdentity(child.pid);if(!identity)throw Error('BENIGN_CHILD_IDENTITY_MISSING');fs.writeFileSync(process.argv[2],JSON.stringify({pid:child.pid,identity}));child.unref();})().catch(()=>process.exit(75));`);
 const canary=own(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root});canary.child.stdout.resume();canary.child.stderr.resume();
 const scope={store:h.store,projectId:p.id,runId:'local-os-check',dispatchId:'local-windows-job-check',generation:'local-check',mode:'live'};
 try{const result=await withProcessOwnership(scope,()=>capture(process.execPath,[entry,pidfile],{cwd:root,windowsJobRoot:root,timeoutMs:15000}));
 assert.equal(result.code,0,result.stderr);const observed=JSON.parse(readFileSync(pidfile,'utf8'));
 await until(()=>!runningSame(observed),1500);assert.equal(running(canary.child.pid),true);
 assert.equal(processCleanupProven(scope),true);
 assert.equal(h.store.records(p.id,'OwnedWindowsJobPinned').length,1);
 assert.equal(h.store.records(p.id,'OwnedWindowsJobClosed').at(-1).data.activeProcesses,0);
 }finally{await canary.stop();}
});
test('terminating only the Windows Job wrapper also closes its inherited descendants',{skip:process.platform!=='win32'},async t=>{
 const h=harness(t),p=h.interviews.create('wrapper stop','benign owned process','demo'),pidfile=resolve(h.dir,'held.json'),entry=resolve(h.dir,'held.cjs');
 writeFileSync(entry,heldSource);
 const scope={store:h.store,projectId:p.id,runId:'local-stop-check',dispatchId:'local-job-stop',generation:'local-check',mode:'live'};
 const child=withProcessOwnership(scope,()=>own(process.execPath,[entry,pidfile],{cwd:root,windowsJobRoot:root}));child.child.stdout.resume();child.child.stderr.resume();try{
 await until(()=>existsSync(pidfile),12000);const observed=JSON.parse(readFileSync(pidfile,'utf8'));
 await child.stop();await until(()=>!runningSame(observed));assert.equal(processCleanupProven(scope),true);
 }finally{await child.stop();}
});
test('actual Windows owner death closes the child and supports a read-only pinned Job check',{skip:process.platform!=='win32'},async t=>{
 const h=harness(t),entry=resolve(h.dir,'owner-death.cjs'),pidfile=resolve(h.dir,'owner-death.json');
 writeFileSync(entry,heldSource);
 const out=await capture(process.execPath,[resolve(root,'tests/fixtures/windows-job-owner.mjs'),entry,pidfile],{cwd:root,timeoutMs:20000});
 assert.equal(out.code,0,out.stderr);const binding=JSON.parse(out.stdout.trim());await until(()=>!runningSame(binding),6000);
 const proof=readWindowsJobCleanup(root,binding);assert.equal(proof.kind,'TRUSTED_WINDOWS_JOB');assert.match(proof.receiptSha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>readWindowsJobCleanup(root,{...binding,markerSha256:'0'.repeat(64)}),{code:'PROCESS_CLEANUP_UNPROVEN'});
});
test('lost cleanup journal after a real Job exit is reconciled by a fresh OS check, without dispatching again',{skip:process.platform!=='win32'},async t=>{
 const h=harness(t),p=h.interviews.create('physical cleanup with journal failure','local controlled check','demo'),binding={measure:()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()}),isCurrent:()=>true};
 const queue=new EngineDispatch(h.store,binding),record=h.store.record.bind(h.store),runId='local-recovery';let once=false;
 h.store.record=(kind,...args)=>{if(kind==='OwnedProcessCleanup'&&!once){once=true;throw Error('OFFLINE_LOCAL_JOURNAL_LOSS');}return record(kind,...args);};
 try{await assert.rejects(queue.run({projectId:p.id,runId,kind:'reviewer',mode:'live',signal:new AbortController().signal},async control=>{await capture(process.execPath,['-e','process.stdout.write("benign local process")'],{cwd:root,windowsJobRoot:root,timeoutMs:15000});control.confirmCleanup();}),{code:'PROCESS_CLEANUP_UNPROVEN'});}
 finally{h.store.record=record;await queue.close();}
 assert.equal(queue.snapshot().quarantined.length,1);const restored=new EngineDispatch(h.store,binding);
 await restored.reconcileOwned(runId,(dispatchId)=>inspectDispatchOwnership(h.store,root,h.config,p.id,runId,dispatchId));
 assert.equal(restored.snapshot().quarantined.length,0);assert.equal(h.store.records(p.id,'DispatchGranted').length,1);
 assert.equal(h.store.records(p.id,'DispatchReconciled').length,1);await restored.close();
});
test('a native probe outside a dispatch must still await its OS Job cleanup query',{skip:process.platform!=='win32'},async()=>{
 const original=WindowsJobSession.prototype.prove;WindowsJobSession.prototype.prove=async()=>{throw Error('OFFLINE_OS_INSPECTION_FAILURE');};
 try{await assert.rejects(capture(process.execPath,['-e','process.stdout.write("benign probe")'],{cwd:root,windowsJobRoot:root,timeoutMs:15000}),{code:'PROCESS_CLEANUP_UNPROVEN'});}
 finally{WindowsJobSession.prototype.prove=original;}
});

test('a missed startup marker can still obtain a fresh OS cleanup proof after actual exit',{skip:process.platform!=='win32'},async()=>{
 const original=WindowsJobSession.prototype.pin;let first=true;
 WindowsJobSession.prototype.pin=async function(){if(first){first=false;throw Error('OFFLINE_FIRST_MARKER_OBSERVATION_MISSED');}return original.call(this);};
 let child;
 try{
  child=own(process.execPath,['-e','process.stdout.write("benign late marker")'],{cwd:root,windowsJobRoot:root});child.child.stdout.resume();child.child.stderr.resume();
  await assert.rejects(child.ready,/OFFLINE_FIRST_MARKER_OBSERVATION_MISSED/);
  await child.closed;await child.stop();
 }finally{WindowsJobSession.prototype.pin=original;await child?.stop().catch(()=>{});}
});
