// OFFLINE owner seam with real localhost HTTP/Store. Not native Magpie/model evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {defaults} from '../../dist/server/config.js';import {DomainError} from '../../dist/server/security.js';import {root} from '../helpers.mjs';
async function setup(t,fail=false){
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'magpie-http-'));writeFileSync(join(data,'config.json'),JSON.stringify(defaults));let calls=0;
 const deny=()=>{throw Error('NATIVE_MODEL_NOT_PERMITTED');};
 const app=await createApp({root,data,configPath:join(data,'config.json'),port:0,product:'dreamflow',nativeOwnerBuilder:()=>({assertReady:deny,executor:deny,verify:deny,paidGuard:deny,stopRequests(){},close:async()=>{},inspectMagpieIngress:async()=>{calls++;if(fail)throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500,'PRIVATE_PATH_AND_DETAIL');return{scope:'LOCAL_CONTROL_PROCESS_ONLY',qualification:'NOT_VERIFIED',accountCount:0,credentialsAccepted:false,accounts:[],realCredentialsPermitted:false,pid:123,address:'127.0.0.1:1',runtimeDirectory:'F:/PRIVATE_SYNTHETIC_NOT_PUBLIC'};}})});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(method,body,key=crypto.randomUUID(),headers={})=>{const response=await fetch(app.origin+'/api/magpie/checks',{method,headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 return{app,call,calls:()=>calls};
}
test('Magpie local check requires authentication, CSRF and exact explicit input',async t=>{
 const f=await setup(t);assert.equal((await fetch(f.app.origin+'/api/magpie/checks')).status,401);
 assert.equal((await f.call('POST',{confirmed:true},undefined,{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await f.call('POST',{})).status,403);
 assert.equal((await f.call('POST',{confirmed:true,binary:'untrusted'})).status,400);assert.equal(f.calls(),0);
});
test('a completed local check is replayed as historical evidence without paths, accounts or model claims',async t=>{
 const f=await setup(t);assert.equal((await f.call('GET')).body.status,'NOT_RUN');
 const key=crypto.randomUUID(),first=await f.call('POST',{confirmed:true},key);assert.equal(first.status,200);assert.equal(first.body.status,'PASSED');
 for(const k of ['accountVerified','modelVerified','customExecutionGranted'])assert.equal(first.body[k],false);assert.equal(first.body.processClosed,true);
 assert.doesNotMatch(JSON.stringify(first),/PRIVATE|runtimeDirectory|127\.0\.0\.1:1|"pid"/);
 const stored=JSON.parse(f.app.store.db.prepare("SELECT data FROM records WHERE kind='MagpieIngressCheckResult'").get().data);assert.equal(stored.observation.accountCount,0);assert.equal(stored.observation.runtimeDirectory,'F:/PRIVATE_SYNTHETIC_NOT_PUBLIC');
 assert.deepEqual(await f.call('POST',{confirmed:true},key),first);assert.equal(f.calls(),1);assert.deepEqual((await f.call('GET')).body,first.body);assert.equal(f.app.store.projects().length,0);
});
test('uncertain cleanup remains visible and does not rerun the same failed request',async t=>{
 const f=await setup(t,true),key=crypto.randomUUID(),first=await f.call('POST',{confirmed:true},key);assert.equal(first.status,200);assert.equal(first.body.status,'UNCERTAIN');assert.equal(first.body.processClosed,false);assert.doesNotMatch(JSON.stringify(first),/PRIVATE_PATH/);
 assert.deepEqual(await f.call('POST',{confirmed:true},key),first);assert.equal(f.calls(),1);assert.equal((await f.call('GET')).body.status,'UNCERTAIN');
 assert.equal((await f.call('POST',{confirmed:true})).status,409);assert.equal(f.calls(),1);
});
test('a new unfinished durable intent hides an older success without restarting the process',async t=>{
 const f=await setup(t);await f.call('POST',{confirmed:true});f.app.store.record('MagpieIngressCheckIntent',null,null,{operationHash:'offline-interrupted-request'});
 const status=await f.call('GET');assert.equal(status.body.status,'UNCERTAIN');assert.equal(status.body.processClosed,false);assert.equal(f.calls(),1);
 assert.equal((await f.call('POST',{confirmed:true})).status,409);assert.equal(f.calls(),1);
});
