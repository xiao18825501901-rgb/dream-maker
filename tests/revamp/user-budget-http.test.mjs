// Actual local HTTP + isolated accounting only. No native roles/provider calls or owner approval substitute.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {root} from '../helpers.mjs';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
async function setup(t,uncapped=false){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'user-budget-http-'));
 let budget,paidCalls=0;
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),product:'dreamflow',port:0,nativeOwnerBuilder:()=>{
  budget=new NativeBudget(resolve(data,'isolated-budget.sqlite'),{scopeId:'OFFLINE_HTTP_POLICY',authorizationHash:'OFFLINE_NOT_LIVE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2,...(uncapped?{mode:'UNCAPPED',uncappedApproval:{approvedAt:new Date().toISOString(),approvedBy:'USER',statement:'OFFLINE HTTP AUTHORITY ONLY',evidenceRef:'OFFLINE_NOT_LIVE',supersedes:[]}}:{})},()=>false);
  return {paidGuard:()=>{paidCalls++;throw Error('NO_NATIVE_CALLS');},assertReady(){throw Error('NO_NATIVE_CALLS');},executor(){throw Error('NO_NATIVE_CALLS');},async verify(){throw Error('NO_NATIVE_CALLS');},async close(){budget.close();},
   async probeStatus(){return {roles:{},evidence:{}};},budgetStatus(){return {status:'HISTORY_ONLY',mode:'CAPPED',requests:budget.requests().length,maxRequests:10,byCurrency:budget.summary().byCurrency,userBudget:budget.userBudgetStatus()};},
   configureUserBudget(...args){return budget.configureUserBudget(...args);}};
 }});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const call=async(path,body,extra={})=>{const response=await fetch(app.origin+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID(),...extra},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 return {app,call,budget,paidCalls:()=>paidCalls};
}

test('explicit unlimited HTTP selection is per currency, confirmed, append-only and visible after reading setup',async t=>{
 const {call,budget,paidCalls}=await setup(t,true),choice={limits:{CNY:'unlimited',USD:'0'},revision:0,confirmed:true};
 assert.equal((await call('/onboarding/budget',{...choice,confirmed:false})).status,403);
 assert.equal((await call('/onboarding/budget',{...choice,limits:{CNY:null,USD:'0'}})).status,400);
 const key=crypto.randomUUID(),saved=await call('/onboarding/budget',choice,{'idempotency-key':key});
 assert.equal(saved.status,200);assert.equal(saved.body.limits.CNY,null);assert.equal(saved.body.limits.USD,0);
 assert.equal(saved.body.unlimited,true);assert.equal(saved.body.byCurrency.CNY.remainingMicros,null);
 assert.deepEqual(await call('/onboarding/budget',choice,{'idempotency-key':key}),saved);
 const setupState=(await call('/onboarding')).body;assert.equal(setupState.fees.userBudget.unlimited,true);
 assert.equal(setupState.fees.userBudget.limits.CNY,null);assert.equal(setupState.fees.userBudget.limits.USD,0);
 assert.equal(budget.db.prepare('SELECT count(*) n FROM user_budget_limits').get().n,1);
 assert.equal(paidCalls(),0);assert.equal(budget.requests().length,0);
});
test('budget choice needs explicit local confirmation and preserves CSRF/actor/idempotency',async t=>{
 const {app,call,budget,paidCalls}=await setup(t),choice={limits:{CNY:'3.00',USD:'0'},revision:0,confirmed:true};
 assert.equal((await call('/onboarding/budget',{...choice,confirmed:false})).status,403);
 assert.equal((await call('/onboarding/budget',choice,{'x-csrf-token':'bad'})).status,403);
 assert.equal((await call('/onboarding/budget',{...choice,actor:'FORGED'})).status,400);assert.equal(budget.userBudgetStatus().configured,false);
 const key=crypto.randomUUID(),first=await call('/onboarding/budget',choice,{'idempotency-key':key});assert.equal(first.status,200);
 assert.equal(budget.userBudgetStatus().limits.CNY,3000000);assert.equal(budget.userBudgetStatus().limits.USD,0);
 const again=await call('/onboarding/budget',choice,{'idempotency-key':key});assert.deepEqual(again,first);
 assert.equal(budget.userBudgetStatus().revision,1);
 assert.equal((await call('/onboarding/budget',{...choice,limits:{CNY:'5',USD:'0'}},{'idempotency-key':key})).status,409);
 assert.equal((await call('/onboarding/budget',{...choice,limits:{CNY:'3.01',USD:'0'}})).body.error,'USER_BUDGET_REVISION_CONFLICT');
 const state=(await call('/onboarding')).body;assert.equal(state.fees.ordinaryUserDefault.configured,true);assert.equal(state.fees.ordinaryUserDefault.unlimited,false);
 assert.equal(state.fees.userBudget.limits.CNY,3000000);assert.equal(paidCalls(),0);assert.equal(budget.requests().length,0);
 assert.equal(app.store.projects().length,0);
});
test('setting an amount is wired to real reservation admission, not only a displayed flag',async t=>{
 const {call,budget}=await setup(t);assert.equal((await call('/onboarding/budget',{limits:{CNY:'3',USD:'0'},revision:0,confirmed:true})).status,200);
 const quote={provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
 const request=budget.reserve('executor',quote,128);budget.settle(request.id,null,'OFFLINE_FAILED');
 assert.throws(()=>budget.reserve('executor',quote,128),{code:'USER_BUDGET_LIMIT'});
 const state=(await call('/onboarding')).body;assert.equal(state.fees.userBudget.byCurrency.CNY.committedMicros,request.reservedMicros);
 assert.equal(state.fullFlowAcceptance,'NOT_RUN');
});
test('new imported Live projects freeze ordinary-user spending requirements in their immutable plan source',async t=>{
 const {app,call}=await setup(t),doc={schema:'dream-maker.user-plan.v1',name:'费用范围',mode:'live',plan:fixtureProjectPlan([{id:'R1',text:'保存自己的方案',origin:'USER',sources:['USER_DOCUMENT']}])};
 const created=await call('/user-plans',{document:doc});assert.equal(created.status,200);
 assert.equal(created.body.project.userSpendingRequired,true);assert.equal(app.store.planVersion(created.body.spec.id).source.userSpendingRequired,true);
 assert.equal(app.store.runs(created.body.project.id).length,0);assert.equal(app.store.approved(created.body.project.id,created.body.spec.hash,'BUILD'),false);
});
test('malformed amounts cannot activate accounting, and currencies never use float coercion or exchange rates',async t=>{
 const {call,budget}=await setup(t);
 for(const limits of [{CNY:3},{CNY:'-1'},{CNY:'1e3'},{CNY:'0.0000001'},{CNY:'1000001'},{CNY:'1',EUR:'1'},{USD:'1'}]){
  assert.equal((await call('/onboarding/budget',{limits,revision:0,confirmed:true})).status,400);assert.equal(budget.userBudgetStatus().configured,false);
 }
 const saved=await call('/onboarding/budget',{limits:{CNY:'0.000001'},revision:0,confirmed:true});assert.equal(saved.status,200);assert.equal(budget.userBudgetStatus().limits.CNY,1);assert.equal(budget.userBudgetStatus().limits.USD,0);
});
