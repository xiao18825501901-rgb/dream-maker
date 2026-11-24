// Real isolated SQLite ledger plus synthetic provider usage. Not a paid or OAuth acceptance run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {nativePlannerGuard} from '../../dist/server/providers/model.js';
import {harness} from '../helpers.mjs';
test('P1 DeepSeek reserves on the original ledger and settles Chat usage without relabeling it as OpenAI',t=>{
 let budget;t.after(()=>budget?.close());const h=harness(t);budget=new NativeBudget(join(h.dir,'p1-money.sqlite'),{scopeId:'OFFLINE_P1_ROUTE',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
 const price={provider:'deepseek-official',model:'owner-model',currency:'CNY',source:'OFFLINE_TEST_NOT_OFFICIAL_QUOTE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
 const guard=nativePlannerGuard(budget,()=>price);const ticket=guard({baseUrl:'https://api.deepseek.com',protocol:'chat-completions',model:'owner-model',maxOutputTokens:128});
 ticket.settle({prompt_tokens:1000,completion_tokens:30,prompt_cache_hit_tokens:100},'RESPONSE_RECEIVED');
 const rows=budget.requests();assert.equal(rows.length,1);assert.equal(rows[0].role,'planner1');assert.equal(rows[0].price.provider,'deepseek-official');assert.equal(rows[0].usageStatus,'KNOWN');assert.deepEqual(rows[0].usage,{inputTokens:1000,outputTokens:30,cacheHitTokens:100});
 assert.throws(()=>guard({baseUrl:'https://api.openai.com/v1',protocol:'openai-responses',model:'owner-model',maxOutputTokens:128}),{code:'NATIVE_PRICE_ROUTE_MISMATCH'});
 assert.equal(budget.requests().length,1);
});
