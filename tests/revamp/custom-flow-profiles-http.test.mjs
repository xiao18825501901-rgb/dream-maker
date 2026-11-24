// Real localhost HTTP and original SQLite; selected reference strings are OFFLINE, not login proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {root} from '../helpers.mjs';
function profile(){
 const role=(id,write=false)=>({id,provider:'github',authentication:'oauth',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',runtime:'copilot-sdk',model:{kind:'model',id:'OFFLINE_MODEL'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 return {mode:'custom',laya:false,accounts:[{provider:'github',authentication:'oauth',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT'}],roles:{planner2:role('planner2'),executors:[role('executor-1',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:1000000},timeZone:'Asia/Shanghai'};
}
function groupProfileWithoutMember(){
 const value=profile();
 value.roles.planner2.model={kind:'group',id:'OFFLINE_GROUP'};
 value.groups=[{id:'OFFLINE_GROUP',strategy:'failure_only',members:[{id:'OFFLINE_MEMBER',provider:'github',model:'OFFLINE_MODEL',authRef:'OFFLINE_AUTH',accountRef:'OFFLINE_ACCOUNT',permissions:['source_read']}]}];
 return value;
}
test('both products persist Custom configuration through authenticated CAS without starting Engine or trusting gateway flags',{timeout:30000},async t=>{
 for(const product of ['dream-maker','dreamflow']){
  const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'custom-profile-http-'));
  const app=await createApp({root,data,configPath:join(data,'config.json'),product,port:0,paidRequestGuard:()=>{throw Error('NO_MODEL_ALLOWED');}});
  try{
   const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
   const call=async(path,body,headers={})=>{const r=await fetch(app.origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
   const p=app.interviews.create('自定义配置离线测试','用户自带方案配置测试，不调用模型。','demo');
   const path=`/projects/${p.id}/flow-profile`,input={configuration:profile(),expectedRevision:0,confirmed:true};
   assert.equal((await call(path)).body.current,null);assert.equal((await call(path,input,{'x-csrf-token':'wrong'})).status,403);
   const anonymous=await fetch(app.origin+'/api'+path);assert.equal(anonymous.status,401);
   const forged=await call(path,{...input,verified:true});assert.equal(forged.status,400);
   const key=crypto.randomUUID(),saved=await call(path,input,{'idempotency-key':key});assert.equal(saved.status,200);assert.equal(saved.body.current.revision,1);assert.equal(saved.body.current.serviceIdentity,'NOT_VERIFIED');assert.equal(saved.body.current.executionGranted,false);
   assert.deepEqual((await call(path,input,{'idempotency-key':key})).body,saved.body);
   const changed=structuredClone(input);changed.configuration.roles.planner2.model.id='ANOTHER_OFFLINE_MODEL';assert.equal((await call(path,changed)).status,409);assert.equal((await call(path,changed,{'idempotency-key':key})).status,409);
   assert.equal(app.store.runs(p.id).length,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
  }finally{await app.close();rmSync(data,{recursive:true,force:true});}
 }
});
test('HTTP rejects a Custom group role without an explicit starting member and writes no configuration',{timeout:30000},async()=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'custom-profile-group-http-'));
 const app=await createApp({root,data,configPath:join(data,'config.json'),product:'dream-maker',port:0,paidRequestGuard:()=>{throw Error('NO_MODEL_ALLOWED');}});
 try{
  const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
  const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const p=app.interviews.create('Custom 组成员负向测试','不调用模型。','demo');
  const response=await fetch(`${app.origin}/api/projects/${p.id}/flow-profile`,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({configuration:groupProfileWithoutMember(),expectedRevision:0,confirmed:true})});
  const body=await response.json();
  assert.equal(response.status,400);assert.equal(body.error,'FLOW_PROFILE_GROUP_SCOPE_INVALID');
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM engineering_profiles WHERE project_id=?').get(p.id).n,0);
  assert.equal(app.store.runs(p.id).length,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
 }finally{await app.close();rmSync(data,{recursive:true,force:true});}
});
