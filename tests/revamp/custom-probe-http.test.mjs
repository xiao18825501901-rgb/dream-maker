// Real localhost HTTP/Engine with an OFFLINE factory. Not model or role acceptance.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';import {root} from '../helpers.mjs';import {hash} from '../../dist/server/security.js';
test('Custom qualification HTTP requires auth/CSRF/consent/exact fields and replays original Engine operation',{timeout:40000},async()=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'custom-probe-http-'));let calls=0;
 const receipts=new Map(),receipt={evidenceId:'OFFLINE_RECEIPT',role:'planner2',roleId:'planner2',model:'deepseek-flash',source:'REAL_MODEL_RESPONSE'};
 const native={assertReady(){throw Error('NO_CLASSIC');},executor(){throw Error('NO_PROJECT');},verify(){throw Error('NO_PROJECT');},async close(){},
 customProbePreparation:()=>({role:'planner2',roleId:'planner2',bindingHash:hash('OFFLINE_BINDING'),configurationHash:hash('OFFLINE_CONFIG'),expiresAt:'2030-01-01T00:00:00Z'}),async prepareCustomProbeEvidence(){},
 async executeCustomRoleProbe(){calls++;return{attemptId:'OFFLINE',bindingHash:hash('OFFLINE_BINDING'),observation:{}};},completeCustomRoleProbe:input=>{const value={...receipt,evidenceId:'OFFLINE_RECEIPT_'+calls,probeId:input.probeId};Object.assign(receipt,value);receipts.set(value.evidenceId,value);return value;},customProbeReceipt:(s,role,id)=>receipts.get(id)};
 const app=await createApp({root,data,configPath:join(data,'config.json'),port:0,nativeExecution:native});app.engine.dispatch.binding.measure=()=>({cpu:4,memoryMiB:8192,availableMemoryMiB:8192,sampledAt:new Date().toISOString()});
 try{
  const path=app.origin+'/api/projects/OFFLINE_PROJECT/flow-role-probe',input={specHash:hash('OFFLINE_SPEC'),profileHash:hash('OFFLINE_PROFILE'),preparation:{identityHash:hash('OFFLINE_ID'),contentHash:hash('OFFLINE_PREP')},roleId:'planner2',confirmed:true};
  assert.equal((await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,401);
  const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
  const call=async(body,extra={})=>{const response=await fetch(path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
  assert.equal((await call(input,{'x-csrf-token':'wrong'})).status,403);assert.equal((await call({...input,confirmed:false})).status,403);assert.equal((await call({...input,verified:true})).status,400);assert.equal(calls,0);
  const key=crypto.randomUUID(),first=await call(input,{'idempotency-key':key});assert.equal(first.status,200);assert.deepEqual(first.body,{scope:'MINIMUM_ROLE_ONLY',receipt,executionGranted:false,fourRoleLive:'NOT_RUN'});
  assert.deepEqual((await call(input,{'idempotency-key':key})).body,first.body);assert.equal(calls,1);
  assert.equal((await call({...input,roleId:'reviewer'},{'idempotency-key':key})).status,409);assert.equal(calls,1);
  const statusPath=app.origin+'/api/projects/OFFLINE_PROJECT/flow-role-status',readInput={...input};delete readInput.confirmed;
  assert.equal((await fetch(statusPath,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(readInput)})).status,401);
  const read=async(body,headers={})=>{const response=await fetch(statusPath,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...headers},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
  const before=app.store.db.prepare('SELECT count(*) n FROM records').get().n;
  assert.equal((await read(readInput,{'x-csrf-token':'wrong'})).status,403);assert.equal((await read({...readInput,verified:true})).status,400);
  assert.equal((await read(readInput)).body.status,'PASSED_MINIMUM');assert.equal(app.store.db.prepare('SELECT count(*) n FROM records').get().n,before);assert.equal(calls,1);
  const requestId=crypto.randomUUID();assert.equal((await read({...readInput,requestId})).body.status,'NOT_RUN');
  assert.equal((await call({...input,requestId})).status,200);assert.equal(calls,2);
  assert.equal((await call({...input,requestId})).status,200);assert.equal(calls,2);
  assert.equal((await read({...readInput,requestId})).body.status,'PASSED_MINIMUM');assert.equal(calls,2);
  assert.equal((await read({...readInput,requestId:'not-an-id'})).status,400);
  assert.equal(app.store.runs().length,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
 }finally{await app.close();rmSync(data,{recursive:true,force:true});}
});
