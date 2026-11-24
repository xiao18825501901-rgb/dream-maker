// OFFLINE mocked transport plus real local ledger; never a provider acceptance receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ModelProvider, nativePlannerGuard } from '../dist/server/providers/model.js';
import { NativeBudget } from '../dist/server/native-budget.js';
import { harness, root } from './helpers.mjs';

function setup(t) {
    let budget;
    t.after(() => { budget?.close(); delete process.env.DM_BUDGET_TEST_KEY; });
    const h = harness(t);
    h.config.planner1.model = 'OFFLINE_MODEL'; h.config.planner1.keyEnv = 'DM_BUDGET_TEST_KEY';
    process.env.DM_BUDGET_TEST_KEY = 'OFFLINE_KEY';
    budget = new NativeBudget(resolve(h.dir, 'money.sqlite'), { scopeId:'OFFLINE',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2 });
    const price = { provider:'openai-official',model:'OFFLINE_MODEL',currency:'CNY',source:'OFFLINE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000 };
    return { h, budget, guard: nativePlannerGuard(budget, () => price) };
}
test('planner API cannot dispatch without a monetary reservation guard', async t => {
    const { h } = setup(t); let calls=0;
    const m = new ModelProvider(() => h.config, root, async () => { calls++; return {}; });
    await assert.rejects(m.complete({ task:'summary' }), {code:'NATIVE_BUDGET_REQUIRED'});
    assert.equal(calls,0);
});
test('provider usage is charged even when its response fails business JSON validation', async t => {
    const { h,budget,guard } = setup(t);
    const m = new ModelProvider(() => h.config, root, async () => ({ status:'incomplete',usage:{input_tokens:1000,output_tokens:50,input_tokens_details:{cached_tokens:0}} }), guard);
    await assert.rejects(m.complete({ task:'summary' }), {code:'MODEL_OUTPUT_INCOMPLETE'});
    assert.equal(budget.summary().committedMicros,2400);
    assert.equal(budget.summary().inFlight,0);
});
test('failed requests keep their worst cost and mismatched quotes cannot dispatch', async t => {
    const { h,budget,guard } = setup(t); let calls=0;
    const m = new ModelProvider(() => h.config, root, async () => { calls++; throw Error('offline disconnect'); }, guard);
    await assert.rejects(m.complete({ task:'summary' }));
    assert.equal(budget.requests()[0].usageStatus,'UNKNOWN');
    assert.ok(budget.summary().committedMicros>2000000);
    h.config.planner1.model='NOT_QUOTED';
    await assert.rejects(m.complete({}),{code:'NATIVE_PRICE_ROUTE_MISMATCH'});
    assert.equal(calls,1);
});

test('owner cancellation reaches transport and a late completed reply cannot commit planner data',async t=>{
 const {h,budget,guard}=setup(t),controller=new AbortController();
 const ownedGuard=route=>({...guard(route),signal:controller.signal});
 const m=new ModelProvider(()=>h.config,root,async(_url,options)=>{
  assert.equal(options.signal.aborted,false);controller.abort();assert.equal(options.signal.aborted,true);
  return{status:'completed',output_text:'{"answer":"OFFLINE_LATE_REPLY"}',usage:{input_tokens:1000,output_tokens:50,input_tokens_details:{cached_tokens:0}}};
 },ownedGuard);
 await assert.rejects(m.complete({task:'summary'}),{code:'MODEL_REQUEST_CANCELLED'});
 assert.equal(budget.summary().committedMicros,2400);assert.equal(m.activeCalls,0);
});
