// Actual local HTTP/SQLite, zero models or account scans. Separate from Native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {root} from '../helpers.mjs';
async function fixture(t,product='dream-maker',localPlanner1Runtime){
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'p1-choice-http-')),config=structuredClone(defaults);writeFileSync(join(data,'config.json'),JSON.stringify(config));
 let modelCalls=0;const app=await createApp({root,data,configPath:join(data,'config.json'),product,port:0,paidRequestGuard:()=>{modelCalls++;throw Error('NO_MODEL_ALLOWED');},localPlanner1Runtime});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const response=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=response.headers.get('set-cookie').split(';')[0],{csrf}=await response.json();
 const select=async(body,headers={})=>{const r=await fetch(app.origin+'/api/planner1/selection',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 return{app,select,calls:()=>modelCalls,cookie,csrf};
}
test('P1 selection retains CSRF and freezes v2 choice without an inference request',async t=>{
 const x=await fixture(t),input={provider:'deepseek',authentication:'api_key',model:'owner-model',confirmed:true};
 assert.equal((await x.select(input,{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await x.select({...input,confirmed:false})).status,403);
 const unsupported=await x.select({...input,provider:'openai',authentication:'oauth'});assert.equal(unsupported.status,409);assert.equal(unsupported.body.error,'PLANNER1_OFFICIAL_AUTH_UNAVAILABLE');
 const changed=await x.select(input);assert.equal(changed.status,200);assert.equal(changed.body.planner1Binding.provider,'deepseek');assert.equal(changed.body.planner1Binding.authMethod,'api_key');assert.equal(changed.body.planner1Binding.bindingVersion,2);assert.equal(changed.body.nativeStatus,'NOT_VERIFIED');
 assert.equal(x.app.store.projects().length,0);assert.equal(x.app.store.runs().length,0);assert.equal(x.calls(),0);
});
test('standalone DreamFlow never initializes or accepts a P1 authentication selection',async t=>{
 const x=await fixture(t,'dreamflow'),before=structuredClone(x.app.settings.value.planner1);
 const response=await x.select({provider:'openai',authentication:'api_key',model:'owner-model',confirmed:true});assert.equal(response.status,409);assert.equal(response.body.error,'USER_PLANNER_REQUIRED');assert.deepEqual(x.app.settings.value.planner1,before);assert.equal(x.calls(),0);
});
test('a saved local P1 selection has a separate authenticated capability check and remains free of cloud calls',async t=>{
 const hardware={totalMemoryMiB:32768,availableMemoryMiB:16384,cpuCores:8,platform:'win32',architecture:'x64',sampledAt:'2026-11-07T00:00:00.000Z'};
 let checks=0;
 const runtime={
  status:()=>({schema:'dream-maker.local-planner1-status.v1',planner1:{mode:'LOCAL_ONLY',endpoint:'http://127.0.0.1:11434/v1',model:null,cloudFallback:false,requestsOtherAccounts:false},hardware,models:[],recommendedModel:'qwen2.5:7b',otherRoles:[],projectDependencies:{status:'NOT_PREDETERMINED',note:'OFFLINE'},limits:[]}),
  check:async model=>{checks++;return{schema:'dream-maker.local-planner1-capability.v1',status:'PASSED',provider:'local',runner:'LOCAL_HTTP',authentication:'NONE',endpoint:'http://127.0.0.1:11434/v1',model,bindingHash:'',checkedAt:'2026-11-07T00:00:00.000Z',responseId:'local_response',responseHash:'a'.repeat(64),hardware};}
 };
 const x=await fixture(t,'dream-maker',runtime);
 assert.equal((await x.select({provider:'local',authentication:'none',model:'qwen2.5:7b',confirmed:true})).status,200);
 assert.equal((await x.select({provider:'local',authentication:'none',model:'qwen2.5:7b',confirmed:true})).status,200);
 const post=async(body,headers={})=>{const r=await fetch(x.app.origin+'/api/planner1/local/check',{method:'POST',headers:{cookie:x.cookie,'content-type':'application/json','x-csrf-token':x.csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 const rejected=await post({confirmed:false});assert.equal(rejected.status,403);assert.equal(checks,0);
 const passed=await post({confirmed:true});assert.equal(passed.status,200);assert.equal(passed.body.status,'PASSED');assert.equal(passed.body.bindingHash.length,64);assert.equal(checks,1);
 assert.equal(x.calls(),0);assert.equal(x.app.store.projects().length,0);assert.equal(x.app.store.runs().length,0);
});
test('local P1 Live project creation requires local consent and rejects an old API consent substitute',async t=>{
 const x=await fixture(t);
 assert.equal((await x.select({provider:'local',authentication:'none',model:'qwen2.5:7b',confirmed:true})).status,200);
 const create=async body=>{const r=await fetch(x.app.origin+'/api/projects',{method:'POST',headers:{cookie:x.cookie,'content-type':'application/json','x-csrf-token':x.csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({name:'本机方案',idea:'验证本机方案助手的独立同意',mode:'live',...body})});return{status:r.status,body:await r.json()};};
 const missing=await create({});assert.equal(missing.status,403);assert.equal(missing.body.error,'LOCAL_PLANNER1_CONSENT_REQUIRED');
 const substituted=await create({apiConsent:true});assert.equal(substituted.status,403);assert.equal(substituted.body.error,'LOCAL_PLANNER1_CONSENT_REQUIRED');
 const accepted=await create({localConsent:true});assert.equal(accepted.status,200);assert.equal(x.app.store.projects().length,1);assert.equal(x.calls(),0);
});
