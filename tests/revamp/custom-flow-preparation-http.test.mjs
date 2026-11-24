// Real localhost HTTP / original Engine and SQLite; selections are OFFLINE, not OAuth proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {root} from '../helpers.mjs';
function profile(){const role=(id,write=false)=>({id,provider:'github',authentication:'oauth',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',runtime:'copilot-sdk',model:{kind:'model',id:'OFFLINE_MODEL'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});return{mode:'custom',laya:false,accounts:[{provider:'github',authentication:'oauth',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('executor-1',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:1000000},timeZone:'Asia/Shanghai'};}

test('both products prepare the confirmed Custom selection through original auth without granting a run',{timeout:40000},async()=>{
 for(const product of ['dream-maker','dreamflow']){
  const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'custom-preparation-http-'));let models=0;
  const app=await createApp({root,data,configPath:join(data,'config.json'),product,port:0,paidRequestGuard:()=>{models++;throw Error('NO_MODEL_ALLOWED');}});
  try{
   const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
   const call=async(path,body,headers={})=>{const response=await fetch(app.origin+'/api'+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
   const p=app.interviews.create('Custom离线准备','仅检查方案与设置的冻结，不调用模型。','demo');await app.interviews.finish(p.id,'',false);const s=app.store.spec(app.store.project(p.id).specId);app.interviews.approve(p.id,s.hash);
   const selection=await call(`/projects/${p.id}/flow-profile`,{configuration:profile(),expectedRevision:0,confirmed:true});assert.equal(selection.status,200);
   const path=`/projects/${p.id}/flow-preparation`,input={specHash:s.hash,profileHash:selection.body.current.contentHash};
   const anonymous=await fetch(app.origin+'/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});assert.equal(anonymous.status,401);
   assert.equal((await call(path,input,{'x-csrf-token':'wrong'})).status,403);assert.equal((await call(path,{...input,verified:true})).status,400);
   const key=crypto.randomUUID(),first=await call(path,input,{'idempotency-key':key});assert.equal(first.status,200);assert.equal(first.body.executionGranted,false);assert.equal(first.body.preparation.flowConfig.schema,'dream-maker.flow-config.v2');assert.equal(first.body.preparation.flowConfig.qualification,'NOT_VERIFIED');assert.equal(first.body.preparation.scope,'CONFIGURATION_PREPARATION_ONLY');
   assert.deepEqual((await call(path,input,{'idempotency-key':key})).body,first.body);assert.equal(app.store.records(p.id,'CustomFlowPrepared').length,1);
   app.settings.value.limits.maxCalls+=1;
   assert.equal((await call(path,input,{'idempotency-key':key})).status,409,'the same request cannot silently freeze changed engineering inputs');assert.equal(app.store.records(p.id,'CustomFlowPrepared').length,1);
   const fresh=await call(path,input);assert.equal(fresh.status,200);assert.notEqual(fresh.body.preparation.flowConfig.runId,first.body.preparation.flowConfig.runId);assert.equal(app.store.records(p.id,'CustomFlowPrepared').length,2);
   const next=profile();next.roles.executors[0].model.id='OFFLINE_NEXT_MODEL';assert.equal((await call(`/projects/${p.id}/flow-profile`,{configuration:next,expectedRevision:1,confirmed:true})).status,200);
   assert.equal((await call(path,input,{'idempotency-key':key})).status,409,'replay must recheck the actual current profile');
   assert.equal(app.store.runs(p.id).length,0);assert.equal(app.store.approved(p.id,s.hash,'BUILD'),false);assert.equal(app.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);assert.equal(app.engine.activeJobCount,0);assert.equal(models,0);
  }finally{await app.close();rmSync(data,{recursive:true,force:true});}
 }
});
