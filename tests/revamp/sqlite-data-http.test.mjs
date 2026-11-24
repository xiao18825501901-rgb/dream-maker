// Actual authenticated localhost requests and original Store; model and Native roles are forbidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {sqliteInputDescriptor} from '../../dist/server/sqlite-channel.js';
import {hash} from '../../dist/server/security.js';
import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
import {ready,root} from '../helpers.mjs';
import {seedOfflineSqliteReview} from '../fixtures/sqlite-review.mjs';

const runtimePlan={schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:'python',entry:'data.py',args:[]},planHash=hash(runtimePlan);
const healthyVolume=async()=>({
 schema:'dream-maker.storage-volume-health.v1',scope:'VOLUME_HEALTH_ONLY',drive:'F:',fileSystem:'NTFS',
 healthStatus:'Healthy',operationalStatus:'OK',totalBytes:1000000,availableBytes:500000,state:'HEALTHY',
 evidence:'WINDOWS_STORAGE_READ_ONLY',checkedAt:'2026-11-07T00:00:00.000Z'
});

function exchange(capture,image){
 const descriptor=sqliteInputDescriptor(capture.image,capture.binding),imageHash=hash(image);
 const result={schema:'dream-maker.wsl-result.v1',jobId:'wsl_job_offline_sqlite_http',sourceHash:capture.sourceHash,
  workerHash:hash(readFileSync(join(root,'scripts/isolation/wsl-worker.py'),'utf8')),environment:WSL_ENVIRONMENT,
  status:'EXECUTED',exitCode:0,stdout:'',stderr:'',cleanup:{remainingPids:[],groupRemoved:true,delegationRestored:true,sourceUnchanged:true},
  sqlite:{...descriptor,schema:'dream-maker.sqlite-execution.v1',snapshotHelperHash:hash(readFileSync(join(root,'scripts/isolation/sqlite-snapshot.py'),'utf8')),
   snapshotStatus:'READY',snapshot:{schema:'dream-maker.sqlite-snapshot.v1',bytes:image.length,sha256:imageHash,sqliteVersion:'3.45.1',integrity:'ok'},
   generatedPidsAfter:[],snapshotPidsAfter:[],privateMountNamespace:true,runTmpfsBytes:33554432,dataTmpfsBytes:218103808,mountsRemoved:true,inputReceived:true,
   retention:{schema:'dream-maker.sqlite-retention.v1',state:'RETAINED',bytes:image.length,manifestHash:'b'.repeat(64)}}};
 return {result,image,exchangeMetadata:{schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',...capture.binding,imageBytes:image.length,imageHash,result}};
}

async function setup(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'sqlite-http-'));
 const denied=()=>{throw Error('NO_NATIVE_ROLES_IN_SQLITE_HTTP_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const {p,s}=await ready({interviews:app.interviews,store:app.store}),created=app.engine.create(p.id,s.hash,true);await app.engine.settled(created.id);
 const project=app.store.project(p.id);project.mode='live';app.store.saveProject(project);
 const run=app.store.run(created.id);run.mode='live';run.plan={...run.plan,dataRuntime:runtimePlan};seedOfflineSqliteReview(app.store,run);
 app.engine.sqliteData.storageProbe=healthyVolume;
 const fixture=join(data,'controller-created-http-fixture.sqlite'),db=new DatabaseSync(fixture);
 db.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES ('controller-created HTTP fixture')");db.close();
 const image=readFileSync(fixture),first=app.engine.sqliteData.capture(run.id,run.treeHash,0,planHash);
 app.engine.sqliteData.publish(first,exchange(first,image),hash('offline-sqlite-http-first'),'local-session:'+'a'.repeat(64));
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,headers={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 return {app,data,p,run,image,call};
}

test('SQLite HTTP restore is authenticated, confirmed, same-project and idempotent',async t=>{
 const {app,data,p,run,image,call}=await setup(t);
 const snapshot=(await call('/maintenance/snapshots',{confirmed:true})).body;
 const rehearsal=(await call('/maintenance/snapshots/'+snapshot.id+'/rehearse',{confirmed:true})).body;
 const second=app.engine.sqliteData.capture(run.id,run.treeHash,1,planHash);
 app.engine.sqliteData.publish(second,exchange(second,image),hash('offline-sqlite-http-second'),'local-session:'+'a'.repeat(64));
 const planPath='/maintenance/snapshots/'+snapshot.id+'/rehearsals/'+rehearsal.id+'/projects/'+p.id+'/sqlite-data';
 const plan=await call(planPath);assert.equal(plan.status,200,JSON.stringify(plan.body));assert.equal(plan.body.scope,'PROJECT_SQLITE_DATA_ONLY');assert.equal(plan.body.engineStarted,false);
 assert.equal(plan.body.source.revision,1);assert.equal(plan.body.target.revision,2);assert.equal(plan.body.source.imageHash,hash(image));
 assert.equal(app.store.records(p.id,'SqliteDataReadRequested').length,0);
 const restorePath='/projects/'+p.id+'/sqlite-data/restore',input={snapshotId:snapshot.id,rehearsalId:rehearsal.id,expectedRevision:2,confirmed:true},key=crypto.randomUUID();
 assert.equal((await call(restorePath,{...input,confirmed:false},{'idempotency-key':key})).status,403);
 assert.equal((await call(restorePath,{...input,path:'C:/outside'},{'idempotency-key':key})).status,400);
 assert.equal((await fetch(app.origin+'/api'+restorePath,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,401);
 const restored=await call(restorePath,input,{'idempotency-key':key});assert.equal(restored.status,200);assert.equal(restored.body.revision,3);assert.equal(restored.body.imageHash,hash(image));
 const replay=await call(restorePath,input,{'idempotency-key':key});assert.equal(replay.status,200);assert.equal(replay.body.revision,3);assert.equal(replay.body.operation.replayed,true);
 assert.equal(app.store.db.prepare("SELECT count(*) n FROM managed_dataset_versions WHERE project_id=? AND kind='SQLITE_IMAGE_V1'").get(p.id).n,3);
 assert.equal(app.store.records(p.id,'SqliteDataRestore').length,1);
 assert.equal(app.store.records(p.id,'ModelAttempt').length,0);
 const attachment=snapshot.attachments[0],file=resolve(data,'controller/state-rehearsals',rehearsal.id,attachment.path),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);
 assert.equal((await call(restorePath,input,{'idempotency-key':key})).status,409);
 assert.equal(app.store.records(p.id,'SqliteDataRestore').length,1);
});

test('unknown Image Intent recovery uses the authenticated plan and confirmed same-project route without a model',async t=>{
 const {app,p,run,image,call}=await setup(t),capture=app.engine.sqliteData.capture(run.id,run.treeHash,1,planHash),wire=exchange(capture,image),
  operation=hash('offline-http-unknown-intent'),prepare=app.store.db.prepare.bind(app.store.db);
 app.store.db.prepare=sql=>{if(sql.startsWith('INSERT INTO managed_dataset_versions'))throw Error('OFFLINE_HTTP_RECOVERY_COMMIT');return prepare(sql);};
 try{assert.throws(()=>app.engine.sqliteData.publish(capture,wire,operation,'local-session:'+'a'.repeat(64)),/OFFLINE_HTTP_RECOVERY_COMMIT/);}finally{app.store.db.prepare=prepare;}
 assert.equal(app.engine.sqliteData.read(p.id).revision,1);
 const planPath='/projects/'+p.id+'/sqlite-data/recovery',plan=await call(planPath);assert.equal(plan.status,200,JSON.stringify(plan.body));
 assert.equal(plan.body.schema,'dream-maker.sqlite-data-recovery-plan.v1');assert.equal(plan.body.projectId,p.id);assert.equal(plan.body.candidates.length,1);
 assert.equal(plan.body.candidates[0].operationHash,operation);assert.equal(plan.body.candidates[0].expectedRevision,1);
 assert.doesNotMatch(JSON.stringify(plan.body),/sqlite-images|F:|C:|type":"Buffer/);
 const path='/projects/'+p.id+'/sqlite-data/recovery',input={operationHash:operation,confirmed:true},key=crypto.randomUUID();
 assert.equal((await call(path,{...input,confirmed:false},{'idempotency-key':key})).status,403);
 assert.equal((await call(path,{...input,path:'C:/outside'},{'idempotency-key':key})).status,400);
 const recovered=await call(path,input,{'idempotency-key':key});assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.revision,2);
 assert.equal(recovered.body.operation.replayed,false);
 const replay=await call(path,input,{'idempotency-key':key});assert.equal(replay.status,200);assert.equal(replay.body.operation.replayed,true);
 assert.equal(app.store.db.prepare("SELECT count(*) n FROM managed_dataset_versions WHERE project_id=? AND kind='SQLITE_IMAGE_V1'").get(p.id).n,2);
 assert.equal(app.store.records(p.id,'SqliteDataIntentRecovered').length,1);assert.equal(app.store.records(p.id,'ModelAttempt').length,0);
 assert.equal((await call(planPath)).body.candidates.length,0);
});

test('a legacy Intent without an immutable recovery binding is reported but cannot dispatch recovery',async t=>{
 const {app,p,run,image,call}=await setup(t),operation=hash('offline-http-legacy-intent'),
  actor='local-session:'+'d'.repeat(64),at='2026-11-08T00:00:00.000Z';
 app.store.db.prepare('INSERT INTO business_image_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(
  operation,p.id,run.id,run.treeHash,hash('offline-legacy-input'),1,hash(image),image.length,actor,at);
 const planPath='/projects/'+p.id+'/sqlite-data/recovery',plan=await call(planPath);
 assert.equal(plan.status,200,JSON.stringify(plan.body));
 assert.equal(plan.body.candidates.length,1);
 assert.equal(plan.body.candidates[0].operationHash,operation);
 assert.equal(plan.body.candidates[0].recoverable,false);
 assert.equal(plan.body.candidates[0].blockedReason,'INTENT_BINDING_REQUIRED');
 const rejected=await call(planPath,{operationHash:operation,confirmed:true},{'idempotency-key':crypto.randomUUID()});
 assert.equal(rejected.status,409,JSON.stringify(rejected.body));
 assert.equal(rejected.body.error,'INTENT_BINDING_REQUIRED');
 assert.equal(app.store.records(p.id,'SqliteDataRecoveryRequested').length,0);
 assert.equal(app.store.records(p.id,'ModelAttempt').length,0);
 assert.equal(app.engine.sqliteData.read(p.id).revision,1);
});
