// OFFLINE_TEST: real Windows file custody and original Store, no product roles or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as sqliteModule from '../../dist/server/sqlite-data.js';
import {sqliteInputDescriptor} from '../../dist/server/sqlite-channel.js';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {RegisteredProjectBackups} from '../../dist/server/registered-backups.js';
import {hash} from '../../dist/server/security.js';
import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
import {harness,ready,root} from '../helpers.mjs';
import {seedOfflineSqliteReview} from '../fixtures/sqlite-review.mjs';

const actor='local-session:'+'a'.repeat(64),planHash=hash('OFFLINE_REGISTERED_SQLITE_PLAN');
const runtimePlan={schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:'python',entry:'data.py',args:[]};

function exchange(capture,image){
 const descriptor=sqliteInputDescriptor(capture.image,capture.binding),imageHash=hash(image);
 const result={schema:'dream-maker.wsl-result.v1',jobId:'wsl_job_offline_registered_sqlite',sourceHash:capture.sourceHash,
  workerHash:hash(readFileSync(join(root,'scripts/isolation/wsl-worker.py'),'utf8')),environment:WSL_ENVIRONMENT,
  status:'EXECUTED',exitCode:0,stdout:'',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true},
  sqlite:{...descriptor,schema:'dream-maker.sqlite-execution.v1',snapshotHelperHash:hash(readFileSync(join(root,'scripts/isolation/sqlite-snapshot.py'),'utf8')),
   snapshotStatus:'READY',snapshot:{schema:'dream-maker.sqlite-snapshot.v1',bytes:image.length,sha256:imageHash,sqliteVersion:'3.45.1',integrity:'ok'},
   generatedPidsAfter:[],snapshotPidsAfter:[],privateMountNamespace:true,runTmpfsBytes:33554432,dataTmpfsBytes:218103808,mountsRemoved:true,inputReceived:true,
   retention:{schema:'dream-maker.sqlite-retention.v1',state:'RETAINED',bytes:image.length,manifestHash:'b'.repeat(64)}}};
 return {result,image,exchangeMetadata:{schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',...capture.binding,imageBytes:image.length,imageHash,result}};
}

async function setup(t){
 const h=harness(t,0),{p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);
 const project=h.store.project(p.id);project.mode='live';h.store.saveProject(project);
 const run=h.store.run(created.id);run.mode='live';run.plan={...run.plan,dataRuntime:runtimePlan};seedOfflineSqliteReview(h.store,run);
 const fixture=join(h.dir,'registered-controller-created-fixture.sqlite'),db=new DatabaseSync(fixture);
 db.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES ('registered custody fixture')");db.close();
 const image=readFileSync(fixture),data=new sqliteModule.SqliteDatasets(h.store,root,h.dir),
  capture=data.capture(run.id,run.treeHash,0,planHash),operation=hash('OFFLINE_REGISTERED_SQLITE_IMAGE');
 data.publish(capture,exchange(capture,image),operation,actor);
 const maintenance=new StateMaintenance({store:h.store,data:h.dir,root,isBusy:()=>false}),
  backups=new RegisteredProjectBackups({store:h.store,data:h.dir,root,maintenance,isBusy:()=>false});
 return {h,p,run,image,operation,data,maintenance,backups};
}

test('registered backup archives and extracts published SQLite images under owned Windows custody',async t=>{
 const {h,run,image,operation,data,backups}=await setup(t);
 const backup=await backups.createCustodied('OFFLINE_REGISTERED_SQLITE_CREATE');
 assert.equal(backup.state.sqliteImages?.status,'CAPTURED');
 assert.equal(backup.state.sqliteImages?.files,1);
 const attachment=backup.files.find(file=>file.path===`sqlite-images/${operation}.sqlite`);
 assert.ok(attachment);
 assert.equal(attachment.bytes,image.length);
 assert.equal(attachment.sha256,hash(image));
 assert.deepEqual(readFileSync(join(h.dir,'controller/registered-backups',backup.id,attachment.path)),image);

 const extracted=await backups.extractCustodied(backup.id,'OFFLINE_REGISTERED_SQLITE_EXTRACT');
 assert.equal(extracted.workingDataReplaced,false);
 assert.equal(extracted.executionGranted,false);
 assert.deepEqual(readFileSync(join(extracted.directory,attachment.path)),image);
 assert.equal(data.read(run.projectId).revision,1);
 assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');
});

test('registered backup refuses a changed SQLite attachment before extraction',async t=>{
 const {h,operation,backups}=await setup(t);
 const backup=await backups.createCustodied('OFFLINE_REGISTERED_SQLITE_TAMPER');
 writeFileSync(join(h.dir,'controller/registered-backups',backup.id,'sqlite-images',operation+'.sqlite'),Buffer.from('CHANGED_REGISTERED_ATTACHMENT'));
 await assert.rejects(backups.extractCustodied(backup.id,'OFFLINE_REGISTERED_SQLITE_CHANGED'),{code:'REGISTERED_BACKUP_FILE_CHANGED'});
 assert.equal(existsSync(join(h.dir,'controller/registered-extractions')),false);
});
