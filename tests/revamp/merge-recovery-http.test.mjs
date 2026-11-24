// Real authenticated loopback HTTP and F/SQLite fault recovery; no product agents or paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {treeHash} from '../../dist/server/workspace.js';
import {interruptedMerge} from '../fixtures/executor-recovery.mjs';
import {root} from '../helpers.mjs';
async function setup(t,product='dream-maker'){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'merge-http-')),denied=()=>{throw Error('NO_NATIVE_ROLES_IN_MERGE_RECOVERY_HTTP');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),product,port:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const fixture=await interruptedMerge(t,'PARTIAL',{h:{...app,dir:data,config:app.settings.value},businessData:true}),{run}=fixture;
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,headers={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 return {...fixture,app,data,call,path:'/runs/'+run.id+'/merge-recovery'};
}
const request=(view,choice='RESTORE_BASE_AND_END')=>({choice,previewHash:view.previewHash,expectedHash:view.source.currentHash,confirmed:true});
test('recovery inspection is read-only and authenticated; unsafe fields, missing consent and CSRF are rejected',async t=>{
 const {app,call,path,run}=await setup(t),before={run:app.store.run(run.id),records:app.store.records(run.projectId),events:app.store.events(run.projectId,0)};
 assert.equal((await fetch(app.origin+'/api'+path)).status,401);const preview=await call(path);assert.equal(preview.status,200);assert.equal(preview.body.sourceState,'PARTIALLY_PUBLISHED');
 assert.deepEqual({run:app.store.run(run.id),records:app.store.records(run.projectId),events:app.store.events(run.projectId,0)},before);
 const input=request(preview.body);assert.equal((await call(path,{...input,confirmed:false})).status,403);assert.equal((await call(path,input,{'x-csrf-token':'bad'})).status,403);
 for(const field of ['path','sql','actor','verified','provider','model'])assert.equal((await call(path,{...input,[field]:'not-authorized'})).status,400);
 assert.equal((await call(path,input,{'idempotency-key':''})).status,400);assert.equal(app.store.records(run.projectId,'ExecutorMergeRecovered').length,0);assert.equal(app.store.owns(run.projectId,run.id),true);
});
for(const [product,choice]of [['dream-maker','KEEP_FILES_AND_END'],['dreamflow','RESTORE_BASE_AND_END']])test(product+' recovers through the original Engine and rechecks bytes on idempotent replay',async t=>{
 const {app,call,path,run,wave}=await setup(t,product),snapshot=await call('/projects/'+run.projectId);assert.equal(snapshot.body.runs[0].mergeRecoveryRequired,true);assert.equal(Object.hasOwn(app.store.run(run.id),'mergeRecoveryRequired'),false);
 const preview=await call(path);assert.equal(preview.status,200);const body=request(preview.body,choice),key=crypto.randomUUID(),versions=app.store.db.prepare('SELECT * FROM managed_dataset_versions').all();
 const result=await call(path,body,{'idempotency-key':key});assert.equal(result.status,200);assert.equal(result.body.originalMergeApplied,false);assert.equal(result.body.automaticResume,false);assert.equal(app.store.run(run.id).state,'CANCELLED');assert.equal(app.engine.activeJobCount,0);
 assert.equal((await call('/projects/'+run.projectId)).body.runs[0].mergeRecoveryRequired,false);assert.deepEqual(app.store.db.prepare('SELECT * FROM managed_dataset_versions').all(),versions);assert.equal(app.store.records(run.projectId,'ExecutorMergeApplied').length,0);
 assert.equal((await call(path,body,{'idempotency-key':key})).body.replayed,true);assert.equal((await call(path,{...body,choice:choice==='KEEP_FILES_AND_END'?'RESTORE_BASE_AND_END':'KEEP_FILES_AND_END'},{'idempotency-key':key})).status,409);
 const before=treeHash(run.workspace);writeFileSync(resolve(wave.directory,'base/a.txt'),'damaged archived copy');assert.equal((await call(path,body,{'idempotency-key':key})).status,409);assert.equal(treeHash(run.workspace),before);assert.equal(readFileSync(resolve(run.workspace,'a.txt'),'utf8'),choice==='RESTORE_BASE_AND_END'?'a0':'a1');
 assert.equal(app.store.records(run.projectId,'ModelAttempt').length,0);assert.doesNotMatch(JSON.stringify(app.store.db.prepare('SELECT response FROM requests').all()),/originalMergeApplied|recovery-result|合并恢复必须保留的业务内容/);
});
