// OFFLINE trusted owner seam + actual localhost HTTP/SQLite. No model or native process.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {FlowProfiles} from '../../dist/server/flow-profiles.js';import {DomainError,hash} from '../../dist/server/security.js';import {root} from '../helpers.mjs';
import {magpieBlocksNative} from '../../dist/server/magpie-check.js';
async function fixture(t,uncertain=false){
 const base=join(root,'.runtime/test-temp');mkdirSync(base,{recursive:true});const data=mkdtempSync(join(base,'account-check-http-'));let calls=0,app;
 const deny=()=>{throw Error('NO_MODELS');};app=await createApp({root,data,configPath:join(data,'local.json'),port:0,product:'dreamflow',nativeOwnerBuilder:c=>({assertReady:deny,executor:deny,verify:deny,paidGuard:deny,stopRequests(){},close:async()=>{},describeCustomMagpieAccountCheck:input=>({flowConfigHash:app.engine.prepareCustomFlow(input.projectId,input.specHash,input.profileHash).flowConfigHash,sourceBindingHash:'f'.repeat(64)}),inspectCustomMagpieAccounts:async input=>{calls++;assert.equal(c.store.records(input.projectId,'MagpieAccountCheckIntent').length,1);if(uncertain)throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'PRIVATE_CLEANUP_DETAIL');const prepared=app.engine.prepareCustomFlow(input.projectId,input.specHash,input.profileHash);return{schema:'dream-maker.magpie-account-control-observation.v1',projectId:input.projectId,flowConfigHash:prepared.flowConfigHash,sourceBindingHash:'f'.repeat(64),accountCount:1,processClosed:true,accountVerified:false,modelVerified:false,customExecutionGranted:false};}})});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const p=app.interviews.create('账户交接HTTP检查','合成控制流程，不制作项目。','demo');await app.interviews.finish(p.id,'',false);const spec=app.store.spec(app.store.project(p.id).specId);app.interviews.approve(p.id,spec.hash);
 const a={provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'},role=(id,write=false)=>({id,...a,runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}}),configuration={mode:'custom',laya:false,accounts:[a],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai'};
 const version=new FlowProfiles(app.store).confirm(p.id,{configuration,expectedRevision:0,confirmed:true},'local-session:'+'a'.repeat(64),'OFFLINE_HTTP_ACCOUNT_CHECK_PROFILE'),prep=app.engine.prepareCustomFlow(p.id,spec.hash,version.contentHash),input={specHash:spec.hash,profileHash:version.contentHash,preparation:{identityHash:prep.identityHash,contentHash:prep.contentHash},confirmed:true},path='/api/projects/'+p.id+'/flow-account-check';
 const call=async(method,body=input,key=crypto.randomUUID(),extra={})=>{const response=await fetch(app.origin+path,{method,headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key,...extra},...(method==='GET'?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};return{app,p,input,path,call,calls:()=>calls};
}

test('account process checks require original auth, CSRF, exact input and explicit consent',async t=>{
 const x=await fixture(t);assert.equal((await fetch(x.app.origin+x.path)).status,401);assert.equal((await x.call('GET')).body.status,'NOT_RUN');
 assert.equal((await x.call('POST',x.input,undefined,{'x-csrf-token':'bad'})).status,403);assert.equal((await x.call('POST',{...x.input,confirmed:false})).status,403);assert.equal((await x.call('POST',{...x.input,key:'FORBIDDEN_SYNTHETIC_VALUE'})).status,400);assert.equal(x.calls(),0);
});
test('a completed process check replays history without models, new runs or renewed permissions',async t=>{
 const x=await fixture(t),before={runs:x.app.store.runs(x.p.id).length,approvals:x.app.store.db.prepare('SELECT count(*) n FROM approvals').get().n},key=crypto.randomUUID(),one=await x.call('POST',x.input,key);assert.equal(one.status,200);assert.equal(one.body.status,'PASSED');assert.equal(one.body.processClosed,true);assert.equal(one.body.historical,true);for(const field of ['accountVerified','modelVerified','customExecutionGranted'])assert.equal(one.body[field],false);assert.doesNotMatch(JSON.stringify(one),/runtimeDirectory|upstreamAccountRef|secretEnv|PRIVATE/);
 assert.deepEqual(await x.call('POST',x.input,key),one);assert.equal(x.calls(),1);assert.deepEqual((await x.call('GET')).body,one.body);assert.equal((await x.call('POST',{...x.input,profileHash:'0'.repeat(64)},key)).status,409);assert.deepEqual({runs:x.app.store.runs(x.p.id).length,approvals:x.app.store.db.prepare('SELECT count(*) n FROM approvals').get().n},before);
});
test('cleanup uncertainty is durable and blocks a different launch request',async t=>{
 const x=await fixture(t,true),key=crypto.randomUUID(),one=await x.call('POST',x.input,key);assert.equal(one.body.status,'UNCERTAIN');assert.equal(one.body.processClosed,false);assert.equal(JSON.stringify(one).includes('PRIVATE_CLEANUP_DETAIL'),false);assert.deepEqual(await x.call('POST',x.input,key),one);assert.equal((await x.call('POST')).status,409);assert.equal(x.calls(),1);assert.equal((await x.call('GET')).body.status,'UNCERTAIN');
});

test('HTTP replay validates the original journal instead of trusting a cached success',async t=>{
 const x=await fixture(t),key=crypto.randomUUID();assert.equal((await x.call('POST',x.input,key)).body.status,'PASSED');
 x.app.store.db.prepare("UPDATE records SET data=? WHERE kind='MagpieAccountCheckIntent'").run('{PRIVATE_CORRUPTION');
 const replay=await x.call('POST',x.input,key);assert.equal(replay.status,409);assert.equal(replay.body.error,'MAGPIE_ACCOUNT_CHECK_INTEGRITY');assert.equal(JSON.stringify(replay).includes('PRIVATE_CORRUPTION'),false);assert.equal(x.calls(),1);
});
test('a corrupted HTTP receipt cannot return qualification flags or start another inspection',async t=>{
 const x=await fixture(t),key=crypto.randomUUID();await x.call('POST',x.input,key);const requestKey='POST:'+x.path+':'+key,row=x.app.store.db.prepare('SELECT response FROM requests WHERE key=?').get(requestKey),cached=JSON.parse(row.response);cached.accountVerified=true;
 x.app.store.db.prepare('UPDATE requests SET response=? WHERE key=?').run(JSON.stringify(cached),requestKey);const replay=await x.call('POST',x.input,key);assert.equal(replay.status,409);assert.notEqual(replay.body.accountVerified,true);assert.equal(x.calls(),1);
});

test('a completed receipt with missing journal records never starts its inspection again',async t=>{
 const x=await fixture(t),key=crypto.randomUUID();assert.equal((await x.call('POST',x.input,key)).body.status,'PASSED');
 x.app.store.db.prepare("DELETE FROM records WHERE kind IN ('MagpieAccountCheckIntent','MagpieAccountCheckResult')").run();
 const replay=await x.call('POST',x.input,key);assert.equal(replay.status,409);assert.equal(x.calls(),1);assert.equal(magpieBlocksNative(x.app.store),true);
});
