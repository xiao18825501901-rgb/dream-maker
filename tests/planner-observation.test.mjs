// OFFLINE API doubles with a real local monetary ledger; not Live receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {harness,root} from './helpers.mjs';
import {NativeBudget} from '../dist/server/native-budget.js';
import {ModelProvider,nativePlannerGuard} from '../dist/server/providers/model.js';
import {hash} from '../dist/server/security.js';
function setup(t){
 let budget;
 t.after(()=>{budget?.close();delete process.env.DM_OBSERVATION_TEST_KEY;});
 const h=harness(t);h.config.planner1.model='OFFLINE_MODEL';h.config.planner1.keyEnv='DM_OBSERVATION_TEST_KEY';
 process.env.DM_OBSERVATION_TEST_KEY='OFFLINE_CREDENTIAL';
 budget=new NativeBudget(resolve(h.dir,'ledger.sqlite'),{scopeId:'OFFLINE',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
 const price={provider:'openai-official',model:'OFFLINE_MODEL',currency:'CNY',source:'OFFLINE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
 return{h,budget,guard:nativePlannerGuard(budget,()=>price)};
}
const response=(extra={})=>({id:'offline-response',model:'OFFLINE_MODEL',status:'completed',output:[{content:[{type:'output_text',text:'{"text":"observed"}'}]}],usage:{input_tokens:10,output_tokens:4},...extra});
test('API observation retains actual response/model and the settled monetary request',async t=>{
 const f=setup(t),value=response(),provider=new ModelProvider(()=>f.h.config,root,async()=>value,f.guard);
 const out=await provider.complete({task:'question'}),observation=out.observation;
 assert.equal(observation.runner,'LLM_API');assert.equal(observation.model,'OFFLINE_MODEL');
 assert.equal(observation.responseId,'offline-response');assert.equal(observation.ledgerRequestId,f.budget.requests()[0].id);
 assert.equal(observation.responseObjectHash,hash(value));assert.equal(observation.authentication,'API_KEY');
 assert.equal(out.usage.requestId,observation.responseId);assert.equal(f.budget.requests()[0].usageStatus,'KNOWN');
 assert.doesNotMatch(JSON.stringify(observation),/OFFLINE_CREDENTIAL|observed/);
});
for(const [name,extra,code] of [
 ['missing status',{status:undefined},'MODEL_OUTPUT_INCOMPLETE'],
 ['missing model',{model:undefined},'MODEL_ACTUAL_ROUTE_MISMATCH'],
 ['foreign model',{model:'other-model'},'MODEL_ACTUAL_ROUTE_MISMATCH'],
 ['missing ID',{id:undefined},'MODEL_RESPONSE_ID_REQUIRED'],
 ['object ID',{id:{}},'MODEL_RESPONSE_ID_REQUIRED']
])test('planner1 rejects '+name+' while preserving paid usage',async t=>{
 const f=setup(t);let calls=0;
 const provider=new ModelProvider(()=>f.h.config,root,async()=>{calls++;return response(extra);},f.guard);
 await assert.rejects(provider.complete({task:'question'}),{code});assert.equal(calls,1);
 assert.equal(f.budget.summary().inFlight,0);assert.ok(f.budget.summary().committedMicros>0);
});
test('configuration changes during inference cannot produce a qualifying observation',async t=>{
 const f=setup(t),provider=new ModelProvider(()=>f.h.config,root,async()=>{f.h.config.planner1.model='changed';return response();},f.guard);
 await assert.rejects(provider.complete({task:'question'}),{code:'MODEL_CONFIG_CHANGED'});
 assert.ok(f.budget.summary().committedMicros>0);
});
test('the actual API probe uses a fixed challenge and bounded output with the existing guard',async t=>{
 const f=setup(t),challenge='DM_PROBE_'+'a'.repeat(32);let sent;
 const provider=new ModelProvider(()=>f.h.config,root,async(_url,options)=>{
  sent=JSON.parse(options.body);return response({output:[{content:[{type:'output_text',text:JSON.stringify({probe:challenge})}]}]});
 },f.guard);
 const out=await provider.probe(challenge,new AbortController().signal);
 assert.equal(sent.max_output_tokens,128);assert.match(sent.instructions,/No tools/);
 assert.equal(out.data.probe,challenge);assert.equal(f.budget.requests()[0].maxOutputTokens,128);
 assert.equal(out.observation.ledgerRequestId,f.budget.requests()[0].id);
});
test('SIWC qualification cannot invoke the paid API probe path',async t=>{
 const f=setup(t);f.h.config.planner1.authMode='siwc_plan';let api=0,plan=0;
 const provider=new ModelProvider(()=>f.h.config,root,async()=>{api++;return response();},f.guard,{complete:async()=>{plan++;throw Error('NOT_CALLED');}});
 await assert.rejects(provider.probe('DM_PROBE_'+'a'.repeat(32),new AbortController().signal),{code:'SIWC_PROBE_METADATA_REQUIRED'});
 assert.equal(api,0);assert.equal(plan,0);assert.equal(f.budget.requests().length,0);
});
