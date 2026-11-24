// Actual authenticated localhost requests and original fixed Demo; no native model or Live proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {ready,root} from '../helpers.mjs';
const payload=title=>[{id:'t1',title,done:false}];
async function setup(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'data-http-'));
 const denied=()=>{throw Error('NO_NATIVE_ROLES_IN_DATA_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const {p,s}=await ready({interviews:app.interviews,store:app.store}),r=app.engine.create(p.id,s.hash,true);await app.engine.settled(r.id);const run=app.store.run(r.id);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,headers={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 return {app,data,p,run,call,path:'/runs/'+run.id+'/data'};
}
test('managed data HTTP preserves authentication, CSRF, exact source and explicit browser-import consent',async t=>{
 const {app,run,call,path}=await setup(t),input={treeHash:run.treeHash,tasks:payload('从浏览器迁移的内容'),confirmed:true};
 assert.equal((await fetch(app.origin+'/api'+path+'?treeHash='+run.treeHash)).status,401);
 assert.equal((await call(path+'/import',{...input,confirmed:false})).status,403);
 assert.equal((await call(path+'/import',input,{'x-csrf-token':'bad'})).status,403);
 assert.equal((await call(path+'/import',{...input,path:'C:/outside'})).status,400);
 assert.equal((await call(path+'/import',{...input,treeHash:'b'.repeat(64)})).body.error,'MANAGED_DATA_SOURCE_CHANGED');
 const saved=await call(path+'/import',input);assert.equal(saved.status,200);assert.equal(saved.body.revision,1);
 const read=await call(path+'?treeHash='+run.treeHash);assert.equal(read.status,200);assert.deepEqual(read.body.tasks,input.tasks);assert.equal(read.body.nativeExecutionGranted,false);
 assert.equal(app.store.records(run.projectId,'ModelAttempt').length,0);
});
test('HTTP data writes bind displayed revision and key; fresh reads never rebase an old payload',async t=>{
 const {app,p,run,call,path}=await setup(t),key=crypto.randomUUID(),one={treeHash:run.treeHash,expectedRevision:0,tasks:payload('甲内容')};
 const first=await call(path,one,{'idempotency-key':key});assert.equal(first.status,200);assert.equal(first.body.revision,1);
 assert.equal((await call(path,{treeHash:run.treeHash,expectedRevision:1,tasks:payload('乙内容')})).status,200);
 assert.equal((await call(path,{...one,tasks:payload('迟到的旧数据')})).body.error,'MANAGED_DATA_CONFLICT');
 const replay=await call(path,one,{'idempotency-key':key});assert.equal(replay.status,200);assert.equal(replay.body.revision,2);assert.equal(replay.body.operation.appliedRevision,1);assert.equal(replay.body.operation.replayed,true);
 assert.equal((await call(path,{...one,tasks:payload('偷换同key内容')},{'idempotency-key':key})).body.error,'MANAGED_DATA_IDEMPOTENCY_CONFLICT');
 const cached=app.store.db.prepare('SELECT response FROM requests').all();assert.doesNotMatch(JSON.stringify(cached),/甲内容|乙内容|迟到的旧数据/);
 assert.doesNotMatch(JSON.stringify(app.store.records(p.id)),/甲内容|乙内容/);
});
test('confirmed HTTP restores only the same project data and revalidates rehearsal bytes on replay',async t=>{
 const {app,data,p,run,call,path}=await setup(t);assert.equal((await call(path+'/import',{treeHash:run.treeHash,tasks:payload('要恢复的内容'),confirmed:true})).status,200);
 const snapshot=(await call('/maintenance/snapshots',{confirmed:true})).body,rehearsal=(await call('/maintenance/snapshots/'+snapshot.id+'/rehearse',{confirmed:true})).body;
 await call(path,{treeHash:run.treeHash,expectedRevision:1,tasks:payload('恢复前的新内容')});
 const restorePath='/projects/'+p.id+'/data/restore',key=crypto.randomUUID(),input={snapshotId:snapshot.id,rehearsalId:rehearsal.id,expectedRevision:2,confirmed:true};
 assert.equal((await call(restorePath,{...input,confirmed:false})).status,403);
 const restored=await call(restorePath,input,{'idempotency-key':key});assert.equal(restored.status,200);assert.equal(restored.body.revision,3);assert.deepEqual(restored.body.tasks,payload('要恢复的内容'));
 const file=resolve(data,'controller/state-rehearsals',rehearsal.id,'application.sqlite'),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);
 assert.equal((await call(restorePath,input,{'idempotency-key':key})).status,409);assert.equal(app.store.records(p.id,'ManagedDataRestore').length,1);
 assert.equal(app.engine.jobs.size,0);assert.equal(app.store.records(p.id,'ModelAttempt').length,0);
});
