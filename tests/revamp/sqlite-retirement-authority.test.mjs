// OFFLINE origin/role receipts, actual original Store/files/Windows image handles. No Native/business acceptance.
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {readFileSync,renameSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {harness,ready,root} from '../helpers.mjs';import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';import {seedOfflineSqliteReview} from '../fixtures/sqlite-review.mjs';
import {SqliteDatasets} from '../../dist/server/sqlite-data.js';import {sqliteInputDescriptor} from '../../dist/server/sqlite-channel.js';import {hash,DomainError} from '../../dist/server/security.js';
import {withProcessOwnership,processCleanupProven} from '../../dist/server/flow/process-ownership.js';import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
const load=()=>import('../../dist/server/sqlite-retirement.js'),actor='local-session:'+'a'.repeat(64),operation=hash('OFFLINE_RETIRE_OPERATION');
const plan={schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:'python',entry:'data.py',args:[]};
async function setup(t){
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h),made=h.engine.create(p.id,s.hash,true);await h.engine.settled(made.id);
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);const r=h.store.run(made.id);r.mode='live';r.plan={...r.plan,dataRuntime:plan};seedOfflineSqliteReview(h.store,r);
 const path=join(h.dir,'trusted-controller-fixture.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE values_only(value INTEGER)');db.close();const image=readFileSync(path),data=new SqliteDatasets(h.store,root,h.dir),capture=data.capture(r.id,r.treeHash,0,hash(plan));
 const descriptor=sqliteInputDescriptor(null,capture.binding),helperHash=hash(readFileSync(root+'/scripts/isolation/sqlite-snapshot.py','utf8')),workerHash=hash(readFileSync(root+'/scripts/isolation/wsl-worker.py','utf8')),resourceHelperHash=hash(readFileSync(root+'/scripts/isolation/wsl-resource-context.py','utf8'));
 const result={schema:'dream-maker.wsl-result.v1',jobId:'wsl_job_offline_retirement',sourceHash:r.treeHash,workerHash,environment:WSL_ENVIRONMENT,status:'EXECUTED',exitCode:0,stdout:'',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true},sqlite:{...descriptor,schema:'dream-maker.sqlite-execution.v1',snapshotHelperHash:helperHash,snapshotStatus:'READY',snapshot:{schema:'dream-maker.sqlite-snapshot.v1',bytes:image.length,sha256:hash(image),sqliteVersion:'3.45.1',integrity:'ok'},generatedPidsAfter:[],snapshotPidsAfter:[],privateMountNamespace:true,runTmpfsBytes:33554432,dataTmpfsBytes:218103808,mountsRemoved:true,retention:{schema:'dream-maker.sqlite-retention.v1',state:'RETAINED',bytes:image.length,manifestHash:'c'.repeat(64)}}};
 const dispatchId='dispatch_offline_retirement_origin',generation='dispatch_owner_offline_origin',common={dispatchId,generation,fixtureProvenance:'OFFLINE_TEST_ONLY'},record=(kind,value)=>h.store.record(kind,p.id,r.id,{...common,...value});
 record('DispatchGranted',{kind:'data-runtime',mode:'live'});
 const request={runId:r.id,projectId:p.id,specHash:s.hash,sourceHash:r.treeHash,planHash:hash(plan),revision:0,actor};record('SqliteDataRuntimeRequested',{operationHash:operation,...request,inputHash:capture.binding.inputHash});
 record('OwnedWslSandboxIntent',{processId:'owned_process_offline_retire_origin',jobId:result.jobId,sourceHash:r.treeHash,workerHash,resourceHelperHash,environment:WSL_ENVIRONMENT});
 record('OwnedWslSandboxClosed',{jobId:result.jobId,sourceHash:r.treeHash,workerHash,resourceHelperHash,resultSha256:hash(result),resourceFinalHash:'d'.repeat(64),cleanup:result.cleanup});
 record('OwnedProcessCleanup',{processId:'owned_process_offline_retire_origin',kind:'TRUSTED_WSL_SANDBOX',scopeId:result.jobId,receiptSha256:'e'.repeat(64),cleanupReturned:true});
 data.publish(capture,{result,image,exchangeMetadata:{schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',...capture.binding,imageBytes:image.length,imageHash:hash(image),result}},operation,actor);
 record('SqliteDataRuntimeRetained',{operationHash:operation,jobId:result.jobId,resultHash:hash(result),manifestHash:'c'.repeat(64),state:'RETAINED',guestRemoved:false});record('DispatchFinished',{outcome:'COMPLETED',cleanupReturned:true});
 h.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run('sqlite-runtime:'+operation,hash(request),'done',JSON.stringify({hash:operation,appliedRevision:1}),new Date().toISOString());
 const scope={store:h.store,projectId:p.id,runId:r.id,dispatchId:'dispatch_offline_retirement',generation:'dispatch_owner_offline_retirement',mode:'live'};
 return {h,p,r,data,image,scope,request,operation,run:fn=>withProcessOwnership(scope,fn)};
}
test('retirement authority derives only from original committed version/request/owned-worker records',async t=>{
 const x=await setup(t),m=await load(),b=m.sqliteRetirementBasis(x.h.store,x.r.id,operation);assert.equal(b.operationHash,operation);assert.equal(b.revision,1);assert.equal(b.jobId,'wsl_job_offline_retirement');assert.equal(b.imageHash,hash(x.image));assert.match(b.authorityHash,/^[a-f0-9]{64}$/);
 const before=x.h.store.db.prepare('SELECT count(*) n FROM records').get().n;m.sqliteRetirementBasis(x.h.store,x.r.id,operation);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM records').get().n,before);
 x.h.store.db.prepare("UPDATE requests SET status='failed' WHERE key=?").run('sqlite-runtime:'+operation);assert.throws(()=>m.sqliteRetirementBasis(x.h.store,x.r.id,operation));
});
test('missing/foreign or contradictory original runtime evidence never authorizes retirement',async t=>{
 const x=await setup(t),m=await load();assert.throws(()=>m.sqliteRetirementBasis(x.h.store,x.r.id,hash('OFFLINE_OTHER')));
 const row=x.h.store.db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='OwnedWslSandboxClosed' ORDER BY rowid DESC LIMIT 1").get(x.r.id),old=JSON.parse(row.data);
 for(const change of [{jobId:'wsl_job_other'},{resultSha256:'f'.repeat(64)},{sourceHash:'f'.repeat(64)},{generation:'other'},{cleanup:{...old.cleanup,remainingPids:['OFFLINE_REMAINING']}},{cleanup:{...old.cleanup,groupRemoved:false}}]){x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...old,...change}),row.id);assert.throws(()=>m.sqliteRetirementBasis(x.h.store,x.r.id,operation));}x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(row.data,row.id);
 const kept=x.h.store.db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='SqliteDataRuntimeRetained'").get(x.r.id);
 for(const change of [{state:'UNKNOWN'},{guestRemoved:true}]){x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(kept.data),...change}),kept.id);assert.throws(()=>m.sqliteRetirementBasis(x.h.store,x.r.id,operation));}x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(kept.data,kept.id);
});
test('the original owned scope pins exact committed bytes and issues a single-use non-JSON permit',async t=>{
 const x=await setup(t),m=await load();let held;
 const value=await x.run(()=>m.withSqliteRetirementPermit(x.h.store,root,x.h.dir,x.r.id,operation,async(permit,signal)=>{
  held=permit;assert.throws(()=>m.consumeSqliteRetirementPermit(JSON.parse(JSON.stringify(permit)),x.h.store,root,signal));
  assert.throws(()=>m.consumeSqliteRetirementPermit(permit,x.h.store,root,new AbortController().signal));
  const b=m.consumeSqliteRetirementPermit(permit,x.h.store,root,signal);assert.equal(b.operationHash,operation);
  const path=join(x.h.dir,'controller/sqlite-images',hash(x.p.id),operation+'.sqlite');assert.throws(()=>renameSync(path,path+'.moved'));assert.throws(()=>m.consumeSqliteRetirementPermit(permit,x.h.store,root,signal));return 'OFFLINE_NO_HELPER_CALLED';
 }));assert.equal(value,'OFFLINE_NO_HELPER_CALLED');assert.equal(processCleanupProven(x.scope),true);assert.throws(()=>m.consumeSqliteRetirementPermit(held,x.h.store,root,new AbortController().signal));
 const path=join(x.h.dir,'controller/sqlite-images',hash(x.p.id),operation+'.sqlite');renameSync(path,path+'.released');renameSync(path+'.released',path);
});
test('no ownership, foreign scope, cancellation or changed committed bytes creates a cleanup permit',async t=>{
 const x=await setup(t),m=await load();let called=0;const action=()=>{called++;return 'MUST_NOT_ISSUE';},call=()=>m.withSqliteRetirementPermit(x.h.store,root,x.h.dir,x.r.id,operation,action);
 await assert.rejects(call());await assert.rejects(withProcessOwnership({...x.scope,runId:'OFFLINE_FOREIGN'},call));await assert.rejects(x.run(()=>m.withSqliteRetirementPermit(x.h.store,root,x.h.dir,x.r.id,operation,action,{signal:AbortSignal.abort()})));
 writeFileSync(join(x.h.dir,'controller/sqlite-images',hash(x.p.id),operation+'.sqlite'),'OFFLINE_CORRUPTED_IMAGE');await assert.rejects(x.run(call));assert.equal(called,0);
});

test('a pending request authorizes only its exact original owner after immutable commit, never a restarted owner',async t=>{
 const x=await setup(t),m=await load();x.h.store.db.prepare("UPDATE requests SET status='pending',response=NULL WHERE key=?").run('sqlite-runtime:'+operation);
 assert.throws(()=>m.sqliteRetirementBasis(x.h.store,x.r.id,operation));await assert.rejects(x.run(()=>m.withSqliteRetirementPermit(x.h.store,root,x.h.dir,x.r.id,operation,()=>{})));
 const original={...x.scope,dispatchId:'dispatch_offline_retirement_origin',generation:'dispatch_owner_offline_origin'};
 await withProcessOwnership(original,()=>m.withSqliteRetirementPermit(x.h.store,root,x.h.dir,x.r.id,operation,(permit,signal)=>{assert.equal(m.consumeSqliteRetirementPermit(permit,x.h.store,root,signal).operationHash,operation);}));
});

test('caller cancellation aborts cleanup but keeps the committed image pinned until the callback exits',async t=>{
 const x=await setup(t),m=await load(),abort=new AbortController(),path=join(x.h.dir,'controller/sqlite-images',hash(x.p.id),operation+'.sqlite');
 const work=x.run(()=>m.withSqliteRetirementPermit(x.h.store,root,x.h.dir,x.r.id,operation,async(permit,signal)=>{
  m.consumeSqliteRetirementPermit(permit,x.h.store,root,signal);
  abort.abort(new DomainError('RUN_CANCELLED',409));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(signal.aborted,true);
  assert.throws(()=>renameSync(path,path+'.moved'));
  throw signal.reason;
 },{signal:abort.signal}));
 await assert.rejects(work,{code:'RUN_CANCELLED'});
 renameSync(path,path+'.released');renameSync(path+'.released',path);
 assert.equal(processCleanupProven(x.scope),true);
});
