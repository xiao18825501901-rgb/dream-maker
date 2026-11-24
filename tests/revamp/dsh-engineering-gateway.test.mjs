// Synthetic upstream responses over actual local HTTP; NOT DeepSeek/DSH Live.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {harness} from '../helpers.mjs';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
import {hash,DomainError} from '../../dist/server/security.js';
test('engineering gateway binds the physical body to its own permit and rejects stale context before a charge',{timeout:20000},async t=>{
 let b,g,p;t.after(async()=>{await g?.close();if(p)b.endEngineeringAcceptance(p);b?.close();});
 const h=harness(t);b=new NativeBudget(join(h.dir,'engineering.sqlite'),{scopeId:'OFFLINE',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});p=b.beginEngineeringAcceptance({schema:'dream-maker.dsh-engineering-budget.v1',acceptanceId:'dsh_acceptance_http_offline',contractHash:'1'.repeat(64),configurationHash:'2'.repeat(64),dispatchId:'dispatch_offline',generation:'owner_offline'});
 const quote=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
 let current=true,upstream=0,upstreamHash;const transport=async(_url,options)=>{upstream++;upstreamHash=hash(options.body);return new Response(JSON.stringify({id:'offline',model:'deepseek-flash',choices:[{message:{content:'OFFLINE'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});};
 g=new DeepSeekGateway(b,quote,'OFFLINE_KEY',128,8,transport,'chat-completions',false,undefined,undefined,{permit:p,assertCurrent:()=>{if(!current)throw new DomainError('ENGINEERING_ACCEPTANCE_STALE',409);}});
 const route=await g.start(),body={model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE'}],max_tokens:128},send=()=>fetch(route.url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+route.token},body:JSON.stringify(body)});
 const good=await send();assert.equal(good.status,200,await good.text());assert.equal(b.requests()[0].engineeringAcceptance.bodyHash,upstreamHash);assert.equal(b.requests()[0].binding,undefined);
 current=false;const bad=await send();assert.equal(bad.status,409);assert.equal((await bad.json()).error.code,'ENGINEERING_ACCEPTANCE_STALE');assert.equal(upstream,1);assert.equal(b.requests().length,1);
 assert.throws(()=>new DeepSeekGateway(b,quote,'OFFLINE_KEY',128,8,transport,'chat-completions',true,undefined,undefined,{permit:p,assertCurrent(){}}),{code:'ENGINEERING_GATEWAY_PURPOSE_INVALID'});
});
