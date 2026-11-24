// OFFLINE_TEST: real files and original Store; seeded delivery/receipt shapes are not Native proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,readdirSync,renameSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {basename,join} from 'node:path';
import * as module from '../../dist/server/sqlite-data.js';
import {sqliteInputDescriptor} from '../../dist/server/sqlite-channel.js';
import {hash} from '../../dist/server/security.js';
import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
import {withProcessOwnership,processCleanupProven} from '../../dist/server/flow/process-ownership.js';

// Actual Windows custody on controlled fixtures; seeded role receipts remain OFFLINE.
function custodyScope(h,p,run){return {store:h.store,projectId:p.id,runId:run.id,dispatchId:'OFFLINE_SQLITE_CAPTURE',generation:'OFFLINE_CAPTURE_GENERATION',mode:'live'};}
test('owned SQLite capture reads empty and saved data through the original keeper and proves close',async t=>{
 const {h,p,run,data,image}=await setup(t),scope=custodyScope(h,p,run);
 const empty=await withProcessOwnership(scope,()=>data.captureOwned(run.id,run.treeHash,0,planHash));
 assert.equal(empty.image,null);assert.equal(processCleanupProven(scope),true);
 const first=data.capture(run.id,run.treeHash,0,planHash);data.publish(first,exchange(first,image),hash('offline-owned-capture-image'),actor);
 const captured=await withProcessOwnership(scope,()=>data.captureOwned(run.id,run.treeHash,1,planHash));
 assert.deepEqual(captured.image,image);assert.equal(captured.binding.expectedRevision,1);
 assert.equal(processCleanupProven(scope),true);assert.equal(data.read(p.id).revision,1);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,1);
});
test('owned SQLite capture rejects source changes while the actual keeper starts and releases its job',async t=>{
 const {h,p,run,data}=await setup(t),scope=custodyScope(h,p,run),record=h.store.record.bind(h.store);let changed=false;
 t.mock.method(h.store,'record',(...args)=>{const id=record(...args);if(!changed&&args[0]==='OwnedWindowsJobPinned'){changed=true;writeFileSync(join(run.workspace,'changed-during-custody.txt'),'OFFLINE source drift');}return id;});
 await assert.rejects(withProcessOwnership(scope,()=>data.captureOwned(run.id,run.treeHash,0,planHash)),{code:'SQLITE_DATA_SOURCE_CHANGED'});
 assert.equal(changed,true);assert.equal(processCleanupProven(scope),true);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});
test('owned SQLite capture rejects missing ownership or already-cancelled work without a process intent',async t=>{
 const {h,p,run,data}=await setup(t),scope=custodyScope(h,p,run),abort=new AbortController(),before=h.store.records(p.id,'OwnedProcessIntent').length;abort.abort();
 await assert.rejects(data.captureOwned(run.id,run.treeHash,0,planHash),{code:'STORAGE_CUSTODY_OWNERSHIP_REQUIRED'});
 await assert.rejects(withProcessOwnership(scope,()=>data.captureOwned(run.id,run.treeHash,0,planHash,{signal:abort.signal})),{code:'RUN_CANCELLED'});
 assert.equal(h.store.records(p.id,'OwnedProcessIntent').length,before);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {harness,ready,root} from '../helpers.mjs';
import {seedOfflineSqliteReview} from '../fixtures/sqlite-review.mjs';
const actor='local-session:'+'a'.repeat(64),runtimePlan={schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:'python',entry:'data.py',args:[]},planHash=hash(runtimePlan);
const healthyVolume=async()=>({
 schema:'dream-maker.storage-volume-health.v1',scope:'VOLUME_HEALTH_ONLY',drive:'F:',fileSystem:'NTFS',
 healthStatus:'Healthy',operationalStatus:'OK',totalBytes:1000000,availableBytes:500000,state:'HEALTHY',
 evidence:'WINDOWS_STORAGE_READ_ONLY',checkedAt:'2026-11-07T00:00:00.000Z'
});
async function setup(t,limits,storageProbe=healthyVolume){
 const h=harness(t,0),{p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);
 const run=h.store.run(created.id);run.mode='live';run.plan={...run.plan,dataRuntime:runtimePlan};seedOfflineSqliteReview(h.store,run);
 const fixture=join(h.dir,'controller-created-fixture.sqlite'),db=new DatabaseSync(fixture);
 db.exec('CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES (\'controller-created business fixture\')');db.close();
 return {h,p:project,s,run,image:readFileSync(fixture),data:new module.SqliteDatasets(h.store,root,h.dir,limits,storageProbe)};
}
function exchange(capture,image){
 const descriptor=sqliteInputDescriptor(capture.image,capture.binding),imageHash=hash(image);
 const result={schema:'dream-maker.wsl-result.v1',jobId:'wsl_job_offline_sqlite_data',sourceHash:capture.sourceHash,
  workerHash:hash(readFileSync(join(root,'scripts/isolation/wsl-worker.py'),'utf8')),environment:WSL_ENVIRONMENT,
  status:'EXECUTED',exitCode:0,stdout:'',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true},
  sqlite:{...descriptor,schema:'dream-maker.sqlite-execution.v1',snapshotHelperHash:hash(readFileSync(join(root,'scripts/isolation/sqlite-snapshot.py'),'utf8')),
   snapshotStatus:'READY',snapshot:{schema:'dream-maker.sqlite-snapshot.v1',bytes:image.length,sha256:imageHash,sqliteVersion:'3.45.1',integrity:'ok'},
   generatedPidsAfter:[],snapshotPidsAfter:[],privateMountNamespace:true,runTmpfsBytes:33554432,dataTmpfsBytes:218103808,mountsRemoved:true,inputReceived:true,
   retention:{schema:'dream-maker.sqlite-retention.v1',state:'RETAINED',bytes:image.length,manifestHash:'b'.repeat(64)}}};
 return {result,image,exchangeMetadata:{schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',...capture.binding,imageBytes:image.length,imageHash,result}};
}
async function leaveUnknownPublication(t){
 const fixture=await setup(t),capture=fixture.data.capture(fixture.run.id,fixture.run.treeHash,0,planHash),wire=exchange(capture,fixture.image),
  key=hash('offline-sqlite-unknown-recovery-'+crypto.randomUUID()),prepare=fixture.h.store.db.prepare.bind(fixture.h.store.db);
 fixture.h.store.db.prepare=sql=>{if(sql.startsWith('INSERT INTO managed_dataset_versions'))throw Error('OFFLINE_RECOVERY_COMMIT_FAILURE');return prepare(sql);};
 try{assert.throws(()=>fixture.data.publish(capture,wire,key,actor),/OFFLINE_RECOVERY_COMMIT_FAILURE/);}finally{fixture.h.store.db.prepare=prepare;}
 assert.equal(fixture.data.read(fixture.p.id).revision,0);
 assert.equal(fixture.h.store.db.prepare('SELECT count(*) n FROM business_image_intents WHERE operation_hash=?').get(key).n,1);
 assert.equal(fixture.h.store.db.prepare('SELECT count(*) n FROM business_image_intent_bindings WHERE operation_hash=?').get(key).n,1);
 return {...fixture,key,wire,scope:custodyScope(fixture.h,fixture.p,fixture.run)};
}
test('an exact Intent-bound image can be reconciled once through owned storage custody without rerunning work',async t=>{
 const x=await leaveUnknownPublication(t),recoveryActor='local-session:'+'b'.repeat(64);
 const recovered=await withProcessOwnership(x.scope,()=>x.data.recoverOwned(x.key,recoveryActor));
 assert.equal(recovered.revision,1);assert.equal(recovered.imageHash,hash(x.image));assert.equal(recovered.operation.replayed,false);
 assert.equal(processCleanupProven(x.scope),true);
 assert.equal(x.h.store.db.prepare("SELECT count(*) n FROM managed_dataset_versions WHERE project_id=? AND kind='SQLITE_IMAGE_V1'").get(x.p.id).n,1);
 assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM managed_dataset_operations WHERE operation_hash=?').get(x.key).n,1);
 const records=x.h.store.records(x.p.id,'SqliteDataIntentRecovered');assert.equal(records.length,1);assert.equal(records[0].data.operationHash,x.key);
 assert.equal(records[0].data.modelCalls,0);assert.equal(records[0].data.generatedWorkRerun,false);
 const replay=await withProcessOwnership(x.scope,()=>x.data.recoverOwned(x.key,recoveryActor));
 assert.equal(replay.revision,1);assert.equal(replay.operation.replayed,true);
 assert.equal(x.h.store.records(x.p.id,'SqliteDataIntentRecovered').length,1);
});

test('owned Intent recovery pins the prior head image before using it as the base version',async t=>{
 const {h,p,run,data,image}=await setup(t),recoveryActor='local-session:'+'c'.repeat(64);
 const firstCapture=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(firstCapture,exchange(firstCapture,image),hash('offline-sqlite-head-pin-first'),actor);
 const headRow=h.store.db.prepare("SELECT data_json FROM managed_dataset_versions WHERE project_id=? AND kind='SQLITE_IMAGE_V1' AND revision=1").get(p.id);
 const headReference=JSON.parse(String(headRow.data_json));
 const headPath=join(h.dir,'controller/sqlite-images',hash(p.id),headReference.operationHash+'.sqlite');
 const secondCapture=data.capture(run.id,run.treeHash,1,planHash),key=hash('offline-sqlite-head-pin-recovery-'+crypto.randomUUID()),prepare=h.store.db.prepare.bind(h.store.db);
 let injected=false;
 h.store.db.prepare=sql=>{if(!injected&&sql.startsWith('INSERT INTO managed_dataset_versions')){injected=true;throw Error('OFFLINE_HEAD_PIN_COMMIT_FAILURE');}return prepare(sql);};
 try{assert.throws(()=>data.publish(secondCapture,exchange(secondCapture,image),key,actor),/OFFLINE_HEAD_PIN_COMMIT_FAILURE/);}finally{h.store.db.prepare=prepare;}
 let writeDenied=false;
 const recovered=await withProcessOwnership(custodyScope(h,p,run),()=>data.recoverOwned(key,recoveryActor,{assertCurrent:()=>{
  if(writeDenied)return;
  try{writeFileSync(headPath,Buffer.alloc(image.length,0x5a),{flag:'r+'});}catch{writeDenied=true;}
 }}));
 assert.equal(writeDenied,true);
 assert.equal(recovered.revision,2);
 assert.equal(hash(readFileSync(headPath)),headReference.imageHash);
 assert.equal(processCleanupProven(custodyScope(h,p,run)),true);
});

test('missing partial or changed unknown images stay unresolved and never advance a version',async t=>{
 for(const fault of ['missing','partial','changed']){
  const x=await leaveUnknownPublication(t),folder=join(x.h.dir,'controller/sqlite-images',hash(x.p.id)),file=join(folder,x.key+'.sqlite'),bytes=readFileSync(file);
  if(fault==='missing')rmSync(file);
  else if(fault==='partial')writeFileSync(file,bytes.subarray(0,bytes.length-512));
  else{const changed=Buffer.from(bytes);changed[100]^=1;writeFileSync(file,changed);}
  await assert.rejects(withProcessOwnership(x.scope,()=>x.data.recoverOwned(x.key,'local-session:'+'b'.repeat(64))),{code:'SQLITE_DATA_INTENT_IMAGE_UNAVAILABLE'});
  assert.equal(x.data.read(x.p.id).revision,0);
  assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM business_image_intents WHERE operation_hash=?').get(x.key).n,1);
  assert.equal(x.h.store.db.prepare('SELECT count(*) n FROM managed_dataset_operations WHERE operation_hash=?').get(x.key).n,0);
  assert.equal(x.h.store.records(x.p.id,'SqliteDataIntentRecovered').length,0);
  assert.equal(processCleanupProven(x.scope),true);
 }
});

test('unknown-image recovery refuses source drift or a legacy Intent without copied helper/result bindings',async t=>{
 const drifted=await leaveUnknownPublication(t);writeFileSync(join(drifted.run.workspace,'changed-before-recovery.txt'),'OFFLINE source drift');
 await assert.rejects(withProcessOwnership(drifted.scope,()=>drifted.data.recoverOwned(drifted.key,'local-session:'+'b'.repeat(64))),{code:'SQLITE_DATA_SOURCE_CHANGED'});
 assert.equal(drifted.data.read(drifted.p.id).revision,0);assert.equal(processCleanupProven(drifted.scope),true);

 const legacy=await setup(t),legacyKey=hash('offline-legacy-intent-without-binding'),legacyImage=exchange(legacy.data.capture(legacy.run.id,legacy.run.treeHash,0,planHash),legacy.image).image;
 legacy.h.store.db.prepare('INSERT INTO business_image_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(
  legacyKey,legacy.p.id,legacy.run.id,legacy.run.treeHash,hash('legacy-input'),0,hash(legacyImage),legacyImage.length,actor,new Date().toISOString());
 const scope=custodyScope(legacy.h,legacy.p,legacy.run);
 await assert.rejects(withProcessOwnership(scope,()=>legacy.data.recoverOwned(legacyKey,'local-session:'+'b'.repeat(64))),{code:'SQLITE_DATA_INTENT_BINDING_REQUIRED'});
 assert.equal(legacy.data.read(legacy.p.id).revision,0);assert.equal(processCleanupProven(scope),true);
});
test('SQLite binary versions use the original Store, preserve prior bytes and keep business data out of journals',async t=>{
 const {h,p,s,run,data,image}=await setup(t),before=hash(h.store.spec(s.id)),approvals=hash(h.store.db.prepare('SELECT * FROM approvals').all());
 const capture=data.capture(run.id,run.treeHash,0,planHash),wire=exchange(capture,image),first=data.publish(capture,wire,hash('offline-sqlite-one'),actor);
 assert.equal(first.kind,'SQLITE_IMAGE_V1');assert.equal(first.revision,1);assert.equal(first.imageHash,hash(image));assert.equal(first.nativeExecutionGranted,false);
 const fresh=new module.SqliteDatasets(h.store,root,h.dir,{},healthyVolume),second=fresh.capture(run.id,run.treeHash,1,planHash);assert.deepEqual(second.image,image);
 assert.equal(h.store.db.prepare("SELECT count(*) n FROM managed_dataset_versions WHERE kind='SQLITE_IMAGE_V1'").get().n,1);
 assert.equal(hash(h.store.spec(s.id)),before);assert.equal(hash(h.store.db.prepare('SELECT * FROM approvals').all()),approvals);
 assert.doesNotMatch(JSON.stringify(h.store.records(p.id)),/controller-created business fixture|"type":"Buffer"/);
 assert.throws(()=>h.store.db.prepare("UPDATE managed_dataset_versions SET data_hash=? WHERE project_id=?").run('f'.repeat(64),p.id),/IMMUTABLE/);
});
test('SQLite CAS rejects late output and exact replay rechecks the source and immutable image',async t=>{
 const {h,p,run,data,image}=await setup(t),first=data.capture(run.id,run.treeHash,0,planHash),key=hash('offline-sqlite-replay');
 data.publish(first,exchange(first,image),key,actor);
 assert.equal(data.publish(first,exchange(first,image),key,actor).operation.replayed,true);
 assert.throws(()=>data.publish(first,exchange(first,image),hash('offline-sqlite-late'),actor),{code:'SQLITE_DATA_CONFLICT'});
 writeFileSync(join(run.workspace,'changed.txt'),'changed source');assert.throws(()=>data.publish(first,exchange(first,image),key,actor),{code:'SQLITE_DATA_SOURCE_CHANGED'});
 assert.equal(data.read(p.id).revision,1);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,1);
});
test('SQLite rejects mismatched bytes, input binding and helper before creating publication intents',async t=>{
 const {h,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),wire=exchange(capture,image);
 const corrupt=Buffer.from(image);corrupt[100]^=1;
 assert.throws(()=>data.publish(capture,{...wire,image:corrupt},hash('offline-sqlite-corrupt'),actor));
 const wrong={...wire,result:{...wire.result,sqlite:{...wire.result.sqlite,snapshotHelperHash:'f'.repeat(64)}}};
 assert.throws(()=>data.publish(capture,wrong,hash('offline-sqlite-helper'),actor));
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});
test('SQLite interrupted file publication is retained, bounded and never automatically replayed',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),key=hash('offline-sqlite-uncertain'),wire=exchange(capture,image);
 const exec=h.store.db.prepare.bind(h.store.db);let injected=false;
 h.store.db.prepare=function(sql){if(!injected&&sql.startsWith('INSERT INTO managed_dataset_versions')){injected=true;throw Error('OFFLINE_PUBLICATION_COMMIT_FAILURE');}return exec(sql);};
 try{assert.throws(()=>data.publish(capture,wire,key,actor),/OFFLINE_PUBLICATION_COMMIT_FAILURE/);}finally{h.store.db.prepare=exec;}
 assert.equal(data.read(p.id).revision,0);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,1);
 assert.throws(()=>data.publish(capture,wire,key,actor),{code:'SQLITE_DATA_RESULT_UNCERTAIN'});
 assert.equal(data.read(p.id).usage.pending,1);
 const files=readdirSync(join(h.dir,'controller/sqlite-images',hash(p.id)));assert.equal(files.length,1);assert.deepEqual(readFileSync(join(h.dir,'controller/sqlite-images',hash(p.id),files[0])),image);
});
test('SQLite history quota and binary corruption cannot replace an existing head',async t=>{
 const {h,p,run,data,image}=await setup(t,{versions:1}),capture=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(capture,exchange(capture,image),hash('offline-sqlite-limited'),actor);
 const next=data.capture(run.id,run.treeHash,1,planHash);assert.throws(()=>data.publish(next,exchange(next,image),hash('offline-sqlite-over-limit'),actor),{code:'SQLITE_DATA_VERSION_LIMIT'});
 const folder=join(h.dir,'controller/sqlite-images',hash(p.id)),file=join(folder,readdirSync(folder)[0]);writeFileSync(file,Buffer.from('truncated owned test image'));
 assert.throws(()=>data.capture(run.id,run.treeHash,1,planHash),{code:'SQLITE_DATA_IMAGE_CHANGED'});
 assert.equal(h.store.db.prepare("SELECT revision FROM managed_dataset_heads WHERE project_id=? AND kind='SQLITE_IMAGE_V1'").get(p.id).revision,1);
});

test('state backup cannot silently omit published SQLite image attachments',async t=>{
 const {h,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(capture,exchange(capture,image),hash('offline-sqlite-backup-scope'),actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false});
 assert.throws(()=>maintenance.create('sqlite-attachments-not-yet-connected'),{code:'MAINTENANCE_SQLITE_IMAGES_REQUIRED'});
 assert.equal(data.read(run.projectId).revision,1);
});

test('custodied state snapshots copy, anchor and rehearse immutable SQLite image bytes',async t=>{
 const {h,p,run,data,image}=await setup(t),key=hash('offline-sqlite-custodied-state-backup'),capture=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(capture,exchange(capture,image),key,actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false});
 const snapshot=await maintenance.createCustodied('OFFLINE_SQLITE_ATTACHMENT_SNAPSHOT');
 assert.equal(snapshot.schema,'dream-maker.state-snapshot.v2');
 assert.equal(snapshot.sqliteImages?.status,'CAPTURED');
 assert.equal(snapshot.sqliteImages?.files,1);
 assert.equal(snapshot.attachments?.length,1);
 const attachment=snapshot.attachments[0];
 assert.equal(attachment.operationHash,key);
 assert.equal(attachment.projectId,p.id);
 assert.equal(attachment.revision,1);
 assert.equal(attachment.sha256,hash(image));
 assert.equal(attachment.contentHash,data.read(p.id).contentHash);
 assert.deepEqual(readFileSync(join(h.dir,'controller/state-backups',snapshot.id,attachment.path)),image);
 assert.deepEqual(maintenance.verify(snapshot.id),snapshot);
 assert.ok(h.store.db.prepare('SELECT manifest_hash FROM state_snapshot_anchors WHERE snapshot_id=?').get(snapshot.id));
 const rehearsal=await maintenance.rehearseCustodied(snapshot.id,'OFFLINE_SQLITE_ATTACHMENT_REHEARSAL');
 assert.equal(rehearsal.snapshotId,snapshot.id);
 assert.deepEqual(readFileSync(join(h.dir,'controller/state-rehearsals',rehearsal.id,attachment.path)),image);
 writeFileSync(join(h.dir,'controller/state-backups',snapshot.id,attachment.path),Buffer.from('OFFLINE_CHANGED_ATTACHMENT'));
 assert.throws(()=>maintenance.verify(snapshot.id),{code:'MAINTENANCE_SNAPSHOT_CHANGED'});
 assert.equal(data.read(p.id).revision,1);
});

test('custodied rehearsal rechecks the source snapshot after every artifact has been copied',async t=>{
 const {h,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(capture,exchange(capture,image),hash('offline-sqlite-rehearse-source-recheck'),actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false}),snapshot=await maintenance.createCustodied('OFFLINE_SQLITE_REHEARSE_SOURCE_RECHECK');
 const original=fs.copyFileSync;let changed=false;
 fs.copyFileSync=(from,to,...args)=>{const result=original(from,to,...args);if(!changed&&basename(String(to))==='application.sqlite'){changed=true;writeFileSync(from,Buffer.from('OFFLINE_CHANGED_SOURCE_AFTER_COPY'));}return result;};syncBuiltinESMExports();
 try{await assert.rejects(maintenance.rehearseCustodied(snapshot.id,'OFFLINE_SQLITE_REHEARSE_SOURCE_RECHECK_CALL'),{code:'MAINTENANCE_SNAPSHOT_CHANGED'});}
 finally{fs.copyFileSync=original;syncBuiltinESMExports();}
 assert.equal(changed,true);assert.equal(data.read(run.projectId).revision,1);
});

test('custodied rehearsal rechecks copied destination artifacts before recording success',async t=>{
 const {h,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(capture,exchange(capture,image),hash('offline-sqlite-rehearse-destination-recheck'),actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false}),snapshot=await maintenance.createCustodied('OFFLINE_SQLITE_REHEARSE_DESTINATION_RECHECK');
 const original=fs.copyFileSync;let changed=false,rehearsalFolder='';
 fs.copyFileSync=(from,to,...args)=>{const result=original(from,to,...args);if(!rehearsalFolder&&basename(String(to))==='application.sqlite')rehearsalFolder=join(String(to),'..');if(!changed&&String(from).includes('sqlite-images')){changed=true;writeFileSync(join(rehearsalFolder,'application.sqlite'),Buffer.from('OFFLINE_CHANGED_DESTINATION_AFTER_COPY'));}return result;};syncBuiltinESMExports();
 try{await assert.rejects(maintenance.rehearseCustodied(snapshot.id,'OFFLINE_SQLITE_REHEARSE_DESTINATION_RECHECK_CALL'),{code:'MAINTENANCE_REHEARSAL_CHANGED'});}
 finally{fs.copyFileSync=original;syncBuiltinESMExports();}
 assert.equal(changed,true);assert.equal(data.read(run.projectId).revision,1);
});

test('state snapshot refuses an unresolved SQLite image Intent before creating an incomplete backup',async t=>{
 const {h,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),key=hash('offline-sqlite-state-pending-intent'),wire=exchange(capture,image),prepare=h.store.db.prepare.bind(h.store.db);
 h.store.db.prepare=sql=>{if(sql.startsWith('INSERT INTO managed_dataset_versions'))throw Error('OFFLINE_STATE_PENDING_INTENT');return prepare(sql);};
 try{assert.throws(()=>data.publish(capture,wire,key,actor),/OFFLINE_STATE_PENDING_INTENT/);}finally{h.store.db.prepare=prepare;}
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false});
 await assert.rejects(maintenance.createCustodied('OFFLINE_SQLITE_PENDING_ATTACHMENT'),{code:'MAINTENANCE_SQLITE_OPERATION_UNCERTAIN'});
 assert.equal(existsSync(join(h.dir,'controller/state-backups')),false);
});

test('SQLite replay rechecks approval after acquiring the original Store transaction',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),wire=exchange(capture,image),key=hash('offline-sqlite-replay-revoke');
 data.publish(capture,wire,key,actor);const tx=h.store.tx.bind(h.store);
 h.store.tx=fn=>tx(()=>{h.store.db.prepare("DELETE FROM approvals WHERE project_id=? AND kind='BUILD'").run(p.id);return fn();});
 try{assert.throws(()=>data.publish(capture,wire,key,actor),{code:'SQLITE_DATA_SOURCE_UNVERIFIED'});}finally{h.store.tx=tx;}
 assert.equal(data.read(p.id).revision,1);
});

test('SQLite final CAS rechecks both input and output files after acquiring its transaction',async t=>{
 for(const changed of ['input','output']){
  const {h,p,run,data,image}=await setup(t),first=data.capture(run.id,run.treeHash,0,planHash);
  data.publish(first,exchange(first,image),hash('offline-sqlite-original-'+changed),actor);
  const capture=data.capture(run.id,run.treeHash,1,planHash),wire=exchange(capture,image),key=hash('offline-sqlite-final-'+changed),tx=h.store.tx.bind(h.store);let count=0;
  h.store.tx=fn=>tx(()=>{if(++count===2){const name=(changed==='input'?hash('offline-sqlite-original-'+changed):key)+'.sqlite';writeFileSync(join(h.dir,'controller/sqlite-images',hash(p.id),name),Buffer.from('changed controlled fixture'));}return fn();});
  try{assert.throws(()=>data.publish(capture,wire,key,actor),{code:'SQLITE_DATA_IMAGE_CHANGED'});}finally{h.store.tx=tx;}
  assert.equal(h.store.db.prepare("SELECT revision FROM managed_dataset_heads WHERE project_id=? AND kind='SQLITE_IMAGE_V1'").get(p.id).revision,1);
 }
});

test('owned publication pins original input, new image and parents through the original Store commit and replay',async t=>{
 const {h,p,run,data,image}=await setup(t),first=data.capture(run.id,run.treeHash,0,planHash),firstKey=hash('offline-owned-original');
 data.publish(first,exchange(first,image),firstKey,actor);const capture=data.capture(run.id,run.treeHash,1,planHash),key=hash('offline-owned-next'),scope=custodyScope(h,p,run),tx=h.store.tx.bind(h.store),folder=join(h.dir,'controller/sqlite-images',hash(p.id));let transactions=0,pinned=false;
 h.store.tx=fn=>tx(()=>{if(++transactions===2){assert.throws(()=>renameSync(folder,folder+'-moved'));for(const operation of [firstKey,key])assert.throws(()=>writeFileSync(join(folder,operation+'.sqlite'),Buffer.from('MUST_NOT_WRITE')));pinned=true;}return fn();});
 let result;try{result=await withProcessOwnership(scope,()=>data.publishOwned(capture,exchange(capture,image),key,actor));}finally{h.store.tx=tx;}
 assert.equal(pinned,true);assert.equal(result.revision,2);assert.equal(result.operation.replayed,false);assert.equal(processCleanupProven(scope),true);
 const replay=await withProcessOwnership(scope,()=>data.publishOwned(capture,exchange(capture,image),key,actor));assert.equal(replay.operation.replayed,true);assert.equal(replay.revision,2);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM managed_dataset_operations').get().n,2);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,2);
 renameSync(folder,folder+'-released');renameSync(folder+'-released',folder);assert.deepEqual(readFileSync(join(folder,key+'.sqlite')),image);
});

for(const [state,code] of [['REPAIR_REQUIRED','STORAGE_VOLUME_REPAIR_REQUIRED'],['UNKNOWN','STORAGE_VOLUME_HEALTH_UNKNOWN']]){
 test('durable SQLite publication refuses '+state+' volume state before business Intent or custody',async t=>{
  let probes=0;
  const rejectedVolume=async()=>{probes++;return {
   schema:'dream-maker.storage-volume-health.v1',scope:'VOLUME_HEALTH_ONLY',drive:'F:',
   fileSystem:state==='UNKNOWN'?null:'exFAT',healthStatus:state==='UNKNOWN'?null:'Warning',
   operationalStatus:state==='UNKNOWN'?null:'Full Repair Needed',totalBytes:state==='UNKNOWN'?null:1000000,
   availableBytes:state==='UNKNOWN'?null:500000,state,evidence:state==='UNKNOWN'?'PROBE_UNAVAILABLE':'WINDOWS_STORAGE_READ_ONLY',
   checkedAt:'2026-11-07T00:00:00.000Z'
  };};
  const {h,p,run,data,image}=await setup(t,undefined,rejectedVolume),capture=data.capture(run.id,run.treeHash,0,planHash),scope=custodyScope(h,p,run),ownedBefore=h.store.records(p.id,'OwnedProcessIntent').length;
  await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,exchange(capture,image),hash('offline-volume-'+state),actor)),{code});
  assert.equal(probes,1);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
  assert.equal(h.store.records(p.id,'OwnedProcessIntent').length,ownedBefore);
 });
}

test('owned read status does not consult durable-write volume health',async t=>{
 const {h,p,run}=await setup(t,undefined,async()=>{throw Error('VOLUME_PROBE_MUST_NOT_RUN_FOR_READ');}),data=h.engine.sqliteData,scope=custodyScope(h,p,run);
 const view=await withProcessOwnership(scope,()=>data.readOwned(p.id));assert.equal(view.revision,0);assert.equal(processCleanupProven(scope),true);
});

test('owned publication isolates caller buffers and bindings before the first owned-process await',async t=>{
 let mutated=false,capture,wire;
 const {h,p,run,data,image}=await setup(t,undefined,async()=>{
  mutated=true;wire.image.fill(0);wire.result.sourceHash='f'.repeat(64);wire.exchangeMetadata.imageHash='e'.repeat(64);
  capture.planHash='d'.repeat(64);capture.binding.inputHash='c'.repeat(64);return healthyVolume();
 });
 capture=data.capture(run.id,run.treeHash,0,planHash);wire=exchange(capture,Buffer.from(image));
 const scope=custodyScope(h,p,run),key=hash('offline-owned-alias');
 const result=await withProcessOwnership(scope,()=>data.publishOwned(capture,wire,key,actor));assert.equal(mutated,true);assert.equal(result.imageHash,hash(image));assert.equal(result.revision,1);assert.equal(processCleanupProven(scope),true);
});

test('owned publication snapshots caller input and output before the durable-volume probe await',async t=>{
 let enterProbe,releaseProbe;const probeEntered=new Promise(resolve=>enterProbe=resolve),probeRelease=new Promise(resolve=>releaseProbe=resolve);
 const {h,p,run,data,image}=await setup(t,undefined,async()=>{enterProbe();await probeRelease;return healthyVolume();});
 const capture=data.capture(run.id,run.treeHash,0,planHash),wire=exchange(capture,Buffer.from(image)),scope=custodyScope(h,p,run),key=hash('offline-owned-pre-await-alias');
 const pending=withProcessOwnership(scope,()=>data.publishOwned(capture,wire,key,actor));
 await probeEntered;
 wire.image.fill(0);wire.result.sourceHash='f'.repeat(64);wire.exchangeMetadata.imageHash='e'.repeat(64);
 capture.planHash='d'.repeat(64);capture.binding.inputHash='c'.repeat(64);
 releaseProbe();
 const result=await pending;
 assert.equal(result.imageHash,hash(image));assert.equal(result.revision,1);assert.equal(processCleanupProven(scope),true);
});

test('owned publication cancellation after durable Intent leaves an uncertain operation without writing or automatic replay',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),wire=exchange(capture,image),scope=custodyScope(h,p,run),abort=new AbortController(),key=hash('offline-owned-cancel'),tx=h.store.tx.bind(h.store);let count=0;
 h.store.tx=fn=>{const value=tx(fn);if(++count===1)abort.abort();return value;};
 try{await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,wire,key,actor,{signal:abort.signal})),{code:'RUN_CANCELLED'});}finally{h.store.tx=tx;}
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,1);assert.equal(data.read(p.id).revision,0);assert.equal(existsSync(join(h.dir,'controller/sqlite-images',hash(p.id),key+'.sqlite')),false);
 await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,wire,key,actor)),{code:'SQLITE_DATA_RESULT_UNCERTAIN'});assert.equal(processCleanupProven(scope),true);
});

test('owned publication rechecks revoked approval after keeper startup before recording Intent',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),scope=custodyScope(h,p,run),record=h.store.record.bind(h.store);let revoked=false;
 t.mock.method(h.store,'record',(...args)=>{const row=record(...args);if(!revoked&&args[0]==='OwnedProcessIntent'){revoked=true;h.store.db.prepare("DELETE FROM approvals WHERE project_id=? AND kind='BUILD'").run(p.id);}return row;});
 await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,exchange(capture,image),hash('offline-owned-revoke'),actor)),{code:'SQLITE_DATA_SOURCE_UNVERIFIED'});
 assert.equal(revoked,true);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);assert.equal(processCleanupProven(scope),true);
});

test('owned publication commit failure preserves output and Intent without advancing a version or redoing the write',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),scope=custodyScope(h,p,run),wire=exchange(capture,image),key=hash('offline-owned-commit-failure'),prepare=h.store.db.prepare.bind(h.store.db);
 h.store.db.prepare=sql=>{if(sql.startsWith('INSERT INTO managed_dataset_versions'))throw Error('OFFLINE_OWNED_COMMIT_FAILURE');return prepare(sql);};
 try{await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,wire,key,actor)),/OFFLINE_OWNED_COMMIT_FAILURE/);}finally{h.store.db.prepare=prepare;}
 assert.equal(data.read(p.id).revision,0);assert.equal(data.read(p.id).usage.pending,1);assert.deepEqual(readFileSync(join(h.dir,'controller/sqlite-images',hash(p.id),key+'.sqlite')),image);
 await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,wire,key,actor)),{code:'SQLITE_DATA_RESULT_UNCERTAIN'});assert.equal(processCleanupProven(scope),true);
});

test('owned publication requires matching ownership and rejects cancellation without a new process or Intent',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),scope=custodyScope(h,p,run),wire=exchange(capture,image),key=hash('offline-owned-denied'),before=h.store.records(p.id,'OwnedProcessIntent').length,abort=new AbortController();abort.abort();
 await assert.rejects(data.publishOwned(capture,wire,key,actor),{code:'STORAGE_CUSTODY_OWNERSHIP_REQUIRED'});
 await assert.rejects(withProcessOwnership({...scope,runId:'OFFLINE_OTHER_RUN'},()=>data.publishOwned(capture,wire,key,actor)),{code:'SQLITE_DATA_CUSTODY_BINDING_REQUIRED'});
 await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,wire,key,actor,{signal:abort.signal})),{code:'RUN_CANCELLED'});
 assert.equal(h.store.records(p.id,'OwnedProcessIntent').length,before);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});

test('owned publication refuses unknown pool entries before Intent instead of skipping quota inspection',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),scope=custodyScope(h,p,run);mkdirSync(join(h.dir,'controller/sqlite-images/unknown-entry'),{recursive:true});
 await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,exchange(capture,image),hash('offline-owned-unknown-storage'),actor)),{code:'SQLITE_DATA_STORAGE_UNKNOWN'});
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);assert.equal(processCleanupProven(scope),true);
});

test('legacy replay still rechecks a historical image after the reservation transaction returns',async t=>{
 const {h,p,run,data,image}=await setup(t),first=data.capture(run.id,run.treeHash,0,planHash),key=hash('offline-historical-replay');data.publish(first,exchange(first,image),key,actor);
 const next=data.capture(run.id,run.treeHash,1,planHash);data.publish(next,exchange(next,image),hash('offline-historical-latest'),actor);
 const tx=h.store.tx.bind(h.store);let changed=false;h.store.tx=fn=>{const value=tx(fn);if(!changed){changed=true;writeFileSync(join(h.dir,'controller/sqlite-images',hash(p.id),key+'.sqlite'),Buffer.from('CORRUPTED_OLD_IMAGE_AFTER_TRANSACTION'));}return value;};
 try{assert.throws(()=>data.publish(first,exchange(first,image),key,actor),{code:'SQLITE_DATA_IMAGE_CHANGED'});}finally{h.store.tx=tx;}
 assert.equal(changed,true);assert.equal(data.read(p.id).revision,2);
});

test('owned publication enforces the binary size bound before copying either caller buffer',async t=>{
 const {h,p,run,data,image}=await setup(t),scope=custodyScope(h,p,run),oversize=Buffer.alloc(67108864+512),from=Buffer.from,before=h.store.records(p.id,'OwnedProcessIntent').length;let largeCopies=0;
 t.mock.method(Buffer,'from',function(value,...args){if(value===oversize){largeCopies++;throw Error('OFFLINE_ILLEGAL_LARGE_BUFFER_COPY');}return Reflect.apply(from,Buffer,[value,...args]);});
 for(const target of ['input','output']){const capture=data.capture(run.id,run.treeHash,0,planHash),wire=exchange(capture,image);if(target==='input')capture.image=oversize;else wire.image=oversize;
  await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,wire,hash('offline-oversize-'+target),actor)),{code:'SQLITE_IMAGE_HEADER_INVALID'});
 }
 assert.equal(largeCopies,0);assert.equal(h.store.records(p.id,'OwnedProcessIntent').length,before);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});

test('owned publication validates the frozen output header before Intent even if the caller changes during copy',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),wire=exchange(capture,Buffer.from(image)),scope=custodyScope(h,p,run),invalid=Buffer.from(image),from=Buffer.from,before=h.store.records(p.id,'OwnedProcessIntent').length;invalid[0]^=1;
 wire.result.sqlite.snapshot.sha256=hash(invalid);wire.exchangeMetadata.imageHash=hash(invalid);let changed=false;
 t.mock.method(Buffer,'from',function(value,...args){if(value===wire.image&&!changed){changed=true;invalid.copy(value);}return Reflect.apply(from,Buffer,[value,...args]);});
 await assert.rejects(withProcessOwnership(scope,()=>data.publishOwned(capture,wire,hash('offline-frozen-invalid-header'),actor)),{code:'SQLITE_IMAGE_HEADER_INVALID'});
 assert.equal(changed,true);assert.equal(h.store.records(p.id,'OwnedProcessIntent').length,before);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});

test('owned read view returns only committed metadata through actual keeper cleanup, including empty and pending data',async t=>{
 const {h,p,run,data,image}=await setup(t),scope=custodyScope(h,p,run),before=hash(h.store.run(run.id));
 const empty=await withProcessOwnership(scope,()=>data.readOwned(p.id));assert.equal(empty.revision,0);assert.equal(empty.nativeExecutionGranted,false);
 const capture=data.capture(run.id,run.treeHash,0,planHash);data.publish(capture,exchange(capture,image),hash('offline-read-view-one'),actor);
 const saved=await withProcessOwnership(scope,()=>data.readOwned(p.id));assert.equal(saved.revision,1);assert.equal(saved.imageHash,hash(image));assert.equal(saved.nativeExecutionGranted,false);assert.doesNotMatch(JSON.stringify(saved),/controller-created business fixture|"type":"Buffer"|[a-f0-9]{64}\.sqlite|[Ff]:[\\/]/);
 const next=data.capture(run.id,run.treeHash,1,planHash),pendingKey=hash('offline-read-view-pending'),prepare=h.store.db.prepare.bind(h.store.db);
 h.store.db.prepare=sql=>{if(sql.startsWith('INSERT INTO managed_dataset_versions'))throw Error('OFFLINE_READ_PENDING_INTENT');return prepare(sql);};
 try{assert.throws(()=>data.publish(next,exchange(next,image),pendingKey,actor),/OFFLINE_READ_PENDING_INTENT/);}finally{h.store.db.prepare=prepare;}
 writeFileSync(join(h.dir,'controller/sqlite-images',hash(p.id),pendingKey+'.sqlite'),Buffer.from('torn unpublished fixture'));
 const pending=await withProcessOwnership(scope,()=>data.readOwned(p.id));assert.equal(pending.revision,1);assert.equal(pending.imageHash,saved.imageHash);assert.equal(pending.usage.pending,1);
 assert.equal(hash(h.store.run(run.id)),before);assert.equal(processCleanupProven(scope),true);
});

test('owned read view rejects wrong ownership or cancellation before creating any new process',async t=>{
 const {h,p,run,data}=await setup(t),scope=custodyScope(h,p,run),abort=new AbortController(),before=h.store.records(p.id,'OwnedProcessIntent').length;abort.abort();
 await assert.rejects(data.readOwned(p.id),{code:'STORAGE_CUSTODY_OWNERSHIP_REQUIRED'});
 await assert.rejects(withProcessOwnership({...scope,projectId:'OFFLINE_OTHER'},()=>data.readOwned(p.id)),{code:'SQLITE_DATA_CUSTODY_BINDING_REQUIRED'});
 await assert.rejects(withProcessOwnership(scope,()=>data.readOwned(p.id,{signal:abort.signal})),{code:'RUN_CANCELLED'});
 assert.equal(h.store.records(p.id,'OwnedProcessIntent').length,before);
});

test('owned read view refuses changed active project or head while the keeper starts and proves close',async t=>{
 for(const drift of ['project','run','head']){const {h,p,run,data,image}=await setup(t),scope=custodyScope(h,p,run),record=h.store.record.bind(h.store);let changed=false;
  const undo=t.mock.method(h.store,'record',(...args)=>{const row=record(...args);if(!changed&&args[0]==='OwnedProcessIntent'){changed=true;if(drift==='project'){const next=h.store.project(p.id);next.name+=' edited';h.store.saveProject(next);}else if(drift==='run'){const next=h.store.run(run.id);next.reason='OFFLINE_READ_EDIT';h.store.saveRun(next);}else{const capture=data.capture(run.id,run.treeHash,0,planHash);data.publish(capture,exchange(capture,image),hash('offline-read-drift'),actor);}}return row;});
  await assert.rejects(withProcessOwnership(scope,()=>data.readOwned(p.id)),{code:drift==='head'?'SQLITE_DATA_CONFLICT':'SQLITE_DATA_READ_CHANGED'});undo.mock.restore();assert.equal(changed,true);assert.equal(processCleanupProven(scope),true);
 }
});

test('owned read view leaves opaque payload validation in the owned keeper without reading it again on the Node host',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash),scope=custodyScope(h,p,run);data.publish(capture,exchange(capture,image),hash('offline-keeper-only-image-read'),actor);
 t.mock.method(data,'image',()=>{throw Error('OFFLINE_NODE_IMAGE_READ_FORBIDDEN_FOR_STATUS');});
 const status=await withProcessOwnership(scope,()=>data.readOwned(p.id));assert.equal(status.revision,1);assert.equal(status.imageHash,hash(image));assert.equal(processCleanupProven(scope),true);
});

test('verified SQLite rehearsal restores an exact image as a new immutable version and replays idempotently',async t=>{
 const {h,p,run,data,image}=await setup(t),firstKey=hash('offline-sqlite-restore-source'),first=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(first,exchange(first,image),firstKey,actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false});
 const snapshot=await maintenance.createCustodied('OFFLINE_SQLITE_RESTORE_SNAPSHOT'),rehearsal=await maintenance.rehearseCustodied(snapshot.id,'OFFLINE_SQLITE_RESTORE_REHEARSAL');
 const secondKey=hash('offline-sqlite-restore-current'),second=data.capture(run.id,run.treeHash,1,planHash);
 data.publish(second,exchange(second,image),secondKey,actor);
 const operation=hash('offline-sqlite-restore-operation'),source=()=>maintenance.sqliteDataSource(snapshot.id,rehearsal.id,p.id);
 const restored=await data.restoreFromRehearsal(p.id,2,source,operation,actor);
 assert.equal(restored.revision,3);assert.equal(restored.operation.replayed,false);assert.equal(restored.imageHash,hash(image));
 const row=h.store.db.prepare("SELECT * FROM managed_dataset_versions WHERE project_id=? AND kind='SQLITE_IMAGE_V1' AND revision=3").get(p.id);
 assert.equal(row.origin,'RESTORE');assert.equal(row.source_snapshot_id,snapshot.id);assert.equal(row.data_hash,hash(image));assert.equal(readFileSync(join(h.dir,'controller/sqlite-images',hash(p.id),operation+'.sqlite')).length,image.length);
 const replay=await data.restoreFromRehearsal(p.id,2,source,operation,actor);
 assert.equal(replay.revision,3);assert.equal(replay.operation.replayed,true);
 assert.equal(h.store.db.prepare("SELECT count(*) n FROM managed_dataset_versions WHERE project_id=? AND kind='SQLITE_IMAGE_V1'").get(p.id).n,3);
});

test('SQLite restore refuses a changed input under an existing operation key without writing a version',async t=>{
 const {h,p,run,data,image}=await setup(t),firstKey=hash('offline-sqlite-restore-conflict-source'),first=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(first,exchange(first,image),firstKey,actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false});
 const snapshot=await maintenance.createCustodied('OFFLINE_SQLITE_RESTORE_CONFLICT_SNAPSHOT'),rehearsal=await maintenance.rehearseCustodied(snapshot.id,'OFFLINE_SQLITE_RESTORE_CONFLICT_REHEARSAL');
 const secondKey=hash('offline-sqlite-restore-conflict-current'),second=data.capture(run.id,run.treeHash,1,planHash);
 data.publish(second,exchange(second,image),secondKey,actor);
 const operation=hash('offline-sqlite-restore-conflict-operation'),source=()=>maintenance.sqliteDataSource(snapshot.id,rehearsal.id,p.id);
 await data.restoreFromRehearsal(p.id,2,source,operation,actor);
 await assert.rejects(data.restoreFromRehearsal(p.id,1,source,operation,actor),{code:'SQLITE_DATA_IDEMPOTENCY_CONFLICT'});
 assert.equal(data.read(p.id).revision,3);
 assert.equal(h.store.db.prepare("SELECT count(*) n FROM managed_dataset_versions WHERE project_id=? AND kind='SQLITE_IMAGE_V1'").get(p.id).n,3);
});

test('SQLite restore refuses a changed rehearsal image before creating a target version',async t=>{
 const {h,p,run,data,image}=await setup(t),capture=data.capture(run.id,run.treeHash,0,planHash);
 data.publish(capture,exchange(capture,image),hash('offline-sqlite-restore-tamper-source'),actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false});
 const snapshot=await maintenance.createCustodied('OFFLINE_SQLITE_RESTORE_TAMPER_SNAPSHOT'),rehearsal=await maintenance.rehearseCustodied(snapshot.id,'OFFLINE_SQLITE_RESTORE_TAMPER_REHEARSAL'),attachment=snapshot.attachments[0];
 writeFileSync(join(h.dir,'controller/state-rehearsals',rehearsal.id,attachment.path),Buffer.from('OFFLINE_CHANGED_REHEARSAL_IMAGE'));
 await assert.rejects(data.restoreFromRehearsal(p.id,1,()=>maintenance.sqliteDataSource(snapshot.id,rehearsal.id,p.id),hash('offline-sqlite-restore-tamper'),actor),{code:'MAINTENANCE_REHEARSAL_CHANGED'});
 assert.equal(data.read(p.id).revision,1);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,1);
});

test('SQLite restore checks durable volume health before reading the rehearsal or creating a target Intent',async t=>{
 let probes=0,sourceReads=0;
 const rejectedVolume=async()=>{probes++;return {schema:'dream-maker.storage-volume-health.v1',scope:'VOLUME_HEALTH_ONLY',drive:'F:',fileSystem:'exFAT',healthStatus:'Warning',operationalStatus:'Full Repair Needed',totalBytes:1000000,availableBytes:500000,state:'REPAIR_REQUIRED',evidence:'WINDOWS_STORAGE_READ_ONLY',checkedAt:'2026-11-07T00:00:00.000Z'};};
 const {h,p,data}=await setup(t,undefined,rejectedVolume);
 await assert.rejects(data.restoreFromRehearsal(p.id,0,()=>{sourceReads++;return null;},hash('offline-sqlite-restore-health'),actor),{code:'STORAGE_VOLUME_REPAIR_REQUIRED'});
 assert.equal(probes,1);assert.equal(sourceReads,0);assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_image_intents').get().n,0);
});
