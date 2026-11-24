// ACTUAL_WINDOWS_CONTROLLED_FILES_AND_OWNED_JOB_ONLY. No models/accounts/formal DB or data acceptance.
import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,mkdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';import {join} from 'node:path';
import {harness,root} from '../helpers.mjs';import {withProcessOwnership,processCleanupProven} from '../../dist/server/flow/process-ownership.js';import {hash,DomainError} from '../../dist/server/security.js';
async function setup(t){const h=harness(t),scope={store:h.store,projectId:null,runId:null,dispatchId:'OFFLINE_STORAGE_CUSTODY_OS',generation:'OFFLINE_LOCAL_COMPONENT',mode:'live'};
 const modulePath=new URL('../../dist/server/windows-storage-custody.js',import.meta.url);assert.ok(existsSync(modulePath),'STORAGE_CUSTODY_ORIGINAL_PROCESS_BRIDGE_MISSING');const {withWindowsStorageCustody}=await import(modulePath.href);
 return{h,scope,run:(action,options={})=>withProcessOwnership(scope,()=>withWindowsStorageCustody(root,join(h.dir,'held-data'),action,options))};}

test('owned keeper protects directories and opaque images across awaited controller operations, then proves release',async t=>{
 const f=await setup(t),operation='a'.repeat(64),bytes=Buffer.alloc(8192,7);let folder,file;
 const value=await f.run(async lease=>{
  const directory=await lease.directory('controller/images/project',true);folder=directory.path;assert.match(directory.identity,/^[a-f0-9]+:[a-f0-9]+$/i);
  file=join(folder,operation+'.sqlite');writeFileSync(file,bytes);await new Promise(r=>setTimeout(r,20));lease.assertActive();
  assert.throws(()=>renameSync(folder,folder+'-moved'));
  const pin=await lease.image('controller/images/project',operation,bytes.length,hash(bytes));assert.equal(pin.sha256,hash(bytes));assert.equal(pin.bytes,8192);
  assert.throws(()=>writeFileSync(file,Buffer.alloc(8192,9)));assert.throws(()=>unlinkSync(file));lease.assertActive();return'ACTUAL_OS_COMPONENT_ONLY';
 });
 assert.equal(value,'ACTUAL_OS_COMPONENT_ONLY');renameSync(folder,folder+'-released');renameSync(folder+'-released',folder);writeFileSync(file,bytes);
 assert.equal(processCleanupProven(f.scope),true);const row=f.h.store.db.prepare("SELECT data FROM records WHERE kind='OwnedWindowsJobClosed' ORDER BY rowid DESC LIMIT 1").get();assert.equal(JSON.parse(row.data).activeProcesses,0);
});

test('owned keeper protects an arbitrary controller database file by exact size and digest',async t=>{
 const f=await setup(t),bytes=Buffer.alloc(8192,11);
 const value=await f.run(async lease=>{
  const folder=(await lease.directory('controller/rehearsals/application',true)).path;
  const file=join(folder,'application.sqlite');
  writeFileSync(file,bytes);
  const pin=await lease.file('controller/rehearsals/application/application.sqlite',bytes.length,hash(bytes));
  assert.equal(pin.bytes,bytes.length);assert.equal(pin.sha256,hash(bytes));
  assert.throws(()=>writeFileSync(file,Buffer.alloc(8192,12)));
  assert.throws(()=>renameSync(file,file+'-moved'));
  lease.assertActive();
  return'ACTUAL_OS_FILE_COMPONENT_ONLY';
 });
 assert.equal(value,'ACTUAL_OS_FILE_COMPONENT_ONLY');
 assert.equal(processCleanupProven(f.scope),true);
});

test('callback failure still releases original owned job and ancestor handles',async t=>{
 const f=await setup(t);let folder;
 await assert.rejects(f.run(async lease=>{folder=(await lease.directory('child',true)).path;throw new DomainError('OFFLINE_EXPECTED_CALLBACK_FAILURE',409);}),{code:'OFFLINE_EXPECTED_CALLBACK_FAILURE'});
 renameSync(folder,folder+'-released');renameSync(folder+'-released',folder);assert.equal(processCleanupProven(f.scope),true);
});

test('owned cancellation blocks the next operation before creating its path and proves job cleanup',async t=>{
 const f=await setup(t),abort=new AbortController();let folder;
 await assert.rejects(f.run(async lease=>{folder=(await lease.directory('existing',true)).path;abort.abort();await lease.directory('must-not-exist',true);},{signal:abort.signal}),{code:'RUN_CANCELLED'});
 assert.equal(existsSync(join(f.h.dir,'held-data/must-not-exist')),false);renameSync(folder,folder+'-released');renameSync(folder+'-released',folder);assert.equal(processCleanupProven(f.scope),true);
});

test('relative traversal is rejected before any unscoped path operation',async t=>{
 const f=await setup(t);await assert.rejects(f.run(async lease=>{await lease.directory('../outside',true);}),{code:'STORAGE_CUSTODY_PATH_DENIED'});
 assert.equal(existsSync(join(f.h.dir,'outside')),false);assert.equal(processCleanupProven(f.scope),true);
});

test('cancellation after Job pin but before keeper readiness never enters the action and proves cooperative close',async t=>{
 const f=await setup(t),abort=new AbortController(),record=f.h.store.record.bind(f.h.store);let pinned=false,entered=false;
 t.mock.method(f.h.store,'record',(...args)=>{
  const result=record(...args);
  if(args[0]==='OwnedWindowsJobPinned'&&!pinned){pinned=true;queueMicrotask(()=>abort.abort());}
  return result;
 });
 await assert.rejects(f.run(async()=>{entered=true;},{signal:abort.signal,timeoutMs:15000}),{code:'RUN_CANCELLED'});
 assert.equal(pinned,true);assert.equal(entered,false);assert.equal(processCleanupProven(f.scope),true);
 const rows=f.h.store.db.prepare("SELECT data FROM records WHERE kind='OwnedWindowsJobClosed'").all();
 assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].data).activeProcesses,0);
});

test('controller root on another drive is refused before owned-process intent or any write',async t=>{
 const f=await setup(t),{withWindowsStorageCustody}=await import('../../dist/server/windows-storage-custody.js');
 await assert.rejects(withProcessOwnership(f.scope,()=>withWindowsStorageCustody('C:/DM-CUSTODY-NONEXISTENT-NO-WRITE',join(f.h.dir,'held-data'),async()=>{})),{code:'STORAGE_CUSTODY_PATH_DENIED'});
 assert.equal(f.h.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='OwnedProcessIntent'").get().n,0);
});
