// Read-only localhost setup status. Fake account observations here are not native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../../dist/server/http.js';
import { defaults } from '../../dist/server/config.js';
import { root } from '../helpers.mjs';
async function setup(t,product='dream-maker',probe={roles:{},evidence:{}}){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'setup-read-'));
 const c=structuredClone(defaults);c.dsh.keyEnv='DM_ONBOARDING_TEST_KEY';c.codex.model='configured-codex';
 const old=process.env.DM_ONBOARDING_TEST_KEY;process.env.DM_ONBOARDING_TEST_KEY='OFFLINE_CREDENTIAL_MUST_NOT_LEAVE';writeFileSync(resolve(data,'config.json'),JSON.stringify(c));
 let dispatches=0;
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),product,port:0,nativeOwnerBuilder:()=>({
  paidGuard:()=>{dispatches++;throw Error('NO_MODEL_ALLOWED');},assertReady(){throw Error('NO_MODEL_ALLOWED');},executor(){throw Error('NO_MODEL_ALLOWED');},async close(){},
  async probeStatus(){return probe;},budgetStatus(){return {status:'HISTORY_ONLY',mode:'UNCAPPED',requests:2,maxRequests:10,byCurrency:{CNY:{committedMicros:1230000},USD:{committedMicros:2000}},ordinaryUserDefault:{configured:false,unlimited:false,automaticRecharge:false,extraUsage:false}};}
 })});
 t.after(async()=>{await app.close();if(old===undefined)delete process.env.DM_ONBOARDING_TEST_KEY;else process.env.DM_ONBOARDING_TEST_KEY=old;rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0];
 return {app,data,read:()=>fetch(app.origin+'/api/onboarding',{headers:{cookie}}),dispatches:()=>dispatches};
}
test('first-use status is authenticated and opening it neither calls models nor writes setup acceptance',async t=>{
 const {app,data,read,dispatches}=await setup(t),before=app.store.db.prepare('SELECT count(*) n FROM records').get().n;
 assert.equal((await fetch(app.origin+'/api/onboarding')).status,401);
 const response=await read();assert.equal(response.status,200);const state=await response.json();
 assert.equal(state.product,'dream-maker');assert.equal(state.automaticActions,false);assert.equal(state.modelCalls,0);assert.equal(state.fullFlowAcceptance,'NOT_RUN');
 assert.equal(state.roles.find(r=>r.role==='executor').authentication.state,'CONFIGURED_UNVERIFIED');
 assert.equal(state.roles.find(r=>r.role==='executor').inference.state,'UNKNOWN');
 assert.equal(state.fees.ordinaryUserDefault.unlimited,false);assert.equal(state.fees.ordinaryUserDefault.automaticRecharge,false);assert.equal(state.fees.existingScope.mode,'UNCAPPED');
 const raw=JSON.stringify(state);for(const secret of ['OFFLINE_CREDENTIAL_MUST_NOT_LEAVE',data,'DM_ONBOARDING_TEST_KEY',app.bootstrap])assert.ok(!raw.includes(secret));
 await read();assert.equal(dispatches(),0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM records').get().n,before);
});
test('standalone setup requires engineering roles and never asks for a Kimi/P1 account',async t=>{
 const {read}=await setup(t,'dreamflow'),response=await read();assert.equal(response.status,200);const state=await response.json();
 const p1=state.roles.find(r=>r.role==='planner1');assert.equal(p1.required,false);assert.equal(p1.runner,'USER');assert.equal(p1.targetModel,null);assert.equal(p1.authentication.state,'NOT_REQUIRED');
 assert.deepEqual(state.requiredRoles,['planner2','executor','reviewer']);assert.equal(state.roles.find(r=>r.role==='planner2').runner,'CODEX');
 assert.equal(state.optionalLaya.required,false);assert.equal(state.optionalLaya.availableToChoose,true);
});
test('a stale or different actual model is never filled in from the configured model or read as ready',async t=>{
 const probe={roles:{planner2:{valid:true}},evidence:{planner2:{model:'other-model',runner:'CODEX',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',at:new Date().toISOString(),evidenceId:'OFFLINE_NOT_LIVE'}}};
 const {read}=await setup(t,'dreamflow',probe),response=await read();assert.equal(response.status,200);const state=await response.json(),p2=state.roles.find(r=>r.role==='planner2');
 assert.equal(p2.targetModel,'configured-codex');assert.equal(p2.actualModel,'other-model');assert.equal(p2.inference.state,'BLOCKED');
 assert.equal(state.fullFlowAcceptance,'NOT_RUN');
});
test('malformed setup evidence cannot leak a credential through an actual-model field',async t=>{
 const probe={roles:{planner2:{valid:true}},evidence:{planner2:{model:'OFFLINE_CREDENTIAL_MUST_NOT_LEAVE',runner:'CODEX',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION'}}};
 const {read}=await setup(t,'dreamflow',probe),response=await read();assert.equal(response.status,200);const state=await response.json();
 assert.equal(state.roles.find(r=>r.role==='planner2').actualModel,null);assert.ok(!JSON.stringify(state).includes('OFFLINE_CREDENTIAL_MUST_NOT_LEAVE'));
});
