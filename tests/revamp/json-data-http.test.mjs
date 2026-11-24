// Real local HTTP/SQLite with deliberately seeded storage metadata; NOT a Live role acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {ready,root} from '../helpers.mjs';
import {fixtureEntered,fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
async function setup(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'json-http-')),denied=()=>{throw Error('NO_NATIVE_ROLES_IN_JSON_HTTP_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const {p,s}=await ready({store:app.store,interviews:app.interviews}),created=app.engine.create(p.id,s.hash,true);await app.engine.settled(created.id);const project=app.store.project(p.id);project.mode='live';app.store.saveProject(project);const run=app.store.run(created.id);run.mode='live';run.review={...run.review,source:'CODEX'};app.store.saveRun(run);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,headers={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};return {app,data,p,run,call,path:'/runs/'+run.id+'/json-data'};
}
test('JSON HTTP retains local auth, CSRF, source binding and explicit import without accepting paths',async t=>{
 const {app,p,run,call,path}=await setup(t),input={treeHash:run.treeHash,document:{items:['业务内容']},confirmed:true};
 assert.equal((await fetch(app.origin+'/api'+path+'?treeHash='+run.treeHash)).status,401);assert.equal((await call(path+'/import',{...input,confirmed:false})).status,403);assert.equal((await call(path+'/import',input,{'x-csrf-token':'bad'})).status,403);assert.equal((await call(path+'/import',{...input,path:'F:/outside'})).status,400);
 const saved=await call(path+'/import',input);assert.equal(saved.status,200);assert.equal(saved.body.revision,1);assert.equal(saved.body.nativeExecutionGranted,false);assert.deepEqual((await call('/projects/'+p.id+'/json-data')).body.document,input.document);
 const key=crypto.randomUUID(),two={treeHash:run.treeHash,document:{items:['新版业务内容']},expectedRevision:1};assert.equal((await call(path,two,{'idempotency-key':key})).status,200);assert.equal((await call(path,{...two,document:{late:true}})).body.error,'JSON_DATA_CONFLICT');
 assert.equal((await call(path,two,{'idempotency-key':key})).body.operation.replayed,true);assert.doesNotMatch(JSON.stringify(app.store.db.prepare('SELECT response FROM requests').all()),/新版业务内容|业务内容/);assert.equal(app.store.records(p.id,'ModelAttempt').length,0);
});
test('JSON HTTP restores a separately confirmed, anchored same-project revision and rechecks source on replay',async t=>{
 const {app,data,p,run,call,path}=await setup(t);assert.equal((await call(path+'/import',{treeHash:run.treeHash,document:{value:'备份的内容'},confirmed:true})).status,200);
 const snap=(await call('/maintenance/snapshots',{confirmed:true})).body,reh=(await call('/maintenance/snapshots/'+snap.id+'/rehearse',{confirmed:true})).body;
 await call(path,{treeHash:run.treeHash,document:{value:'恢复前修改'},expectedRevision:1});const plan=await call('/maintenance/snapshots/'+snap.id+'/rehearsals/'+reh.id+'/projects/'+p.id+'/json-data');assert.equal(plan.status,200);assert.equal(plan.body.target.revision,2);assert.equal(plan.body.engineStarted,false);
 const restorePath='/projects/'+p.id+'/json-data/restore',input={snapshotId:snap.id,rehearsalId:reh.id,expectedRevision:2,confirmed:true},key=crypto.randomUUID();assert.equal((await call(restorePath,{...input,confirmed:false})).status,403);
 const done=await call(restorePath,input,{'idempotency-key':key});assert.equal(done.status,200);assert.equal(done.body.revision,3);assert.deepEqual(done.body.document,{value:'备份的内容'});
 const file=resolve(data,'controller/state-rehearsals',reh.id,'application.sqlite'),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);assert.equal((await call(restorePath,input,{'idempotency-key':key})).status,409);assert.equal(app.store.records(p.id,'JsonDataRestore').length,1);assert.equal(app.engine.jobs.size,0);
});

test('runtime HTTP accepts only explicit revision/source consent and includes data jobs in lifecycle',async t=>{
 const {app,p,run,call,path}=await setup(t);fixedControllerCapacity(app.engine);run.plan={...run.plan,dataRuntime:{schema:'dream-maker.json-runtime-plan.v1',protocol:'JSON_DOCUMENT_V1',runtime:'node',entry:'data.mjs',args:[]}};app.store.saveRun(run);
 let finish,started;const gate=new Promise(r=>finish=r),entered=new Promise(r=>started=r);let calls=0;
 app.engine.nativeExecution={assertReady(){},executor(){throw Error('NO_MODEL');},verify(){throw Error('NO_VERIFIER');},async close(){},async runData(input){
  calls++;started();await gate;const raw=JSON.parse(input.command.stdin);return {status:'EXECUTED',exitCode:0,sourceHash:input.sourceHash,stdout:JSON.stringify({schema:'dream-maker.json-runtime-output.v1',inputHash:raw.inputHash,expectedRevision:raw.revision,document:{result:'控制端业务内容'}})};
 }};
 const endpoint=path+'/execute',input={treeHash:run.treeHash,expectedRevision:0,confirmed:true};
 assert.equal((await call(endpoint,{...input,confirmed:false})).status,403);assert.equal((await call(endpoint,{...input,command:'arbitrary'})).status,400);
 const key=crypto.randomUUID(),work=call(endpoint,input,{'idempotency-key':key}).then(result=>{assert.equal(result.status,200,JSON.stringify(result.body));return result;});await fixtureEntered(entered,work,finish);
 const lifecycle=(await call('/application/lifecycle')).body;assert.equal(lifecycle.active.engineJobs,1);assert.equal(lifecycle.currentRoundMayStillRun,true);
 assert.equal((await call('/maintenance/snapshots',{confirmed:true})).status,409);
 finish();const result=await work;assert.equal(result.status,200);assert.equal(result.body.revision,1);assert.deepEqual(result.body.document,{result:'控制端业务内容'});
 assert.equal((await call(endpoint,input,{'idempotency-key':key})).body.operation.replayed,true);assert.equal(calls,1);assert.equal(app.store.run(run.id).state,'READY_FOR_DELIVERY');
 assert.doesNotMatch(JSON.stringify(app.store.db.prepare('SELECT response FROM requests').all()),/控制端业务内容/);assert.equal(app.store.records(p.id,'ModelAttempt').length,0);
});
