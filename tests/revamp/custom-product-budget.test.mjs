// OFFLINE original ledger phases and callback authority, not model/role qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {join} from 'node:path';
import {harness} from '../helpers.mjs';import {NativeBudget} from '../../dist/server/native-budget.js';
const authority={scopeId:'OFFLINE_CUSTOM_PRODUCT',authorizationHash:'OFFLINE',totalMicros:1000000,probeMicros:1000000,warningMicros:900000,maxInFlight:1,maxRepairs:2};
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_NOT_BILLING',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:100,inputMissMicrosPerMillion:1000000,inputHitMicrosPerMillion:0,outputMicrosPerMillion:1000000});
const binding=()=>({schema:'dream-maker.native-request-binding.v1',projectId:'OFFLINE_PROJECT',runId:'OFFLINE_RUN',engineeringMode:'custom',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'OFFLINE_DISPATCH',generation:'OFFLINE_GENERATION',role:'executor',roleId:'execA',work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},bodyHash:'e'.repeat(64),routeHash:'f'.repeat(64)});
const caps=b=>({schema:'dream-maker.custom-request-budget.v1',projectId:b.projectId,runId:b.runId,configurationHash:b.configurationHash,roleId:b.roleId,flow:{currency:'CNY',maxMicros:1000000},role:{currency:'CNY',maxMicros:1000000}});
function rig(t,verify,patch={}){let budget;t.after(()=>budget?.close());const h=harness(t);budget=new NativeBudget(join(h.dir,'custom-product.sqlite'),{...authority,...patch},()=>false,undefined,'FULL_DM',caps,verify);return budget;}
test('qualified Custom product request uses its own proof callback in the original representative ledger',t=>{
 let calls=0;const budget=rig(t,b=>{calls++;assert.equal(b.engineeringMode,'custom');assert.equal(b.roleId,'execA');});budget.verifyReceipt=()=>true;budget.advance(Object.fromEntries(['planner1','planner2','executor','reviewer'].map(role=>[role,{evidenceId:'OFFLINE_'+role,model:'OFFLINE',source:'REAL_MODEL_RESPONSE'}])));budget.verifyReceipt=()=>false;
 const row=budget.reserve('executor',price(),128,undefined,binding());assert.equal(calls,1);assert.equal(row.binding.engineeringMode,'custom');assert.equal(row.usageStatus,'PENDING');assert.equal(budget.summary().phase,'REPRESENTATIVE');budget.settle(row.id,null,'OFFLINE_UNKNOWN');
 assert.throws(()=>budget.reserve('executor',price(),128),{code:'PROBE_EVIDENCE_UNVERIFIED'});assert.equal(calls,1);
});
test('Custom product budget metadata alone cannot authorize a model request',t=>{
 const budget=rig(t);assert.throws(()=>budget.reserve('executor',price(),128,undefined,binding()),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});assert.equal(budget.requests().length,0);
});
test('Custom product qualification callback must be exact synchronous authority',t=>{
 for(const verify of [()=>true,()=>Promise.resolve(),()=>Promise.reject(Error('OFFLINE_REJECTION'))]){const budget=rig(t,verify);
  assert.throws(()=>budget.reserve('executor',price(),128,undefined,binding()),{code:'CUSTOM_QUALIFICATION_RESULT_INVALID'});assert.equal(budget.requests().length,0);
 }
});
test('Custom product uses its qualified total budget without rewriting the shared Classic probe phase',t=>{
 const budget=rig(t,()=>{},{probeMicros:100});const row=budget.reserve('executor',price(),128,undefined,binding());assert.ok(row.reservedMicros>100);assert.equal(budget.summary().phase,'PROBE');budget.settle(row.id,null,'OFFLINE_UNKNOWN');
 assert.throws(()=>budget.reserve('executor',price(),128),{code:'PROBE_BUDGET_EXCEEDED'});
});
test('a pending Custom hold loses grant authority when original qualification changes',t=>{
 let ready=true;const budget=rig(t,()=>{if(!ready)throw Object.assign(Error('OFFLINE_STALE'),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});});const row=budget.reserve('executor',price(),128,undefined,binding());ready=false;
 assert.throws(()=>budget.pendingBoundRequest(row.id,binding()),{code:'CUSTOM_ROLE_QUALIFICATION_REQUIRED'});assert.equal(budget.requests()[0].usageStatus,'PENDING');budget.settle(row.id,null,'OFFLINE_UNKNOWN');assert.equal(budget.requests()[0].usageStatus,'UNKNOWN');
});
