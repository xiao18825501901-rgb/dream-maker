// OFFLINE upstream doubles only. These tests do not verify DeepSeek or ccswitch routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { NativeBudget } from '../dist/server/native-budget.js';
import { DeepSeekGateway, waitGatewayDrain } from '../dist/server/deepseek-gateway.js';
import { EventEmitter, getEventListeners } from 'node:events';
import { harness } from './helpers.mjs';
import { hash } from '../dist/server/security.js';

async function setup(t, transport, maximumRequests=4, wire='chat-completions', forbidTools=false) {
    let gateway,budget;
    t.after(async () => { await gateway?.close(); budget?.close(); });
    const h=harness(t);
    budget=new NativeBudget(resolve(h.dir,'gateway-budget.sqlite'),{scopeId:'OFFLINE',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
    const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
    gateway=new DeepSeekGateway(budget,price,'OFFLINE_UPSTREAM_KEY',128,maximumRequests,transport,wire,forbidTools);
    const route=await gateway.start();
    const request=(body,token=route.token)=>fetch(route.url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    return {budget,gateway,route,request};
}
const body={model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE_ONLY'}],max_tokens:128,stream:false};

for(const status of [402,403,429,503])test('upstream diagnostics preserve HTTP '+status+' without disclosing headers or an error body',async t=>{
 let attempts=0;const requestId='OFFLINE_REQUEST_ID_CANARY';
 const f=await setup(t,async()=>{attempts++;return new Response('PRIVATE_PROVIDER_ERROR_BODY',{status,headers:{'x-request-id':requestId,'set-cookie':'PRIVATE_UPSTREAM_COOKIE'}});});
 const response=await f.request(body);assert.equal(response.status,502);const publicError=await response.text();
 const receipt=f.gateway.receipts()[0];assert.equal(receipt.upstreamHttpStatus,status);assert.equal(receipt.upstreamRequestIdSha256,hash(requestId));assert.equal(receipt.transportErrorCode,null);
 assert.ok(Number.isSafeInteger(receipt.elapsedMs)&&receipt.elapsedMs>=0);assert.equal(attempts,1);
 assert.doesNotMatch(JSON.stringify({publicError,receipt}),/PRIVATE_PROVIDER_ERROR_BODY|PRIVATE_UPSTREAM_COOKIE|OFFLINE_REQUEST_ID_CANARY|OFFLINE_UPSTREAM_KEY/);
 assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');assert.equal(f.budget.requests()[0].chargedMicros,f.budget.requests()[0].reservedMicros);
});

for(const code of ['ECONNRESET','PRIVATE_TRANSPORT_TOKEN'])test('transport diagnostics retain only an allowed system code: '+code,async t=>{
 let attempts=0;
 const f=await setup(t,async()=>{attempts++;throw Object.assign(new TypeError('PRIVATE_TRANSPORT_MESSAGE'),{cause:{code,message:'PRIVATE_CAUSE_MESSAGE'}});});
 const response=await f.request(body);assert.equal(response.status,502);await response.text();const receipt=f.gateway.receipts()[0];
 assert.equal(receipt.upstreamHttpStatus,null);assert.equal(receipt.upstreamRequestIdSha256,null);assert.equal(receipt.transportErrorCode,code==='ECONNRESET'?code:null);assert.equal(attempts,1);
 assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_TRANSPORT_MESSAGE|PRIVATE_CAUSE_MESSAGE|PRIVATE_TRANSPORT_TOKEN/);assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});

test('a changing status accessor cannot put unchecked text in a diagnostic receipt',async t=>{
 const f=await setup(t,async()=>{const response=new Response('',{status:403});let reads=0;Object.defineProperty(response,'status',{get(){return ++reads<4?403:'PRIVATE_STATUS_CANARY';}});return response;});
 const response=await f.request(body);assert.equal(response.status,502);await response.text();assert.equal(f.gateway.receipts()[0].upstreamHttpStatus,403);assert.doesNotMatch(JSON.stringify(f.gateway.receipts()),/PRIVATE_STATUS_CANARY/);
});

test('unreadable exception causes cannot replace the original transport failure',async t=>{
 const cause=Proxy.revocable({},{});cause.revoke();const f=await setup(t,async()=>{throw new TypeError('PRIVATE_ORIGINAL_TRANSPORT_FAILURE',{cause:cause.proxy});});
 const response=await f.request(body);assert.equal(response.status,502);await response.text();assert.equal(f.gateway.receipts()[0].transportErrorCode,null);assert.equal(f.gateway.receipts()[0].outcome,'FAILED_OR_DISCONNECTED');
});

for(const status of [200,403])test('optional request ID diagnostics cannot change HTTP '+status+' handling',async t=>{
 const f=await setup(t,async()=>{const response=new Response(status===200?JSON.stringify(completion()):'PRIVATE_ERROR_BODY',{status,headers:{'content-type':'application/json'}}),get=response.headers.get.bind(response.headers);response.headers.get=name=>{if(name==='x-request-id')throw Error('PRIVATE_HEADER_FAILURE');return get(name);};return response;});
 const response=await f.request(body);assert.equal(response.status,status===200?200:502);await response.text();const receipt=f.gateway.receipts()[0];assert.equal(receipt.upstreamHttpStatus,status);assert.equal(receipt.upstreamRequestIdSha256,null);assert.equal(receipt.outcome,status===200?'COMPLETE':'MODEL_GATEWAY_UPSTREAM_FAILURE');
});

test('text chat completions treat explicit null optional tool fields as absent',async t=>{
  const value=completion({choices:[{index:0,message:{content:'OFFLINE_RESPONSE',tool_calls:null,function_call:null},finish_reason:'stop'}]});
  const f=await setup(t,async()=>Response.json(value));
  const response=await f.request(body);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),value);
  assert.equal(f.gateway.receipts()[0].outcome,'COMPLETE');
  assert.equal(f.gateway.receipts()[0].completionObserved,true);
});

test('malformed streaming data is a stream protocol failure, not a tool argument failure',async t=>{
  const f=await setup(t,async()=>new Response('data: malformed\n\n',{headers:{'content-type':'text/event-stream'}}),1);
  const response=await f.request({...body,stream:true}).catch(error=>{
    assert.equal(error?.cause?.code,'UND_ERR_SOCKET');
    return null;
  });
  if(response){assert.equal(response.status,502);await response.text();}
  const receipt=f.gateway.receipts()[0];
  assert.equal(receipt.outcome,'MODEL_GATEWAY_STREAM_DATA_INVALID');
  assert.equal(receipt.toolArgumentFailureDetail,null);
  assert.equal(receipt.protocolFailureStage,'PARSE');
  assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});

test('malformed nonstream JSON is an upstream JSON failure, not a tool argument failure',async t=>{
  const rawBody='not-json PRIVATE_PARSE_BODY';
  const f=await setup(t,async()=>new Response(rawBody,{headers:{'content-type':'application/json'}}),1);
  const response=await f.request(body);
  assert.equal(response.status,502);
  await response.text();
  const receipt=f.gateway.receipts()[0];
  assert.equal(receipt.outcome,'MODEL_GATEWAY_UPSTREAM_JSON_INVALID');
  assert.equal(receipt.toolArgumentFailureDetail,null);
  assert.equal(receipt.protocolFailureStage,'PARSE');
  assert.equal(receipt.upstreamBodyShape,'TEXT');
  assert.equal(receipt.upstreamBodyBytes,Buffer.byteLength(rawBody));
  assert.equal(receipt.upstreamBodySha256,hash(rawBody));
  assert.equal(receipt.upstreamBodyCode,null);
  assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_PARSE_BODY/);
  assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});

for(const [shape,detail] of [
  [{tool_calls:{PRIVATE_SHAPE_CANARY:true}}, 'TOOL_CALLS_TYPE'],
  [{tool_calls:[{id:'offline-tool',function:{name:'read_file',arguments:{PRIVATE_ARGUMENT_CANARY:true}}}]}, 'TOOL_CALL_ARGUMENTS_TYPE']
])test('invalid chat tool structure records only a bounded field-level detail: '+detail,async t=>{
  const value=completion({choices:[{index:0,message:{content:'OFFLINE_RESPONSE',...shape},finish_reason:'stop'}]});
  const f=await setup(t,async()=>Response.json(value));
  const response=await f.request(body);
  assert.equal(response.status,502);
  await response.text();
  const receipt=f.gateway.receipts()[0];
  assert.equal(receipt.outcome,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID');
  assert.equal(receipt.toolArgumentFailureDetail,detail);
  assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_SHAPE_CANARY|PRIVATE_ARGUMENT_CANARY/);
});

test('a stream content-type mismatch records only the normalized media type',async t=>{
 const rawBody='PRIVATE NON STREAM BODY';
 const f=await setup(t,async()=>new Response(rawBody,{headers:{'content-type':'application/json; charset=utf-8'}}));
 const response=await f.request({...body,stream:true});assert.equal(response.status,502);await response.text();const receipt=f.gateway.receipts()[0];
 assert.equal(receipt.outcome,'MODEL_GATEWAY_UPSTREAM_TYPE');
 assert.equal(receipt.upstreamContentType,'application/json');
 assert.equal(receipt.upstreamBodyShape,'TEXT');
 assert.equal(receipt.upstreamBodyBytes,Buffer.byteLength(rawBody));
 assert.equal(receipt.upstreamBodySha256,hash(rawBody));
 assert.equal(receipt.upstreamBodyCode,null);
 assert.equal(receipt.networkFailureClass,'HTTP_SUCCESS_NON_INFERENCE');
 assert.equal(receipt.automaticRetryAllowed,false);
 assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_NON_STREAM_BODY|charset=utf-8/);
});

test('diagnostic elapsed time uses a monotonic clock when wall time jumps forward',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const f=await setup(t,async()=>{now+=86400000;return new Response('',{status:403});});const response=await f.request(body);await response.text();
 const receipt=f.gateway.receipts()[0];assert.ok(receipt.elapsedMs>=0&&receipt.elapsedMs<=300000);assert.equal(receipt.elapsedMsCapped,false);
});
test('a probe gateway capability cannot be borrowed by an ordinary gateway on the same ledger',async t=>{
 let initial,budget,probe,ordinary;t.after(async()=>{await ordinary?.close();await probe?.close();budget?.close();initial?.close();});
 const h=harness(t),path=resolve(h.dir,'scoped-gateway.sqlite'),authority={scopeId:'OFFLINE',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
 const refs=Object.fromEntries(['planner2','executor','reviewer'].map(role=>[role,{evidenceId:'OFFLINE_'+role,model:'OFFLINE',source:'REAL_MODEL_RESPONSE'}]));
 initial=new NativeBudget(path,authority,()=>true,undefined,'ENGINEERING_ONLY');initial.advance(refs);initial.close();
 budget=new NativeBudget(path,authority,()=>true);const permit=budget.beginEvidenceRepair('executor');let upstream=0;
 const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
 const transport=async()=>{upstream++;return new Response(JSON.stringify(completion()),{headers:{'content-type':'application/json'}});};
 probe=new DeepSeekGateway(budget,price,'OFFLINE_KEY',128,1,transport,'chat-completions',true,permit);
 ordinary=new DeepSeekGateway(budget,price,'OFFLINE_KEY',128,1,transport);
 const p=await probe.start(),o=await ordinary.start();
 const send=route=>fetch(route.url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+route.token,'content-type':'application/json'},body:JSON.stringify(body)});
 const refused=await send(o);assert.equal(refused.status,409);assert.match(await refused.text(),/PROBE_EVIDENCE_UNVERIFIED/);assert.equal(upstream,0);
 const allowed=await send(p);assert.equal(allowed.status,200,await allowed.text());assert.equal(upstream,1);assert.equal(budget.requests().length,1);
 budget.endEvidenceRepair(permit);
});
const completion=(extra={})=>({id:'offline-response',model:'deepseek-flash',choices:[{index:0,message:{content:'OFFLINE_RESPONSE'},finish_reason:'stop'}],...extra});
const chunk=(extra={})=>completion({choices:[{index:0,delta:{content:'OFFLINE_RESPONSE'},finish_reason:'stop'}],...extra});
const event=v=>'data: '+JSON.stringify(v)+'\n\n';

test('reported usage breach halts the next inner HTTP dispatch before upstream transport',async t=>{
 let calls=0;
 const f=await setup(t,async()=>{calls++;return new Response(JSON.stringify(completion({usage:{prompt_tokens:1,completion_tokens:400000}})),{headers:{'content-type':'application/json'}});});
 const first=await f.request(body);await first.text();
 const second=await f.request(body);assert.equal(second.status,409);
 assert.equal((await second.json()).error.code,'NATIVE_USAGE_BOUND_EXCEEDED');
 assert.equal(calls,1);assert.equal(f.budget.requests().length,1);
 assert.equal(f.budget.requests()[0].limitExceeded,true);
});

for(const actualModel of [undefined,'deepseek-v4-flash','different-model','deepseek-official/deepseek-flash'])test('unverified actual model is never forwarded: '+String(actualModel),async t=>{
 const f=await setup(t,async()=>new Response(JSON.stringify(completion({model:actualModel})),{headers:{'content-type':'application/json'}}));
 const response=await f.request(body);assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/OFFLINE_RESPONSE/);
 assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_RESPONSE_MODEL_MISMATCH');
 assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});
for(const value of [undefined,{},''])test('actual response identity cannot be missing or coerced: '+JSON.stringify(value),async t=>{
 const f=await setup(t,async()=>new Response(JSON.stringify(completion({id:value})),{headers:{'content-type':'application/json'}}));
 assert.equal((await f.request(body)).status,502);assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_RESPONSE_ID_INVALID');
});
test('a later correct-model SSE chunk cannot erase an earlier foreign route',async t=>{
 const payload=event(chunk({model:'different-model'}))+event(chunk())+'data: [DONE]\n\n';
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(async()=>{const r=await f.request({...body,stream:true});await r.text();});
 assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_RESPONSE_MODEL_MISMATCH');
});
test('SSE response identity stays bound through usage and completion',async t=>{
 const payload=event(chunk())+event(chunk({id:'foreign-response'}))+'data: [DONE]\n\n';
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(async()=>{const r=await f.request({...body,stream:true});await r.text();});
 assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_RESPONSE_ID_CHANGED');
});
test('empty completions and missing finish reasons do not become complete receipts',async t=>{
 const f=await setup(t,async()=>new Response(JSON.stringify(completion({choices:[]})),{headers:{'content-type':'application/json'}}));
 assert.equal((await f.request(body)).status,502);assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_COMPLETION_INVALID');
});
test('data following DONE cannot alter usage or completion',async t=>{
 const payload=event(chunk())+'data: [DONE]\n\n'+event(chunk({usage:{prompt_tokens:1,completion_tokens:1}}));
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(async()=>{const r=await f.request({...body,stream:true});await r.text();});
 assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_EVENT_AFTER_COMPLETION');
 assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('a truncated minimal reply is charged but cannot qualify a probe',async t=>{
 const f=await setup(t,async()=>new Response(JSON.stringify(completion({choices:[{message:{content:'partial'},finish_reason:'length'}]})),{headers:{'content-type':'application/json'}}),1,'chat-completions',true);
 assert.equal((await f.request(body)).status,502);assert.equal(f.gateway.receipts()[0].outcome,'MINIMAL_PROBE_OUTPUT_INCOMPLETE');
});
test('gateway pins upstream route and model and exposes no real credential to the client',async t=>{
    let sent;
    const f=await setup(t,async(url,init)=>{sent={url,init}; return new Response(JSON.stringify(completion({usage:{prompt_tokens:1000,completion_tokens:50,prompt_cache_hit_tokens:0}})),{headers:{'content-type':'application/json'}});});
    assert.equal((await f.request(body,'wrong')).status,401);
    assert.equal((await f.request({...body,model:'deepseek-v4-flash'})).status,400);
    assert.equal((await f.request({...body,max_tokens:129})).status,400);
    const response=await f.request(body); assert.equal(response.status,200); await response.text();
    assert.equal(sent.url,'https://api.deepseek.com/chat/completions');
    assert.equal(sent.init.redirect,'error');
    assert.equal(sent.init.headers.authorization,'Bearer OFFLINE_UPSTREAM_KEY');
    assert.notEqual(f.route.token,'OFFLINE_UPSTREAM_KEY');
    assert.equal(f.budget.summary().committedMicros,2400);
    assert.doesNotMatch(JSON.stringify(f.gateway.receipts()),/OFFLINE_UPSTREAM_KEY|OFFLINE_ONLY/);
});
test('stock DSH Messages wire keeps its official protocol and minimum probes cannot dispatch tools',async t=>{
    let sent;
    const payload=event({type:'message_start',message:{id:'offline-message',model:'deepseek-flash',usage:{input_tokens:10,output_tokens:0}}})+
        event({type:'content_block_delta',delta:{type:'text_delta',text:'OFFLINE_RESPONSE'}})+
        event({type:'message_delta',delta:{stop_reason:'end_turn'}})+event({type:'message_stop'});
    const f=await setup(t,async(url,init)=>{sent={url,body:JSON.parse(init.body),headers:init.headers};return new Response(payload,{headers:{'content-type':'text/event-stream'}});},1,'anthropic-messages',true);
    const r=await fetch(f.route.url+'/messages',{method:'POST',headers:{'x-api-key':f.route.token,'content-type':'application/json'},body:JSON.stringify({...body,stream:true,tools:[{name:'unapproved'}]})});
    assert.equal(r.status,200); assert.equal(await r.text(),payload);
    assert.equal(sent.url,'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(sent.headers['anthropic-version'],'2023-06-01');
    assert.equal(sent.headers['x-api-key'],'OFFLINE_UPSTREAM_KEY');
    assert.deepEqual(sent.body.tools,[]);
    // This frame set carries a real input count, so the turn now settles a real charge: ten input
    // tokens at the miss price. It used to settle the whole 1 MiB reservation, which is exactly the
    // 9830x overcharge this lane was measuring.
    assert.equal(f.budget.requests()[0].usageStatus,'KNOWN');
    assert.equal(f.budget.requests()[0].chargedMicros,20);
    assert.equal(f.budget.requests()[0].reservedMicros,2098176);
    assert.equal(f.budget.summary().committedMicros,20);
    assert.equal(f.gateway.receipts()[0].responseId,'offline-message');
    assert.equal(f.gateway.receipts()[0].observedModel,'deepseek-flash');
    assert.equal(f.gateway.receipts()[0].responseSha256,hash(payload));
    assert.equal(f.gateway.receipts()[0].minimalResponseVerified,true);
});
test('ordinary Messages text blocks may stop without a tool fragment',async t=>{
    const payload=event({type:'message_start',message:{id:'offline-message',model:'deepseek-flash'}})+
        event({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+
        event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OFFLINE_RESPONSE'}})+
        event({type:'content_block_stop',index:0})+
        event({type:'message_delta',delta:{stop_reason:'end_turn'}})+
        event({type:'message_stop'});
    const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}),1,'anthropic-messages',false);
    const response=await fetch(f.route.url+'/messages',{method:'POST',headers:{'authorization':'Bearer '+f.route.token,'content-type':'application/json'},body:JSON.stringify({...body,stream:true})});
    assert.equal(response.status,200);
    assert.match(await response.text(),/OFFLINE_RESPONSE/);
    const receipt=f.gateway.receipts()[0];
    assert.equal(receipt.outcome,'COMPLETE');
    assert.equal(receipt.toolArgumentFailureDetail,null);
});
test('each retry reserves separately and unknown errors stop before exceeding the probe cap',async t=>{
    let calls=0; const f=await setup(t,async()=>{calls++;throw Error('OFFLINE disconnect');});
    assert.equal((await f.request(body)).status,502);
    assert.equal((await f.request(body)).status,502);
    assert.equal((await f.request(body)).status,409);
    assert.equal(calls,2); assert.equal(f.budget.summary().committedMicros,4196352);
});
test('SSE usage is counted only after a complete bounded stream',async t=>{
    const payload=event(chunk())+event(chunk({choices:[],usage:{prompt_tokens:1000,completion_tokens:50,prompt_cache_hit_tokens:100}}))+'data: [DONE]\n\n';
    const f=await setup(t,async(_url,init)=>{assert.equal(JSON.parse(init.body).stream_options.include_usage,true);return new Response(payload,{headers:{'content-type':'text/event-stream'}});});
    const r=await f.request({...body,stream:true}); assert.equal(r.status,200); assert.equal(await r.text(),payload);
    assert.equal(f.budget.summary().committedMicros,2204);
    assert.equal(f.gateway.receipts()[0].completionObserved,true);
    assert.equal(f.gateway.receipts()[0].minimalResponseVerified,false);
    assert.equal(f.gateway.receipts()[0].responseSha256,hash(payload));
});
test('truncated streams retain worst-case billing even when a usage chunk was observed',async t=>{
    const f=await setup(t,async()=>new Response('data: '+JSON.stringify({usage:{prompt_tokens:1,completion_tokens:1,prompt_cache_hit_tokens:0}})+'\n\n',{headers:{'content-type':'text/event-stream'}}));
    await assert.rejects(async()=>{ const r=await f.request({...body,stream:true}); await r.text(); });
    assert.equal(f.budget.summary().committedMicros,2098176);
    assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('request count cap prevents an internal agent loop even with cheap successful calls',async t=>{
    let calls=0;
    const f=await setup(t,async()=>{calls++;return new Response(JSON.stringify(completion({usage:{prompt_tokens:1,completion_tokens:1,prompt_cache_hit_tokens:0}})),{headers:{'content-type':'application/json'}});},1);
    await (await f.request(body)).text();
    assert.equal((await f.request(body)).status,409); assert.equal(calls,1);
});
test('minimum probe refuses nonstream tool responses before any client can dispatch them',async t=>{
    const f=await setup(t,async()=>new Response(JSON.stringify({model:'deepseek-flash',choices:[{message:{tool_calls:[{id:'fixture',function:{name:'write_file'}}]}}]}),{headers:{'content-type':'application/json'}}),1,'chat-completions',true);
    const response=await f.request(body);
    assert.equal(response.status,502);
    assert.doesNotMatch(await response.text(),/write_file/);
    assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('minimum Messages probe refuses nonstream tool_use content',async t=>{
    const f=await setup(t,async()=>new Response(JSON.stringify({model:'deepseek-flash',content:[{type:'tool_use',name:'write_file'}]}),{headers:{'content-type':'application/json'}}),1,'anthropic-messages',true);
    const response=await fetch(f.route.url+'/messages',{method:'POST',headers:{'x-api-key':f.route.token,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,502);
    assert.doesNotMatch(await response.text(),/write_file/);
});
test('backpressure waits detach all loser listeners on drain, cancellation or closure',async()=>{
    for(const event of ['drain','abort','close']){
        const res=new EventEmitter();res.destroyed=false;
        const abort=new AbortController();
        const pending=waitGatewayDrain(res,abort.signal);
        if(event==='abort')abort.abort();else res.emit(event);
        if(event==='drain')await pending;else await assert.rejects(pending,{code:'MODEL_GATEWAY_DISCONNECTED'});
        for(const name of ['drain','close','error'])assert.equal(res.listenerCount(name),0);
        assert.equal(getEventListeners(abort.signal,'abort').length,0);
    }
});
test('split SSE tool event is never forwarded before validating its complete boundary',async t=>{
    const encoder=new TextEncoder();
    const event='data: '+JSON.stringify({model:'deepseek-flash',choices:[{delta:{tool_calls:[{function:{name:'write_file'}}]}}]})+'\n\n';
    const f=await setup(t,async()=>new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(event.slice(0,-1)));setTimeout(()=>{c.enqueue(encoder.encode(event.slice(-1)));c.close();},10);}}),{headers:{'content-type':'text/event-stream'}}),1,'chat-completions',true);
    let received='';
    try{const r=await f.request({...body,stream:true});const reader=r.body.getReader();for(;;){const c=await reader.read();if(c.done)break;received+=new TextDecoder().decode(c.value);}}catch{}
    assert.doesNotMatch(received,/write_file|tool_calls/);
    assert.equal(f.gateway.receipts()[0].outcome,'MINIMAL_PROBE_TOOL_RESPONSE_DENIED');
});
for(const [name,payload,expected] of [
 ['foreign model',event({type:'message_start',message:{id:'offline-message',model:'different-model'}}),'MODEL_GATEWAY_RESPONSE_MODEL_MISMATCH'],
 ['missing response ID',event({type:'message_start',message:{model:'deepseek-flash'}}),'MODEL_GATEWAY_RESPONSE_ID_INVALID'],
 ['missing start',event({type:'content_block_delta',delta:{text:'unbound-output'}}),'MODEL_GATEWAY_RESPONSE_ID_INVALID'],
 ['missing reason',event({type:'message_start',message:{id:'offline-message',model:'deepseek-flash'}})+event({type:'content_block_delta',delta:{text:'partial'}})+event({type:'message_stop'}),'MODEL_GATEWAY_COMPLETION_INVALID'],
 ['max tokens',event({type:'message_start',message:{id:'offline-message',model:'deepseek-flash'}})+event({type:'content_block_delta',delta:{text:'partial'}})+event({type:'message_delta',delta:{stop_reason:'max_tokens'}})+event({type:'message_stop'}),'MINIMAL_PROBE_OUTPUT_INCOMPLETE'],
 ['post-stop event',event({type:'message_start',message:{id:'offline-message',model:'deepseek-flash'}})+event({type:'content_block_delta',delta:{text:'complete'}})+event({type:'message_delta',delta:{stop_reason:'end_turn'}})+event({type:'message_stop'})+event({type:'ping'}),'MODEL_GATEWAY_EVENT_AFTER_COMPLETION']
])test('stock Messages refuses '+name+' without qualifying the probe',async t=>{
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}),1,'anthropic-messages',true);
 // Minimum replies are buffered until validation, so upstream faults now return an explicit
 // HTTP error before any success headers or partial model text can reach the SDK.
 const response=await fetch(f.route.url+'/messages',{method:'POST',headers:{'x-api-key':f.route.token,'content-type':'application/json'},body:JSON.stringify({...body,stream:true})});
 assert.equal(response.status,502);assert.equal((await response.json()).error.code,expected);
 const receipt=f.gateway.receipts()[0];assert.equal(receipt.outcome,expected);
 assert.equal(receipt.completionObserved,false);assert.equal(receipt.minimalResponseVerified,false);
 assert.equal(receipt.responseSha256,null);assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});
for(const wire of ['chat-completions','anthropic-messages'])test('ordinary '+wire+' execution retains validated tool completions',async t=>{
 const value=wire==='chat-completions'?completion({choices:[{message:{tool_calls:[{id:'offline-tool',function:{name:'read_file'}}]},finish_reason:'tool_calls'}]}):
 {id:'offline-message',model:'deepseek-flash',content:[{type:'tool_use',id:'offline-tool',name:'read_file'}],stop_reason:'tool_use'};
 const f=await setup(t,async()=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}}),1,wire,false);
 const path=wire==='chat-completions'?'/chat/completions':'/messages';
 const response=await fetch(f.route.url+path,{method:'POST',headers:{authorization:'Bearer '+f.route.token,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),value);
 assert.equal(f.gateway.receipts()[0].completionObserved,true);assert.equal(f.gateway.receipts()[0].minimalResponseVerified,false);
});
test('upstream credential reflection is rejected before it reaches the DSH client',async t=>{
 const f=await setup(t,async()=>new Response(JSON.stringify(completion({choices:[{message:{content:'OFFLINE_UPSTREAM_KEY'},finish_reason:'stop'}]})),{headers:{'content-type':'application/json'}}));
 const r=await f.request(body);assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/OFFLINE_UPSTREAM_KEY/);
 assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_SECRET_IN_RESPONSE');
});
test('split text deltas cannot reconstruct the upstream credential at the client',async t=>{
 const payload=event(chunk({choices:[{delta:{content:'OFFLINE_UP'},finish_reason:null}]}))+
 event(chunk({choices:[{delta:{content:'STREAM_KEY'},finish_reason:'stop'}]}))+'data: [DONE]\n\n';
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}));let received='';
 try{const r=await f.request({...body,stream:true});const reader=r.body.getReader();for(;;){const part=await reader.read();if(part.done)break;received+=new TextDecoder().decode(part.value);}}catch{}
 assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_SECRET_IN_RESPONSE');
 assert.doesNotMatch(received,/STREAM_KEY/);assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});

for(const escaped of [false,true])test('chat tool argument fragments are decoded and checked before SDK delivery; escaped='+escaped,async t=>{
 const secret='OFFLINE_UPSTREAM_KEY',value=escaped?[...secret].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''):secret;
 const args='{"path":"'+value+'"}',fragments=args.match(/.{1,7}/g);
 const payload=fragments.map((part,index)=>event(chunk({choices:[{delta:{tool_calls:[{index:0,...(index===0?{id:'offline-tool'}:{}),function:{...(index===0?{name:'read_file'}:{}),arguments:part}}]},finish_reason:null}]}))).join('')+
 event(chunk({choices:[{delta:{},finish_reason:'tool_calls'}]}))+'data: [DONE]\n\n';
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}),1,'chat-completions',false);let received='';
 try{const response=await f.request({...body,stream:true}),reader=response.body.getReader();for(;;){const next=await reader.read();if(next.done)break;received+=new TextDecoder().decode(next.value);}}catch{}
 assert.equal(received.includes('tool_calls'),false);assert.equal(f.gateway.receipts()[0].outcome,'MODEL_GATEWAY_SECRET_IN_RESPONSE');assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');assert.equal(f.budget.requests().length,1);
});
test('nonstream chat arguments cannot hide a key in an overwritten Unicode string',async t=>{
 const escaped=[...'OFFLINE_UPSTREAM_KEY'].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const args='{"path":"'+escaped+'","path":"README.md"}',payload=completion({choices:[{message:{tool_calls:[{id:'offline-tool',function:{name:'read_file',arguments:args}}]},finish_reason:'tool_calls'}]});
 const f=await setup(t,async()=>Response.json(payload),1,'chat-completions',false),response=await f.request(body);assert.equal(response.status,502);assert.equal((await response.json()).error.code,'MODEL_GATEWAY_SECRET_IN_RESPONSE');assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('outer JSON duplicate fields cannot conceal an encoded credential from the raw client transcript',async t=>{
 const escaped=[...'OFFLINE_UPSTREAM_KEY'].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const payload=JSON.stringify(completion()).replace('"content":"OFFLINE_RESPONSE"','"content":"'+escaped+'","content":"OFFLINE_RESPONSE"');
 assert.notEqual(payload,JSON.stringify(completion()));
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'application/json'}})),response=await f.request(body);assert.equal(response.status,502);assert.equal((await response.json()).error.code,'MODEL_GATEWAY_SECRET_IN_RESPONSE');
});
for(const escapedName of [false,true])test('overwritten outer arguments with inner Unicode escapes are refused; escaped name='+escapedName,async t=>{
 const args='{"path":"\\u004fFFLINE_UPSTREAM_KEY"}',base=JSON.stringify(completion({choices:[{message:{tool_calls:[{id:'offline-tool',function:{name:'read_file',arguments:'{}'}}]},finish_reason:'tool_calls'}]}));
 const key=escapedName?'\\u0061rguments':'arguments',payload=base.replace('"arguments":"{}"','"arguments":'+JSON.stringify(args)+',"'+key+'":"{}"');assert.notEqual(payload,base);
 const f=await setup(t,async()=>new Response(payload,{headers:{'content-type':'application/json'}})),response=await f.request(body);assert.equal(response.status,502);assert.equal((await response.json()).error.code,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID');assert.equal(f.budget.requests()[0].usageStatus,'UNKNOWN');
});

// Reproduces the real SDK closing after end_turn, before message_stop/HTTP EOF.
for(const truncated of [false,true])test('minimal streaming waits for a full validated upstream transcript before SDK delivery; truncated='+truncated,async t=>{
 const prefix=event({type:'message_start',message:{id:'offline-drain-message',model:'deepseek-flash'}})+event({type:'content_block_delta',delta:{text:'OFFLINE_COMPLETE_REPLY'}})+event({type:'message_delta',delta:{stop_reason:'end_turn'}}),tail=truncated?'':event({type:'message_stop'});
 let reachedEnd=false,cancelled=false,timer;
 t.after(()=>clearTimeout(timer));
 const f=await setup(t,async()=>new Response(new ReadableStream({
  start(controller){controller.enqueue(new TextEncoder().encode(prefix));timer=setTimeout(()=>{if(cancelled)return;reachedEnd=true;if(tail)controller.enqueue(new TextEncoder().encode(tail));controller.close();},300);},
  cancel(){cancelled=true;clearTimeout(timer);}
 }),{headers:{'content-type':'text/event-stream'}}),1,'anthropic-messages',true);
 const response=await fetch(f.route.url+'/messages',{method:'POST',headers:{'x-api-key':f.route.token,'content-type':'application/json'},body:JSON.stringify({...body,stream:true})}),reader=response.body.getReader();
 let seen='';for(;;){const next=await reader.read();if(next.done)break;seen+=new TextDecoder().decode(next.value);if(seen.includes('end_turn')){await reader.cancel();break;}}
 const until=Date.now()+2000;while(!f.gateway.receipts().length&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
 const receipt=f.gateway.receipts()[0];assert.ok(receipt);
 if(truncated){assert.equal(receipt.minimalResponseVerified,false);assert.equal(receipt.outcome,'MODEL_GATEWAY_STREAM_INCOMPLETE');assert.equal(receipt.responseSha256,null);}
 else{assert.equal(reachedEnd,true);assert.equal(receipt.minimalResponseVerified,true);assert.equal(receipt.responseSha256,hash(prefix+tail));assert.equal(receipt.outputTextHash,hash('OFFLINE_COMPLETE_REPLY'));}
 assert.equal(f.budget.requests().length,1);
});

// ---------------------------------------------------------------------------------------------
// Anthropic Messages usage. This lane used to settle every turn against its full reservation
// because the parser read the frames for identity and stop_reason only. The recorded 2026-11-21
// executor probe spent 78 input and 8 output tokens (220 micros) and was charged 2162688 micros
// (9830x). These tests pin the meter: both frames, the three input counters, the fallback, and the
// shapes that must not lose it — non-streaming, tool_use, and a request carrying tool history.
// ---------------------------------------------------------------------------------------------
const messagesPrice=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
// reservedMicros of the recorded probe: 1048576 input at 2 + 8192 output at 8.
const RESERVED_FOR_8192_OUTPUT=2162688;
async function messagesSetup(t,transport,{forbidTools=false}={}) {
    let gateway,budget;
    t.after(async () => { await gateway?.close(); budget?.close(); });
    const h=harness(t);
    budget=new NativeBudget(resolve(h.dir,'messages-budget.sqlite'),{scopeId:'OFFLINE',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
    // maxOutputTokens 8192 reproduces the recorded probe's 2162688 reservation exactly.
    gateway=new DeepSeekGateway(budget,messagesPrice,'OFFLINE_UPSTREAM_KEY',8192,1,transport,'anthropic-messages',forbidTools);
    const route=await gateway.start();
    const send=(extra={})=>fetch(route.url+'/messages',{method:'POST',headers:{authorization:'Bearer '+route.token,'content-type':'application/json'},body:JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE_ONLY'}],max_tokens:8192,stream:true,...extra})});
    return {budget,gateway,route,send};
}
const response_=payload=>async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}});
const usageStart=(usage)=>({type:'message_start',message:{id:'offline-usage',model:'deepseek-flash',content:[],stop_reason:null,stop_sequence:null,...(usage?{usage}:{})}});
const textDelta=text=>event({type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
const endDelta=(usage,stop_reason='end_turn')=>event({type:'message_delta',delta:{stop_reason,stop_sequence:null},...(usage?{usage}:{})});

test('Messages streaming settles real usage from both frames, cache reads included',async t=>{
    const payload=event(usageStart({input_tokens:60,cache_read_input_tokens:18,cache_creation_input_tokens:0,output_tokens:1}))+textDelta('OFFLINE_RESPONSE')+endDelta({output_tokens:8})+event({type:'message_stop'});
    const f=await messagesSetup(t,response_(payload));
    const response=await f.send();assert.equal(response.status,200);await response.text();
    const [row]=f.budget.requests(),receipt=f.gateway.receipts()[0];
    assert.equal(row.usageStatus,'KNOWN');
    // 60 uncached + 18 cache reads + 0 cache writes, and the final output count from the delta.
    assert.deepEqual(row.usage,{inputTokens:78,outputTokens:8,cacheHitTokens:18});
    // 60 miss tokens at 2 + 18 cache reads at 0.04 + 8 output at 8 = 120 + 0.72 + 64 micros.
    assert.equal(row.chargedMicros,185);
    assert.equal(row.reservedMicros,RESERVED_FOR_8192_OUTPUT);
    assert.notEqual(row.chargedMicros,row.reservedMicros);
    assert.equal(f.budget.summary().committedMicros,185);
    assert.deepEqual(receipt.usage,{inputTokens:78,outputTokens:8,cacheHitTokens:18});
});

test('the recorded 78-in/8-out Messages turn settles 220 micros, not its 2162688 reservation',async t=>{
    const payload=event(usageStart({input_tokens:78,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}))+textDelta('OFFLINE_RESPONSE')+endDelta({output_tokens:8})+event({type:'message_stop'});
    const f=await messagesSetup(t,response_(payload));
    const response=await f.send();assert.equal(response.status,200);await response.text();
    const [row]=f.budget.requests();
    assert.equal(row.usageStatus,'KNOWN');
    assert.deepEqual(row.usage,{inputTokens:78,outputTokens:8,cacheHitTokens:0});
    assert.equal(row.chargedMicros,220);
    assert.equal(row.reservedMicros,RESERVED_FOR_8192_OUTPUT);
    assert.notEqual(row.chargedMicros,row.reservedMicros);
    assert.equal(Math.round(row.reservedMicros/row.chargedMicros),9830);
});

test('a Messages turn with no usage anywhere keeps the reservation fallback',async t=>{
    const payload=event(usageStart())+textDelta('OFFLINE_RESPONSE')+endDelta()+event({type:'message_stop'});
    const f=await messagesSetup(t,response_(payload));
    const response=await f.send();assert.equal(response.status,200);await response.text();
    const [row]=f.budget.requests();
    assert.equal(row.usageStatus,'UNKNOWN');
    assert.equal(row.usage,null);
    assert.equal(row.chargedMicros,RESERVED_FOR_8192_OUTPUT);
    assert.equal(row.chargedMicros,row.reservedMicros);
    assert.equal(f.gateway.receipts()[0].usage,null);
});

test('message_delta alone supplies the output count',async t=>{
    // The input side arrives without any output key; only the delta knows how many tokens were written.
    const payload=event(usageStart({input_tokens:60,cache_read_input_tokens:18}))+textDelta('OFFLINE_RESPONSE')+endDelta({output_tokens:8})+event({type:'message_stop'});
    const f=await messagesSetup(t,response_(payload));
    const response=await f.send();assert.equal(response.status,200);await response.text();
    const [row]=f.budget.requests();
    assert.equal(row.usageStatus,'KNOWN');
    assert.deepEqual(row.usage,{inputTokens:78,outputTokens:8,cacheHitTokens:18});
    assert.equal(row.chargedMicros,185);
    assert.equal(row.reservedMicros,RESERVED_FOR_8192_OUTPUT);
});

test('a turn that reports output tokens only is billed for what it reported',async t=>{
    // A partial but real report still beats charging the whole reservation for it.
    const payload=event(usageStart())+textDelta('OFFLINE_RESPONSE')+endDelta({output_tokens:8})+event({type:'message_stop'});
    const f=await messagesSetup(t,response_(payload));
    const response=await f.send();assert.equal(response.status,200);await response.text();
    const [row]=f.budget.requests();
    assert.equal(row.usageStatus,'KNOWN');
    assert.deepEqual(row.usage,{inputTokens:0,outputTokens:8,cacheHitTokens:0});
    assert.equal(row.chargedMicros,64);
    assert.notEqual(row.chargedMicros,row.reservedMicros);
});

test('a tool_use round with tool history settles its usage and still releases the tool block',async t=>{
    const payload=event(usageStart({input_tokens:78,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}))+
        event({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'offline-tool',name:'read_file',input:{}}})+
        event({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"path":"README.md"}'}})+
        event({type:'content_block_stop',index:0})+endDelta({output_tokens:8},'tool_use')+event({type:'message_stop'});
    const f=await messagesSetup(t,response_(payload));
    const history=[{role:'user',content:'OFFLINE_ONLY'},{role:'assistant',content:[{type:'tool_use',id:'prior-tool',name:'read_file',input:{path:'README.md'}},{type:'text',text:'prior'}]},{role:'user',content:[{type:'tool_result',tool_use_id:'prior-tool',content:'ok'}]}];
    const response=await f.send({messages:history});assert.equal(response.status,200);
    const body=await response.text();
    // The tool block is still delivered to the SDK; the meter must survive the tool path.
    assert.match(body,/read_file|input_json_delta/);
    const [row]=f.budget.requests();
    assert.equal(row.usageStatus,'KNOWN');
    assert.deepEqual(row.usage,{inputTokens:78,outputTokens:8,cacheHitTokens:0});
    assert.equal(row.chargedMicros,220);
    assert.notEqual(row.chargedMicros,row.reservedMicros);
});

test('a non-streaming Messages document settles its reported usage',async t=>{
    const doc={id:'offline-usage',model:'deepseek-flash',content:[{type:'text',text:'OFFLINE_RESPONSE'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:78,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:8}};
    const f=await messagesSetup(t,async()=>Response.json(doc));
    const response=await f.send({stream:false});assert.equal(response.status,200);
    assert.deepEqual(await response.json(),doc);
    const [row]=f.budget.requests();
    assert.equal(row.usageStatus,'KNOWN');
    assert.deepEqual(row.usage,{inputTokens:78,outputTokens:8,cacheHitTokens:0});
    assert.equal(row.chargedMicros,220);
    assert.equal(row.reservedMicros,RESERVED_FOR_8192_OUTPUT);
    assert.notEqual(row.chargedMicros,row.reservedMicros);
});
