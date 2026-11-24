// Actual loopback HTTP/SQLite with an explicitly OFFLINE interrupted-task fixture. No model dispatch.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {interruptedTask} from '../fixtures/interrupted-task.mjs';import {root} from '../helpers.mjs';
async function setup(t,product='dream-maker'){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'checkpoint-http-'));let nativeCalls=0;
 const denied=()=>{nativeCalls++;throw Error('NO_MODEL_AUTHORITY_IN_CHECKPOINT_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),product,port:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const f=await interruptedTask(t,{h:{...app,dir:data,config:app.settings.value}});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,headers={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:body?JSON.stringify(body):undefined});return{status:response.status,body:await response.json()};};
 return{...f,app,call,path:'/runs/'+f.run.id+'/executor-checkpoint',nativeCalls:()=>nativeCalls};
}
test('checkpoint GET is authenticated and read-only; consent, CSRF and undeclared authority fields fail closed',async t=>{
 const {app,call,path,run,nativeCalls}=await setup(t),before={run:app.store.run(run.id),records:app.store.records(run.projectId)};
 assert.equal((await fetch(app.origin+'/api'+path)).status,401);const view=await call(path);assert.equal(view.status,200);assert.equal(view.body.modelsCalled,0);assert.equal(view.body.executionGranted,false);assert.doesNotMatch(JSON.stringify(view.body),/workspace|directory|F:[/\\]/);
 assert.deepEqual({run:app.store.run(run.id),records:app.store.records(run.projectId)},before);const body={confirmed:true,previewHash:view.body.previewHash};
 assert.equal((await call(path,{...body,confirmed:false})).status,403);assert.equal((await call(path,body,{'x-csrf-token':'bad'})).status,403);
 for(const key of ['path','source','verified','provider','actor','model','budget'])assert.equal((await call(path,{...body,[key]:'untrusted'})).status,400);
 assert.equal((await call(path,body,{'idempotency-key':''})).status,400);assert.equal(nativeCalls(),0);assert.equal(app.store.records(run.projectId,'ExecutorCheckpointPrepared').length,0);
});
for(const product of ['dream-maker','dreamflow'])test(product+' prepares retained copies through the original Engine and rechecks actual bytes on replay',async t=>{
 const {app,call,path,run,wave,nativeCalls}=await setup(t,product),snapshot=await call('/projects/'+run.projectId);assert.equal(snapshot.body.runs[0].executorCheckpointRequired,true);assert.equal(Object.hasOwn(app.store.run(run.id),'executorCheckpointRequired'),false);
 const view=await call(path),body={confirmed:true,previewHash:view.body.previewHash},key=crypto.randomUUID(),result=await call(path,body,{'idempotency-key':key});
 assert.equal(result.status,200);assert.equal(result.body.state,'PAUSED');assert.equal(result.body.automaticResume,false);assert.equal(app.store.run(run.id).tasks.filter(t=>t.status==='done').length,0);assert.equal(app.store.owns(run.projectId,run.id),true);
 assert.equal((await call(path,body,{'idempotency-key':key})).body.replayed,true);assert.equal(nativeCalls(),0);assert.equal(app.store.records(run.projectId,'ExecutorMergeApplied').length,0);
 writeFileSync(resolve(wave.assignments[0].workspace,'a.txt'),'late outside write');assert.equal((await call(path,body,{'idempotency-key':key})).status,409);assert.equal(app.store.records(run.projectId,'ExecutorCheckpointPrepared').length,1);
 assert.doesNotMatch(JSON.stringify(app.store.db.prepare('SELECT response FROM requests').all()),/sourceCopiesRetained|executor-checkpoint-result/);
});
