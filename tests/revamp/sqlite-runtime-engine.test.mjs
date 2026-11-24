// OFFLINE roles/worker receipts; actual original Engine/Store/Dispatch/Windows keeper. NOT Native business acceptance.
import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {harness,ready,root} from '../helpers.mjs';import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';import {seedOfflineSqliteReview} from '../fixtures/sqlite-review.mjs';
import {hash,DomainError} from '../../dist/server/security.js';import {sqliteInputDescriptor} from '../../dist/server/sqlite-channel.js';
import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
import {beginOwnedProcess,currentProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {consumeSqliteRetirementPermit} from '../../dist/server/sqlite-retirement.js';
import {SqliteDatasets} from '../../dist/server/sqlite-data.js';
const actor='local-session:'+'c'.repeat(64),op=name=>hash('OFFLINE_M61_'+name);
const plan=()=>({schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:'python',entry:'data.py',args:[]});
const latch=()=>{let release;return {promise:new Promise(r=>release=r),release:()=>release()};};
async function fixtureEntered(entry,work,release){
 let timer;try{await Promise.race([entry,work.then(()=>{throw Error('OFFLINE_COMPLETED_BEFORE_ENTRY');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OFFLINE_OWNED_START_TIMEOUT')),60000);})]);}
 catch(error){release();await work.catch(()=>{});throw error;}finally{clearTimeout(timer);}
}
function exchange(input,image){
 const descriptor=sqliteInputDescriptor(input.image,input.binding),sha256=hash(image),result={schema:'dream-maker.wsl-result.v1',jobId:'wsl_job_offline_m61',sourceHash:input.sourceHash,workerHash:hash(readFileSync(root+'/scripts/isolation/wsl-worker.py','utf8')),environment:WSL_ENVIRONMENT,status:'EXECUTED',exitCode:0,stdout:'',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true},sqlite:{...descriptor,schema:'dream-maker.sqlite-execution.v1',snapshotHelperHash:hash(readFileSync(root+'/scripts/isolation/sqlite-snapshot.py','utf8')),snapshotStatus:'READY',snapshot:{schema:'dream-maker.sqlite-snapshot.v1',bytes:image.length,sha256,sqliteVersion:'3.45.1',integrity:'ok'},generatedPidsAfter:[],snapshotPidsAfter:[],privateMountNamespace:true,runTmpfsBytes:33554432,dataTmpfsBytes:218103808,mountsRemoved:true,retention:{schema:'dream-maker.sqlite-retention.v1',state:'RETAINED',bytes:image.length,manifestHash:'b'.repeat(64)}}};
 return {result,image,exchangeMetadata:{schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',...input.binding,imageBytes:image.length,imageHash:sha256,result}};
}
const healthyVolume=async()=>({
 schema:'dream-maker.storage-volume-health.v1',scope:'VOLUME_HEALTH_ONLY',drive:'F:',fileSystem:'NTFS',
 healthStatus:'Healthy',operationalStatus:'OK',totalBytes:1000000,availableBytes:500000,state:'HEALTHY',
 evidence:'WINDOWS_STORAGE_READ_ONLY',checkedAt:'2026-11-07T00:00:00.000Z'
});
async function setup(t,action,storageProbe=healthyVolume){
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h),made=h.engine.create(p.id,s.hash,true);await h.engine.settled(made.id);
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);const run=h.store.run(made.id);run.mode='live';run.review={...run.review,source:'CODEX'};run.plan={...run.plan,dataRuntime:plan()};seedOfflineSqliteReview(h.store,run);
 const path=join(h.dir,'controller-only-fixture.sqlite'),db=new DatabaseSync(path);db.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES('PRIVATE_M61_BUSINESS_VALUE')");db.close();const image=readFileSync(path);
 let calls=0,seen;h.engine.nativeExecution={assertReady(){},executor(){throw Error('NO_MODELS');},verify(){throw Error('NO_VERIFIER');},async close(){},async runSqliteData(input){calls++;seen=input;if(action)await action(input);return exchange(input,image);}};
 const data=new SqliteDatasets(h.store,root,h.dir,{},storageProbe);h.engine.sqliteData=data;
 return {h,p,s,run,image,data,calls:()=>calls,seen:()=>seen,execute:(name='one',revision=0)=>h.engine.executeSqliteData(run.id,run.treeHash,revision,true,op(name),actor)};
}

function originalOfflineWorker(x){
 x.h.engine.nativeExecution.sqliteRetirementEnabled=true;
 x.h.engine.nativeExecution.runSqliteData=async input=>{
  const o=currentProcessOwnership(),record=(kind,value)=>x.h.store.record(kind,o.projectId,o.runId,{dispatchId:o.dispatchId,generation:o.generation,fixtureProvenance:'OFFLINE_TEST_ONLY',...value}),r=exchange(input,x.image),processId='owned_process_offline_retirement_origin';
  record('OwnedWslSandboxIntent',{processId,jobId:r.result.jobId,sourceHash:r.result.sourceHash,workerHash:r.result.workerHash,resourceHelperHash:hash(readFileSync(root+'/scripts/isolation/wsl-resource-context.py','utf8')),environment:WSL_ENVIRONMENT});
  record('OwnedWslSandboxClosed',{jobId:r.result.jobId,sourceHash:r.result.sourceHash,workerHash:r.result.workerHash,resourceHelperHash:hash(readFileSync(root+'/scripts/isolation/wsl-resource-context.py','utf8')),resourceFinalHash:'d'.repeat(64),resultSha256:hash(r.result),cleanup:r.result.cleanup});
  record('OwnedProcessCleanup',{processId,kind:'TRUSTED_WSL_SANDBOX',scopeId:r.result.jobId,receiptSha256:'e'.repeat(64),cleanupReturned:true});return r;
 };
}
test('same original data Dispatch retires only after immutable commit, pins exact bytes and never regenerates on replay',async t=>{
 const x=await setup(t);originalOfflineWorker(x);let calls=0;
 x.h.engine.nativeExecution.retireSqliteData=async({permit,signal})=>{calls++;const owner=currentProcessOwnership(),b=consumeSqliteRetirementPermit(permit,x.h.store,root,signal);assert.equal(owner.dispatchId,b.originalDispatchId);assert.equal(x.data.read(x.p.id).revision,1);assert.equal(x.h.store.db.prepare('SELECT status FROM requests WHERE key=?').get('sqlite-runtime:'+b.operationHash).status,'pending');return {schema:'dream-maker.sqlite-retirement-receipt.v1',attemptId:'retire_attempt_'+'a'.repeat(32),jobId:b.jobId,authorityHash:b.authorityHash,outcomeHash:'b'.repeat(64),retired:true,reservationReleased:true,cleanupReturned:true};};
 const result=await x.execute('retire');assert.equal(result.revision,1);assert.equal(calls,1);assert.equal(x.h.store.records(x.p.id,'SqliteDataRuntimeRetained').length,1);assert.equal(x.h.store.records(x.p.id,'SqliteDataRuntimeRetired').length,1);
 await x.execute('retire');assert.equal(calls,1);assert.equal(x.h.engine.dispatchStatus().quarantined.length,0);
});
test('uncertain retirement preserves committed data and prevents retrying the generated operation',async t=>{
 const x=await setup(t);originalOfflineWorker(x);let calls=0;
 x.h.engine.nativeExecution.retireSqliteData=async()=>{calls++;throw new DomainError('SQLITE_RETIREMENT_RESULT_UNCERTAIN',409);};
 await assert.rejects(x.execute('retire-uncertain'),{code:'SQLITE_RETIREMENT_RESULT_UNCERTAIN'});assert.equal(x.data.read(x.p.id).revision,1);assert.equal(calls,1);
 await assert.rejects(x.execute('retire-uncertain'),{code:'REQUEST_RESULT_UNCERTAIN'});assert.equal(calls,1);assert.equal(x.h.store.records(x.p.id,'SqliteDataRetirementUncertain').length,1);assert.equal(x.h.store.records(x.p.id,'SqliteDataRuntimeRetired').length,0);
});
test('unreleased native retirement capability keeps committed data explicitly retained without starting cleanup',async t=>{
 const x=await setup(t);originalOfflineWorker(x);let calls=0;x.h.engine.nativeExecution.sqliteRetirementEnabled=false;
 x.h.engine.nativeExecution.retireSqliteData=async()=>{calls++;throw Error('UNRELEASED_RETIREMENT_STARTED');};
 assert.equal((await x.execute('disabled-retirement')).revision,1);assert.equal(calls,0);assert.equal(x.h.store.records(x.p.id,'SqliteDataRuntimeRetained').length,1);assert.equal(x.h.store.records(x.p.id,'SqliteDataRuntimeRetired').length,0);
});

test('original Engine captures, dispatches and publishes protected SQLite; replay never reruns or stores binary payload',async t=>{
 const x=await setup(t),before=hash(x.h.store.run(x.run.id)),result=await x.execute();assert.equal(result.revision,1);assert.equal(result.operation.replayed,false);assert.equal(x.calls(),1);
 assert.equal(x.seen().image,null);assert.equal(JSON.parse(x.seen().command.stdin).database,'/data/project.sqlite');
 const again=await x.execute();assert.equal(again.operation.replayed,true);assert.equal(again.operation.appliedRevision,1);assert.equal(x.calls(),1);
 assert.equal(hash(x.h.store.run(x.run.id)),before);assert.equal(x.h.engine.activeJobCount,0);assert.equal(x.h.engine.dispatchStatus().quarantined.length,0);
 const queued=x.h.store.records(x.p.id,'DispatchQueued').filter(r=>r.data.kind==='data-runtime');assert.ok(queued.some(r=>r.data.demand.memoryMiB===1536));assert.ok(queued.every(r=>r.data.demand.externalModelSlots===0));
 const saved=x.h.store.records(x.p.id,'SqliteDataRuntimeCommitted');assert.equal(saved.length,1);assert.equal(saved[0].data.jobId,'wsl_job_offline_m61');
 assert.doesNotMatch(JSON.stringify(x.h.store.db.prepare('SELECT key,request_hash,status,response FROM requests').all()),/PRIVATE_M61|SQLite format|base64|stdout|"type":"Buffer"/);
 assert.equal(x.h.store.records(x.p.id,'ModelAttempt').length,0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);
});

for(const [state,code] of [['REPAIR_REQUIRED','STORAGE_VOLUME_REPAIR_REQUIRED'],['UNKNOWN','STORAGE_VOLUME_HEALTH_UNKNOWN']]){
 test('original Engine refuses '+state+' durable storage before Dispatch, worker or SQLite Intent',async t=>{
  const rejectedVolume=async()=>({
   schema:'dream-maker.storage-volume-health.v1',scope:'VOLUME_HEALTH_ONLY',drive:'F:',
   fileSystem:state==='UNKNOWN'?null:'exFAT',healthStatus:state==='UNKNOWN'?null:'Warning',
   operationalStatus:state==='UNKNOWN'?null:'Full Repair Needed',totalBytes:state==='UNKNOWN'?null:1000000,
   availableBytes:state==='UNKNOWN'?null:500000,state,evidence:state==='UNKNOWN'?'PROBE_UNAVAILABLE':'WINDOWS_STORAGE_READ_ONLY',
   checkedAt:'2026-11-07T00:00:00.000Z'
  });
  const x=await setup(t,undefined,rejectedVolume),ownedBefore=x.h.store.records(x.p.id,'OwnedProcessIntent').length;
  await assert.rejects(x.execute('storage-gate-'+state),{code});
  assert.equal(x.calls(),0);assert.equal(x.data.read(x.p.id).revision,0);
  assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
  assert.equal(x.h.store.records(x.p.id,'SqliteDataRuntimeRequested').length,0);
  assert.equal(x.h.store.records(x.p.id,'OwnedProcessIntent').length,ownedBefore);
  assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM requests WHERE key LIKE 'sqlite-runtime:%'").get().n,0);
 });
}

test('source version drift after runtime refuses publication and leaves same request uncertain rather than rerunning',async t=>{
 const entered=latch(),gate=latch(),x=await setup(t,async()=>{entered.release();await gate.promise;});
 const work=x.execute('drift'),rejected=assert.rejects(work);await fixtureEntered(entered.promise,work,gate.release);
 const current=x.h.store.run(x.run.id);current.plan={...current.plan,dataRuntime:{...plan(),args:['changed']}};x.h.store.saveRun(current);gate.release();await rejected;
 assert.equal(x.data.read(x.p.id).revision,0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);assert.equal(x.calls(),1);
 // The original declaration is restored only in this isolated fixture to test durable request identity.
 current.plan={...current.plan,dataRuntime:plan()};x.h.store.saveRun(current);
 await assert.rejects(x.execute('drift'),{code:'REQUEST_RESULT_UNCERTAIN'});assert.equal(x.calls(),1);
});

test('a concurrent saved image wins CAS and the old runtime cannot overwrite it or retry',async t=>{
 const entered=latch(),gate=latch(),x=await setup(t,async()=>{entered.release();await gate.promise;});
 const work=x.execute('cas'),rejected=assert.rejects(work,{code:'SQLITE_DATA_CONFLICT'});await fixtureEntered(entered.promise,work,gate.release);
 const capture=x.data.capture(x.run.id,x.run.treeHash,0,hash(plan()));x.data.publish(capture,exchange({...capture,command:{}},x.image),op('competing'),actor);gate.release();await rejected;
 assert.equal(x.data.read(x.p.id).revision,1);await assert.rejects(x.execute('cas'),{code:'REQUEST_RESULT_UNCERTAIN'});assert.equal(x.calls(),1);
});

test('cancelled runtime shares the owned signal, commits nothing and preserves the delivered Flow',async t=>{
 const entered=latch(),x=await setup(t,async input=>{entered.release();await new Promise((_,reject)=>{if(input.signal.aborted)reject(input.signal.reason);else input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});});
 const before=hash(x.h.store.run(x.run.id)),work=x.execute('cancel'),rejection=assert.rejects(work);await fixtureEntered(entered.promise,work,()=>{void x.h.engine.cancel(x.run.id).catch(()=>{});});await x.h.engine.cancel(x.run.id);await rejection;
 assert.equal(hash(x.h.store.run(x.run.id)),before);assert.equal(x.data.read(x.p.id).revision,0);assert.equal(x.calls(),1);assert.equal(x.h.engine.activeJobCount,0);assert.equal(x.h.engine.dispatchStatus().quarantined.length,0);
});

test('unknown runtime failure is durable, never auto-retried or converted into a Flow repair',async t=>{
 const x=await setup(t,async()=>{throw new DomainError('RUNNER_RPC_ERROR',502);}),before=hash(x.h.store.run(x.run.id));
 await assert.rejects(x.execute('unknown'),{code:'RUNNER_RPC_ERROR'});await assert.rejects(x.execute('unknown'),{code:'REQUEST_RESULT_UNCERTAIN'});assert.equal(x.calls(),1);assert.equal(hash(x.h.store.run(x.run.id)),before);assert.equal(x.data.read(x.p.id).revision,0);
});

test('unproven worker cleanup refuses publication before any image Intent or committed data',async t=>{
 let unstarted;const x=await setup(t,async()=>{unstarted=beginOwnedProcess('OFFLINE_INTENT_NEVER_ACTUALLY_SPAWNED',[]);});
 try{
  await assert.rejects(x.execute('cleanup'),{code:'PROCESS_CLEANUP_UNPROVEN'});
  assert.equal(x.data.read(x.p.id).revision,0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
 }finally{
  // This deliberately synthetic intent never spawned; use the original no-start and OS reconciliation path.
  unstarted?.notStarted();if(x.h.engine.dispatch.hasUncertain(x.run.id))await x.h.engine.reconcileJsonData(x.run.id);
 }
});

test('missing consent or runtime and unbound Custom cannot grant dispatch, image writes or a model call',async t=>{
 const x=await setup(t);
 await assert.rejects(x.h.engine.executeSqliteData(x.run.id,x.run.treeHash,0,false,op('consent'),actor),{code:'SQLITE_DATA_CONSENT_REQUIRED'});
 const original=x.h.engine.nativeExecution.runSqliteData;delete x.h.engine.nativeExecution.runSqliteData;await assert.rejects(x.execute('missing'),{code:'SQLITE_DATA_RUNTIME_UNAVAILABLE'});x.h.engine.nativeExecution.runSqliteData=original;
 const current=x.h.store.run(x.run.id);current.flowName='custom';assert.throws(()=>x.h.store.saveRun(current),{code:'FLOW_CONFIG_INTEGRITY_FAILED'});
 // Deliberate returned-object seam: immutable production Flow rows are never edited.
 const read=x.h.store.run.bind(x.h.store);t.mock.method(x.h.store,'run',rid=>({...read(rid),flowName:'custom'}));await assert.rejects(x.execute('custom'),{code:'CUSTOM_MAGPIE_SECURITY_REQUIRED'});
 assert.equal(x.calls(),0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});

test('review counterexample: plan drift while publication keeper starts cannot create Intent or commit',async t=>{
 let returned=false;const x=await setup(t,async()=>{returned=true;}),record=x.h.store.record.bind(x.h.store);let changed=false;
 t.mock.method(x.h.store,'record',(...args)=>{const id=record(...args);if(returned&&!changed&&args[0]==='OwnedWindowsJobPinned'){changed=true;const r=x.h.store.run(x.run.id);r.plan={...r.plan,dataRuntime:{...plan(),args:['unreviewed']}};x.h.store.saveRun(r);}return id;});
 await assert.rejects(x.execute('publication-drift'));assert.equal(changed,true);assert.equal(x.data.read(x.p.id).revision,0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});

test('review counterexample: complete binding is rechecked inside the final original Store transaction',async t=>{
 const x=await setup(t),exec=x.h.store.db.exec.bind(x.h.store.db);let changed=false;
 t.mock.method(x.h.store.db,'exec',sql=>{const result=exec(sql);if(!changed&&sql==='BEGIN IMMEDIATE'&&x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n===1){changed=true;const r=x.h.store.run(x.run.id);r.plan={...r.plan,dataRuntime:{...plan(),args:['unreviewed-at-final-CAS']}};x.h.store.saveRun(r);}return result;});
 await assert.rejects(x.execute('commit-drift'));assert.equal(changed,true);assert.equal(x.data.read(x.p.id).revision,0);assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,1);
});

test('review counterexample: a different SQLite declaration after PASS is not implicitly reviewed',async t=>{
 const x=await setup(t),current=x.h.store.run(x.run.id);current.plan={...current.plan,dataRuntime:{...plan(),args:['--reset']}};x.h.store.saveRun(current);
 await assert.rejects(x.execute('unreviewed-plan'),{code:'SQLITE_DATA_REVIEW_BINDING_REQUIRED'});assert.equal(x.calls(),0);assert.equal(x.data.read(x.p.id).revision,0);
});

test('Classic cannot substitute a DSH reviewer for its protected SQLite binding',async t=>{
 const x=await setup(t),row=x.h.store.db.prepare("SELECT id,data FROM records WHERE run_id=? AND kind='Review' ORDER BY rowid DESC LIMIT 1").get(x.run.id),review=JSON.parse(String(row.data));review.source='DSH';x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(review),row.id);
 const current=x.h.store.run(x.run.id);current.review.source='DSH';x.h.store.saveRun(current);
 await assert.rejects(x.execute('classic-dsh'),{code:'SQLITE_DATA_REVIEW_BINDING_REQUIRED'});assert.equal(x.calls(),0);assert.equal(x.data.read(x.p.id).revision,0);
});
