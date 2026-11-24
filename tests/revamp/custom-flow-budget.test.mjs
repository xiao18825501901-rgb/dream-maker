// OFFLINE original SQLite ledger only; no provider calls or role qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {join} from 'node:path';
import {NativeBudget} from '../../dist/server/native-budget.js';import {harness} from '../helpers.mjs';
const authority={scopeId:'OFFLINE_CUSTOM_CAPS',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_NOT_A_QUOTE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:100,inputMissMicrosPerMillion:1000000,inputHitMicrosPerMillion:0,outputMicrosPerMillion:1000000});
const scope=(roleId='worker-one')=>({schema:'dream-maker.native-request-binding.v1',projectId:'offline_project',runId:'offline_run',engineeringMode:'custom',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',generation:'offline_owner',role:'executor',roleId,work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},bodyHash:'e'.repeat(64),routeHash:'f'.repeat(64)});
const caps=(binding,flowMax=300,roleMax=200)=>({schema:'dream-maker.custom-request-budget.v1',projectId:binding.projectId,runId:binding.runId,configurationHash:binding.configurationHash,roleId:binding.roleId,flow:{currency:'CNY',maxMicros:flowMax},role:{currency:'CNY',maxMicros:roleMax}});
function fixture(t,resolver=b=>caps(b),authorization=authority){
 let active;t.after(()=>active?.close());const h=harness(t),path=join(h.dir,'custom-caps.sqlite');
 const open=()=>active=new NativeBudget(path,authorization,()=>false,undefined,'FULL_DM',resolver,()=>{});
 return{budget:open(),reopen(){active.close();return open();},path};
}
const reserve=(b,binding=scope(),p=price())=>b.reserve('executor',p,100,undefined,binding);
test('Custom without a controller budget source fails before inserting any request',t=>{
 const {budget}=fixture(t,null);assert.throws(()=>reserve(budget),{code:'CUSTOM_BUDGET_CONTEXT_REQUIRED'});assert.equal(budget.requests().length,0);
});
test('role cost limit includes UNKNOWN costs across new dispatches without borrowing another actor cap',t=>{
 const {budget}=fixture(t),first=reserve(budget);budget.settle(first.id,null,'DISCONNECTED');
 assert.throws(()=>reserve(budget,{...scope(),dispatchId:'offline_retry'}),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});assert.equal(budget.requests().length,1);
 const row=budget.requests()[0];assert.deepEqual(row.customBudget,caps(scope()));assert.equal(row.chargedMicros,200);
});
test('flow cost limit includes every actor and refuses before the next request',t=>{
 const {budget}=fixture(t,b=>caps(b,300,300)),first=reserve(budget);budget.settle(first.id,null,'FAILED');
 assert.throws(()=>reserve(budget,scope('worker-two')),{code:'CUSTOM_FLOW_BUDGET_EXCEEDED'});assert.equal(budget.requests().length,1);
});
test('confirmed known usage releases only unused reservation and permits an exact remaining role cap',t=>{
 const {budget}=fixture(t,b=>caps(b,1000,250)),first=reserve(budget);budget.settle(first.id,{inputTokens:25,outputTokens:25,cacheHitTokens:0},'COMPLETE');
 const second=reserve(budget);assert.equal(second.reservedMicros,200);budget.settle(second.id,null,'FAILED');
 assert.throws(()=>reserve(budget),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});assert.equal(budget.requests().length,2);
});
test('pending requests remain reserved and restart cannot erase their role cost',t=>{
 const f=fixture(t),first=reserve(f.budget);assert.throws(()=>reserve(f.budget),{code:'NATIVE_REQUEST_ALREADY_IN_FLIGHT'});
 const b=f.reopen();assert.equal(b.requests()[0].id,first.id);assert.equal(b.requests()[0].usageStatus,'UNKNOWN');assert.equal(b.requests()[0].chargedMicros,200);
 assert.throws(()=>reserve(b),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});
});
test('different quote currencies cannot be combined or silently converted',t=>{
 const {budget}=fixture(t);assert.throws(()=>reserve(budget,scope(),{...price(),currency:'USD'}),{code:'CUSTOM_BUDGET_CURRENCY_MISMATCH'});assert.equal(budget.requests().length,0);
});
test('invalid, cross-run or privileged resolver data cannot lift a configured limit',t=>{
 for(const change of [c=>({...c,runId:'another_run'}),c=>({...c,roleId:'another_actor'}),c=>({...c,flow:{currency:'CNY',maxMicros:Infinity}}),c=>({...c,role:{currency:'USD',maxMicros:200}}),c=>({...c,approved:true})]){
  const {budget}=fixture(t,b=>change(caps(b)));assert.throws(()=>reserve(budget),{code:'CUSTOM_BUDGET_CONTEXT_INVALID'});assert.equal(budget.requests().length,0);
 }
});
test('a changed frozen configuration cannot reset same-run cost history',t=>{
 const {budget}=fixture(t,b=>caps(b,1000,1000)),first=reserve(budget);budget.settle(first.id,null,'FAILED');
 assert.throws(()=>reserve(budget,{...scope(),configurationHash:'9'.repeat(64)}),{code:'CUSTOM_BUDGET_HISTORY_MISMATCH'});assert.equal(budget.requests().length,1);
});
test('Classic and old unbound request JSON remain unchanged by Custom-only policy',t=>{
 const {budget}=fixture(t,null),classic={...scope(),engineeringMode:'classic'};const first=reserve(budget,classic);assert.equal('customBudget' in first,false);budget.settle(first.id,null,'FAILED');
 const second=budget.reserve('executor',price(),100);assert.equal('binding' in second,false);assert.equal('customBudget' in second,false);
});
test('changing model routes and repair rounds cannot reset one actor cost',t=>{
 const {budget}=fixture(t),first=reserve(budget);budget.settle(first.id,null,'FAILED');budget.repair(scope().runId);
 const repaired={...scope(),dispatchId:'offline_repair',routeHash:'0'.repeat(64),work:{kind:'REPAIR',round:1,inputHash:'1'.repeat(64)}};
 assert.throws(()=>reserve(budget,repaired),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});assert.equal(budget.requests().length,1);
});
test('a controller selection is copied before the hold and does not alias persisted caps',t=>{
 let current;const {budget}=fixture(t,b=>current=caps(b)),first=reserve(budget);current.role.maxMicros=1000;first.customBudget.flow.maxMicros=9999;
 assert.deepEqual(budget.requests()[0].customBudget,caps(scope()));budget.settle(first.id,null,'FAILED');
 assert.throws(()=>reserve(budget),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});
});
test('an uncapped development authority cannot disable the narrower Custom user cap',t=>{
 const authorization={...authority,mode:'UNCAPPED',uncappedApproval:{approvedAt:new Date().toISOString(),approvedBy:'USER',statement:'OFFLINE uncapped fixture, not actual authorization',evidenceRef:'OFFLINE_ONLY',supersedes:[]}};
 const {budget}=fixture(t,b=>caps(b,0,0),authorization);assert.throws(()=>reserve(budget),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});assert.equal(budget.requests().length,0);
});
test('a pending hold cannot obtain a router grant after its frozen budget source becomes stale',t=>{
 let stale=false;const {budget}=fixture(t,b=>{if(stale)throw Object.assign(Error('OFFLINE_STALE'),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});return caps(b);}),binding=scope(),row=reserve(budget,binding);stale=true;
 assert.throws(()=>budget.pendingBoundRequest(row.id,binding),{code:'CUSTOM_BUDGET_CONTEXT_STALE'});assert.equal(budget.requests()[0].routerAdmission,undefined);assert.equal(budget.requests()[0].usageStatus,'PENDING');
});
test('a pending hold cannot use a changed cap source even when its attribution still matches',t=>{
 let roleMax=200;const {budget}=fixture(t,b=>caps(b,300,roleMax)),binding=scope(),row=reserve(budget,binding);roleMax=300;
 assert.throws(()=>budget.pendingBoundRequest(row.id,binding),{code:'CUSTOM_BUDGET_HISTORY_MISMATCH'});assert.deepEqual(budget.requests()[0].customBudget,caps(binding));
});
