// Authenticated actual localhost state backup/rehearsal with no native execution factory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {root} from '../helpers.mjs';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
async function setup(t){const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'maintenance-http-'));
 const denied=()=>{throw Error('NO_NATIVE_ROLES_IN_STATE_BACKUP_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),product:'dreamflow',port:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,extra={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 const project=await call('/user-plans',{document:{schema:'dream-maker.user-plan.v1',name:'维护隔离项目',mode:'demo',plan:fixtureProjectPlan([{id:'R1',text:'保留状态',origin:'USER',sources:['USER_DOCUMENT']}])}});assert.equal(project.status,200);
 return {app,data,call,project:project.body.project};
}
test('state backup requires authentication, CSRF and explicit consent; replay creates one snapshot',async t=>{
 const {app,data,call}=await setup(t);assert.equal((await fetch(app.origin+'/api/maintenance')).status,401);
 assert.equal((await call('/maintenance/snapshots',{confirmed:false})).status,403);
 assert.equal((await call('/maintenance/snapshots',{confirmed:true},{'x-csrf-token':'invalid'})).status,403);
 assert.equal((await call('/maintenance/snapshots',{confirmed:true,target:'C:/outside'})).status,400);
 const key=crypto.randomUUID(),first=await call('/maintenance/snapshots',{confirmed:true},{'idempotency-key':key});assert.equal(first.status,200);assert.equal(first.body.scope,'APPLICATION_STATE_ONLY');assert.equal(first.body.completeProjectBackup,false);
 assert.deepEqual(await call('/maintenance/snapshots',{confirmed:true},{'idempotency-key':key}),first);assert.equal(readdirSync(resolve(data,'controller/state-backups')).length,1);
  const list=await call('/maintenance');assert.equal(list.status,200);assert.equal(list.body.snapshots.length,1);assert.equal(list.body.modelsCalled,0);assert.equal(list.body.automaticResume,false);assert.equal(list.body.storageVolume.schema,'dream-maker.storage-volume-health.v1');assert.equal(list.body.storageVolume.scope,'VOLUME_HEALTH_ONLY');assert.equal(list.body.storageVolume.drive,'F:');assert.ok(['HEALTHY','REPAIR_REQUIRED','UNKNOWN'].includes(list.body.storageVolume.state));
 const id=first.body.id,rehearsal=await call('/maintenance/snapshots/'+id+'/rehearse',{confirmed:true});assert.equal(rehearsal.status,200);assert.equal(rehearsal.body.engineStarted,false);assert.equal(app.store.projects().length,1);assert.equal(app.engine.jobs.size,0);
});
test('a held writer or changed snapshot blocks maintenance without rewriting application state or business data',async t=>{
 const {app,data,call,project}=await setup(t);mkdirSync(resolve(data,'business'));writeFileSync(resolve(data,'business/canary.txt'),'KEEP_BUSINESS_DATA');
 app.store.acquire(project.id,'uncertain-writer');const blocked=await call('/maintenance/snapshots',{confirmed:true});assert.equal(blocked.status,409);assert.equal(blocked.body.error,'MAINTENANCE_WRITER_UNSETTLED');app.store.release(project.id,'uncertain-writer');
 const saved=await call('/maintenance/snapshots',{confirmed:true});assert.equal(saved.status,200);writeFileSync(resolve(data,'controller/state-backups',saved.body.id,'application.sqlite'),'CORRUPTED_TEST_COPY');
 const rejected=await call('/maintenance/snapshots/'+saved.body.id+'/rehearse',{confirmed:true});assert.equal(rejected.status,409);assert.equal(rejected.body.error,'MAINTENANCE_SNAPSHOT_CHANGED');
 assert.equal(readFileSync(resolve(data,'business/canary.txt'),'utf8'),'KEEP_BUSINESS_DATA');assert.equal(app.store.project(project.id).name,project.name);assert.equal(app.store.runs(project.id).length,0);
});
test('HTTP idempotency revalidates current snapshot and rehearsal bytes instead of replaying an old VERIFIED result',async t=>{
 const {data,call}=await setup(t),key=crypto.randomUUID(),saved=await call('/maintenance/snapshots',{confirmed:true},{'idempotency-key':key});assert.equal(saved.status,200);
 const rehearsalKey=crypto.randomUUID(),path='/maintenance/snapshots/'+saved.body.id+'/rehearse',restored=await call(path,{confirmed:true},{'idempotency-key':rehearsalKey});assert.equal(restored.status,200);
 const receiptPath=resolve(data,'controller/state-rehearsals',restored.body.id,'manifest.json'),bad=JSON.parse(readFileSync(receiptPath,'utf8'));bad.scope='FULL_PROJECT_RESTORED';writeFileSync(receiptPath,JSON.stringify(bad));
 const replay=await call(path,{confirmed:true},{'idempotency-key':rehearsalKey});assert.equal(replay.status,409);assert.equal(replay.body.error,'MAINTENANCE_REHEARSAL_CHANGED');
 writeFileSync(resolve(data,'controller/state-backups',saved.body.id,'application.sqlite'),'CORRUPTED_TEST_COPY');const again=await call('/maintenance/snapshots',{confirmed:true},{'idempotency-key':key});assert.equal(again.status,409);assert.equal(again.body.error,'MAINTENANCE_SNAPSHOT_CHANGED');
});
