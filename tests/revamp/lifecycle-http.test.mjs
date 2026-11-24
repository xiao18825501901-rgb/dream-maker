// Actual authenticated localhost/SQLite lifecycle, fixed Demo only. No account/model/Live proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {hash} from '../../dist/server/security.js';
import {root,until} from '../helpers.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
async function setup(t,builder){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const controllerRoot=mkdtempSync(resolve(parent,'lifecycle-http-')),data=resolve(controllerRoot,'.runtime'),denied=()=>{throw Error('NO_NATIVE_ROLES_IN_LIFECYCLE_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,demoDelayMs:60,...(builder?{nativeOwnerBuilder:context=>builder(context,data,controllerRoot)}:{nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}})});
 fixedControllerCapacity(app.engine);
 t.after(async()=>{await app.close();rmSync(controllerRoot,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,method='GET',body,extra={})=>{const response=await fetch(app.origin+'/api'+path,{method,headers:{cookie,...(method==='GET'?{}:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()}),...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 return {app,data,call,cookie};
}
test('background is a separate confirmed acknowledgement, never approval or a new job',async t=>{
 const {app,call}=await setup(t);assert.equal((await call('/application/lifecycle')).body.state,'RUNNING');
 assert.equal((await call('/application/lifecycle','POST',{choice:'BACKGROUND_CURRENT_WORK',confirmed:false})).status,403);
 assert.equal((await call('/application/lifecycle','POST',{choice:'BACKGROUND_CURRENT_WORK',confirmed:true},{'x-csrf-token':'wrong'})).status,403);
 const ack=await call('/application/lifecycle','POST',{choice:'BACKGROUND_CURRENT_WORK',confirmed:true});assert.equal(ack.status,200);assert.equal(ack.body.lastChoice,'BACKGROUND_CURRENT_WORK');assert.equal(ack.body.browserCloseStopsWork,false);assert.equal(ack.body.automaticResume,false);assert.equal(app.engine.jobs.size,0);assert.equal(app.store.runs().length,0);
});
test('a prior background choice cannot silently carry over to a new mutation or be resurrected by replay',async t=>{
 const {call}=await setup(t),key='background-for-old-work',choice={choice:'BACKGROUND_CURRENT_WORK',confirmed:true};
 assert.equal((await call('/application/lifecycle','POST',choice,{'idempotency-key':key})).body.lastChoice,'BACKGROUND_CURRENT_WORK');
 assert.equal((await call('/projects','POST',{name:'新的 Demo',idea:'新的操作需要重新决定离开方式',mode:'demo'})).status,200);
 assert.equal((await call('/application/lifecycle')).body.lastChoice,null);assert.equal((await call('/application/lifecycle','POST',choice,{'idempotency-key':key})).body.lastChoice,null);
});
test('confirmed pause drains current Demo work, keeps data readable and blocks subsequent writes until restart',async t=>{
 const {app,call}=await setup(t),p=app.interviews.create('暂停本机工作','保留方案与当前回合','demo');await app.interviews.finish(p.id,'',false);const s=app.store.spec(app.store.project(p.id).specId);app.interviews.approve(p.id,s.hash);const run=app.engine.create(p.id,s.hash,true);await until(()=>app.store.records(p.id,'LayaDecision').length>0);
 const key='same-pause-intent',body={choice:'PAUSE',confirmed:true},start=await call('/application/lifecycle','POST',body,{'idempotency-key':key});assert.equal(start.status,200);assert.ok(['PAUSE_REQUESTED','PAUSED'].includes(start.body.state));
 await until(async()=>((await call('/application/lifecycle')).body.state==='PAUSED'));assert.equal(app.store.run(run.id).state,'PAUSED');assert.equal(app.store.run(run.id).calls,1);assert.equal(app.store.owns(p.id,run.id),true);
 assert.equal((await call('/projects')).status,200);assert.equal((await call('/projects','POST',{name:'不得新增',idea:'暂停之后不再开新工作',mode:'demo'})).body.error,'APPLICATION_PAUSING');
 const replay=await call('/application/lifecycle','POST',body,{'idempotency-key':key});assert.equal(replay.body.state,'PAUSED');assert.equal((await call('/application/lifecycle','POST',{choice:'BACKGROUND_CURRENT_WORK',confirmed:true})).status,409);
 assert.equal(app.store.db.prepare("SELECT count(*) n FROM records WHERE kind='ApplicationLifecycle' AND json_extract(data,'$.choice')='PAUSE'").get().n,1);
 assert.equal(app.store.approved(p.id,s.hash,'DELIVERY'),false);
});

test('the original initialized monetary controller still provides history through HTTP after a successful pause',async t=>{
 const {call}=await setup(t,(context,data,controllerRoot)=>{
  const authority={scopeId:'OFFLINE_LIFECYCLE_HISTORY',authorizationHash:'OFFLINE_NOT_LIVE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2},bytes=JSON.stringify(authority),path=resolve(data,'authority.json');writeFileSync(path,bytes);mkdirSync(resolve(controllerRoot,'config'));
  writeFileSync(resolve(controllerRoot,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:controllerRoot,authority:{path,sha256:hash(bytes)},maxOutputTokens:128,maxRequests:5}));
  const owner=new NativeOwner({...context,root:controllerRoot});assert.equal(owner.budgetStatus().requests,0);return owner;
 });
 assert.equal((await call('/onboarding')).status,200);await call('/application/lifecycle','POST',{choice:'PAUSE',confirmed:true});await until(async()=>((await call('/application/lifecycle')).body.state==='PAUSED'));
 const history=await call('/onboarding');assert.equal(history.status,200);assert.equal(history.body.fees.existingScope.requests,0);assert.equal(history.body.fees.ordinaryUserDefault.configured,false);
});
