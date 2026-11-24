// OFFLINE original ledger; no real key, provider, run, model or receipt qualification.
import test from 'node:test';import assert from 'node:assert/strict';import {join} from 'node:path';
import {NativeBudget} from '../../dist/server/native-budget.js';import {harness} from '../helpers.mjs';
const authority={scopeId:'OFFLINE_CUSTOM_PROBE',authorizationHash:'OFFLINE_AUTHORITY',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_NOT_A_QUOTE',expiresAt:new Date(Date.now()+3600000).toISOString(),maxInputTokens:100,inputMissMicrosPerMillion:1000000,inputHitMicrosPerMillion:0,outputMicrosPerMillion:1000000});
const context=(patch={})=>({schema:'dream-maker.custom-probe-budget.v1',probeId:'custom_probe_OFFLINE_A',bindingHash:'1'.repeat(64),projectId:'offline_project',runId:'offline_candidate_run',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),role:'planner2',roleId:'planner2',dispatchId:'offline_dispatch',generation:'offline_owner',routeHash:'f'.repeat(64),flowBudget:{currency:'CNY',maxMicros:1000},roleBudget:{currency:'CNY',maxMicros:600},...patch});
const binding=c=>({schema:'dream-maker.native-request-binding.v1',projectId:c.projectId,runId:c.runId,engineeringMode:'custom',configurationHash:c.configurationHash,planVersionHash:c.planVersionHash,specHash:c.specHash,dispatchId:c.dispatchId,generation:c.generation,role:c.role,roleId:c.roleId,work:{kind:'QUALIFICATION',probeId:c.probeId,bindingHash:c.bindingHash},bodyHash:'e'.repeat(64),routeHash:c.routeHash});
function fixture(t,representative=true){let active;t.after(()=>active?.close());const h=harness(t),path=join(h.dir,'budget.sqlite'),caps=b=>({schema:'dream-maker.custom-request-budget.v1',projectId:b.projectId,runId:b.runId,configurationHash:b.configurationHash,roleId:b.roleId,flow:{currency:'CNY',maxMicros:1000},role:{currency:'CNY',maxMicros:350}}),open=()=>active=new NativeBudget(path,authority,()=>false,undefined,'FULL_DM',caps,()=>{}),budget=open();if(representative){budget.verifyReceipt=()=>true;budget.advance(Object.fromEntries(['planner1','planner2','executor','reviewer'].map(role=>[role,{evidenceId:'OFFLINE_'+role,model:'OFFLINE',source:'REAL_MODEL_RESPONSE'}])));budget.verifyReceipt=()=>false;}return{budget,reopen(){active.close();return open();}};}
test('Custom opaque probe spends in the original ledger without borrowing or advancing Classic qualification',t=>{
 const {budget:b}=fixture(t),c=context();assert.equal(typeof b.beginCustomProbe,'function');assert.throws(()=>b.reserve('planner2',price(),100),{code:'PROBE_EVIDENCE_UNVERIFIED'});
 const permit=b.beginCustomProbe(c),row=b.reserveCustomProbe(permit,price(),100,binding(c));assert.deepEqual(row.customProbe,c);assert.equal(row.role,'planner2');assert.equal(row.binding.work.kind,'QUALIFICATION');assert.equal(b.summary().phase,'REPRESENTATIVE');b.settle(row.id,null,'COMPLETE');b.endCustomProbe(permit);assert.equal(b.requests().length,1);
 assert.throws(()=>b.reserve('planner2',price(),100),{code:'PROBE_EVIDENCE_UNVERIFIED'});assert.throws(()=>b.reserveCustomProbe(permit,price(),100,binding(c)),{code:'CUSTOM_PROBE_PERMIT_INVALID'});
});
test('probe permits reject copied objects, Classic permits and drifted role, dispatch or route before insertion',t=>{
 const {budget:b}=fixture(t),c=context();assert.equal(typeof b.beginCustomProbe,'function');const permit=b.beginCustomProbe(c),classic=b.beginEvidenceRepair('planner2');
 for(const bad of [{},{...permit},classic])assert.throws(()=>b.reserveCustomProbe(bad,price(),100,binding(c)),{code:'CUSTOM_PROBE_PERMIT_INVALID'});
 for(const patch of [{role:'reviewer',roleId:'reviewer'},{dispatchId:'foreign'},{routeHash:'d'.repeat(64)},{configurationHash:'d'.repeat(64)}])assert.throws(()=>b.reserveCustomProbe(permit,price(),100,{...binding(c),...patch}),{code:'CUSTOM_PROBE_BINDING_MISMATCH'});
 assert.throws(()=>b.reserve('planner2',price(),100,classic,binding(c)),{code:'CUSTOM_PROBE_PERMIT_REQUIRED'});assert.equal(b.requests().length,0);b.endEvidenceRepair(classic);
});
test('one physical probe identity cannot be replayed after failure or controller restart',t=>{
 const x=fixture(t),c=context();assert.equal(typeof x.budget.beginCustomProbe,'function');let permit=x.budget.beginCustomProbe(c),row=x.budget.reserveCustomProbe(permit,price(),100,binding(c));
 x.budget.settle(row.id,null,'TRANSPORT_UNKNOWN');assert.throws(()=>x.budget.reserveCustomProbe(permit,price(),100,binding(c)),{code:'CUSTOM_PROBE_ID_REUSED'});x.budget.endCustomProbe(permit);const b=x.reopen();assert.throws(()=>b.beginCustomProbe(c),{code:'CUSTOM_PROBE_ID_REUSED'});assert.equal(b.requests()[0].chargedMicros,200);
 for(let i=1;i<3;i++){const next=context({probeId:'custom_probe_OFFLINE_'+i});permit=b.beginCustomProbe(next);row=b.reserveCustomProbe(permit,price(),100,binding(next));b.settle(row.id,null,'TRANSPORT_UNKNOWN');b.endCustomProbe(permit);}
 assert.throws(()=>b.beginCustomProbe(context({probeId:'custom_probe_OFFLINE_4'})),{code:'CUSTOM_PROBE_ATTEMPT_LIMIT'});assert.equal(b.requests().length,3);
});
test('probe uses immutable configured caps and rejects unsupported billed route',t=>{
 const {budget:b}=fixture(t),c=context();assert.equal(typeof b.beginCustomProbe,'function');const permit=b.beginCustomProbe(c);c.roleBudget.maxMicros=0;
 for(const patch of [{provider:'other'},{model:'other'},{currency:'USD'}])assert.throws(()=>b.reserveCustomProbe(permit,{...price(),...patch},100,binding(c)),{code:'CUSTOM_PROBE_PRICE_ROUTE_INVALID'});
 const row=b.reserveCustomProbe(permit,price(),100,binding(c));assert.equal(row.customProbe.roleBudget.maxMicros,600);b.settle(row.id,null,'COMPLETE');assert.equal(b.requests().length,1);
});
test('string Claude quote is bound to the exact reviewer route and permit',async t=>{
 const {magpieRouteHash}=await import('../../dist/server/magpie-route.js');
 const route={provider:'string',runtime:'claude',protocol:'anthropic-messages',authentication:'api_key',model:'claude-sonnet-5',authRef:'offline',accountRef:'one',upstreamAccountRef:'string/one'};
 const c=context({role:'reviewer',roleId:'reviewer',routeHash:magpieRouteHash(route)}),b=fixture(t).budget,p=b.beginCustomProbe(c);
 const q={...price(),provider:route.provider,model:route.model};
 for(const [quote,selected] of [[q,undefined],[q,{...route,authRef:'other'}],[{...q,provider:'deepseek-official'},route],[{...q,currency:'USD'},route]]){
  assert.throws(()=>b.reserveCustomProbe(p,quote,100,binding(c),route.model,selected),{code:'CUSTOM_PROBE_PRICE_ROUTE_INVALID'});
 }
 assert.equal(b.requests().length,0);
 const row=b.reserveCustomProbe(p,q,100,binding(c),route.model,route);assert.equal(row.price.provider,'string');b.settle(row.id,null,'COMPLETE');
});
test('probe unknown spend reduces the subsequent product role budget in the same frozen Flow',t=>{
 const {budget:b}=fixture(t,false),c=context({role:'executor',roleId:'worker-one',roleBudget:{currency:'CNY',maxMicros:350}});assert.equal(typeof b.beginCustomProbe,'function');const p=b.beginCustomProbe(c),row=b.reserveCustomProbe(p,price(),100,binding(c));b.settle(row.id,null,'UNKNOWN');b.endCustomProbe(p);
 const product={...binding(c),work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null}};assert.throws(()=>b.reserve('executor',price(),100,undefined,product),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});assert.equal(b.requests().length,1);
});
test('pre-existing product spend reduces a later probe budget too',t=>{
 const {budget:b}=fixture(t,false),c=context({role:'executor',roleId:'worker-one',roleBudget:{currency:'CNY',maxMicros:350}});assert.equal(typeof b.beginCustomProbe,'function');const product={...binding(c),work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null}},row=b.reserve('executor',price(),100,undefined,product);b.settle(row.id,null,'UNKNOWN');
 const p=b.beginCustomProbe(c);assert.throws(()=>b.reserveCustomProbe(p,price(),100,binding(c)),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});assert.equal(b.requests().length,1);
});
test('permit expiry, cross-controller use and revocation stop a pending Magpie grant',t=>{
 const {budget:b}=fixture(t),other=fixture(t).budget,c=context();let clock=1000;b.customProbeClock=()=>clock;const p=b.beginCustomProbe(c);
 assert.throws(()=>other.reserveCustomProbe(p,price(),100,binding(c)),{code:'CUSTOM_PROBE_PERMIT_INVALID'});
 clock+=120001;assert.throws(()=>b.reserveCustomProbe(p,price(),100,binding(c)),{code:'CUSTOM_PROBE_PERMIT_EXPIRED'});clock=1000;
 const row=b.reserveCustomProbe(p,price(),100,binding(c));assert.equal(b.pendingBoundRequest(row.id,binding(c)).id,row.id);b.endCustomProbe(p);assert.throws(()=>b.pendingBoundRequest(row.id,binding(c)),{code:'CUSTOM_PROBE_PERMIT_INVALID'});b.settle(row.id,null,'UNKNOWN_AFTER_REVOKE');assert.equal(b.requests()[0].chargedMicros,200);
});
test('global user cap, immutable role cap and original serial dispatch limit still precede each probe request',t=>{
 const {budget:b}=fixture(t),c=context(),p=b.beginCustomProbe(c);b.configureUserBudget({CNY:0,USD:0},0,'local-session:'+'a'.repeat(64),'OFFLINE_ZERO_BUDGET');
 assert.throws(()=>b.reserveCustomProbe(p,price(),100,binding(c)),{code:'USER_BUDGET_CURRENCY_DISABLED'});assert.equal(b.requests().length,0);
 const second=fixture(t).budget,zero=context({roleBudget:{currency:'CNY',maxMicros:0}}),z=second.beginCustomProbe(zero);assert.throws(()=>second.reserveCustomProbe(z,price(),100,binding(zero)),{code:'CUSTOM_ROLE_BUDGET_EXCEEDED'});assert.equal(second.requests().length,0);
 const valid=second.beginCustomProbe(context({probeId:'custom_probe_VALID'})),row=second.reserveCustomProbe(valid,price(),100,binding(context({probeId:'custom_probe_VALID'}))),next=context({probeId:'custom_probe_SECOND'}),n=second.beginCustomProbe(next);assert.throws(()=>second.reserveCustomProbe(n,price(),100,binding(next)),{code:'NATIVE_REQUEST_ALREADY_IN_FLIGHT'});second.settle(row.id,null,'UNKNOWN');
});
test('new probe permits do not accept getters or claim a Classic request purpose',t=>{
 const {budget:b}=fixture(t);let reads=0;const raw=context();Object.defineProperty(raw,'role',{enumerable:true,get(){reads++;return'planner2';}});assert.throws(()=>b.beginCustomProbe(raw),{code:'CUSTOM_PROBE_CONTEXT_INVALID'});assert.equal(reads,0);
 const c=context(),p=b.beginCustomProbe(c);assert.throws(()=>b.reserveCustomProbe(p,price(),100,{...binding(c),engineeringMode:'classic'}),{code:'CUSTOM_PROBE_BINDING_MISMATCH'});assert.equal(b.requests().length,0);
});
test('a capped scope retains its original probe-phase ceiling for Custom requests',t=>{
 const {budget:b}=fixture(t,false),q={...price(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,outputMicrosPerMillion:8000000};
 for(let i=0;i<2;i++){const c=context({probeId:'custom_probe_PHASE_'+i,flowBudget:{currency:'CNY',maxMicros:50000000},roleBudget:{currency:'CNY',maxMicros:50000000}}),p=b.beginCustomProbe(c),row=b.reserveCustomProbe(p,q,128,binding(c));b.settle(row.id,null,'UNKNOWN');b.endCustomProbe(p);}
 const c=context({probeId:'custom_probe_PHASE_THIRD',flowBudget:{currency:'CNY',maxMicros:50000000},roleBudget:{currency:'CNY',maxMicros:50000000}}),p=b.beginCustomProbe(c);assert.throws(()=>b.reserveCustomProbe(p,q,128,binding(c)),{code:'PROBE_BUDGET_EXCEEDED'});assert.equal(b.requests().length,2);assert.equal(b.summary().phase,'PROBE');
});
test('a Windows wall-clock rollback cannot extend a Custom probe capability',t=>{
 const {budget:b}=fixture(t),c=context();let clock=1000;b.customProbeClock=()=>clock;const p=b.beginCustomProbe(c),now=Date.now;
 try{Date.now=()=>now()-86400000;clock+=120001;assert.throws(()=>b.reserveCustomProbe(p,price(),100,binding(c)),{code:'CUSTOM_PROBE_PERMIT_EXPIRED'});assert.equal(b.requests().length,0);}finally{Date.now=now;}
});
test('a role-configured model is billed against its own probe route instead of the legacy executor model',t=>{
 const {budget:b}=fixture(t),c=context({role:'planner2',roleId:'planner2'}),p=b.beginCustomProbe(c);
 const row=b.reserveCustomProbe(p,{...price(),model:'deepseek-chat'},100,binding(c),'deepseek-chat');
 assert.equal(row.price.model,'deepseek-chat');assert.equal(row.customProbe.role,'planner2');b.settle(row.id,null,'COMPLETE');b.endCustomProbe(p);
});
test('the billed model must match the probe model while foreign providers and currencies stay refused',t=>{
 const {budget:b}=fixture(t),c=context(),p=b.beginCustomProbe(c);
 assert.throws(()=>b.reserveCustomProbe(p,{...price(),model:'deepseek-chat'},100,binding(c),'deepseek-reasoner'),{code:'CUSTOM_PROBE_PRICE_ROUTE_INVALID'});
 assert.throws(()=>b.reserveCustomProbe(p,{...price(),model:'deepseek-chat',currency:'USD'},100,binding(c),'deepseek-chat'),{code:'CUSTOM_PROBE_PRICE_ROUTE_INVALID'});
 assert.throws(()=>b.reserveCustomProbe(p,{...price(),model:'deepseek-chat',provider:'other'},100,binding(c),'deepseek-chat'),{code:'CUSTOM_PROBE_PRICE_ROUTE_INVALID'});
 assert.equal(b.requests().length,0);
});

test('third distinct probe may finish bounded successful inner requests without creating a fourth attempt',t=>{
 const {budget:b}=fixture(t);
 for(let attempt=0;attempt<3;attempt++){
  const c=context({probeId:'custom_probe_BOUND_'+attempt,flowBudget:{currency:'CNY',maxMicros:100000},roleBudget:{currency:'CNY',maxMicros:100000}}),p=b.beginCustomProbe(c);
  for(let i=0;i<4;i++){const row=b.reserveCustomProbe(p,price(),100,binding(c));b.settle(row.id,{inputTokens:0,outputTokens:0,cacheHitTokens:0},'COMPLETE');}
  assert.throws(()=>b.reserveCustomProbe(p,price(),100,binding(c)),{code:'NATIVE_INNER_REQUEST_LIMIT'});b.endCustomProbe(p);
 }
 assert.throws(()=>b.beginCustomProbe(context({probeId:'custom_probe_FOURTH'})),{code:'CUSTOM_PROBE_ATTEMPT_LIMIT'});
});
