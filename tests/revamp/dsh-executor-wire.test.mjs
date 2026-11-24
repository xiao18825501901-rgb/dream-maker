import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDshExecutorExchange} from '../../dist/server/flow/dsh-executor-wire.js';
import {model,qualified,systemText,prompt,answer,readSchema,searchSchema,context,user,assistantText,assistantCalls,results,requestBody,roundTrip,parallel,ingress,usage,textStream,usageTrailerStream,toolStream,parallelStream,upstream,frames,responseId,responsesUsage,responsesEvents,responsesFrame,serializeResponses,responsesStream,textParts,callParts} from '../fixtures/dsh-executor-wire.mjs';

const sse='text/event-stream';
const exchange=ctx=>createDshExecutorExchange(ctx);
const failure=code=>e=>e.code===code&&!Object.hasOwn(e,'sse')&&!Object.hasOwn(e,'text');
const bad='MODEL_GATEWAY_COMPLETION_INVALID',unknown='NATIVE_USAGE_UNKNOWN',invalid='CLAUDE_MESSAGES_REQUEST_INVALID';
const args='{"path":"src/app.ts"}';
const complete=(body,ctx=context())=>exchange(ctx).prepare(ingress(roundTrip())).complete(upstream(body));
const frame=row=>'data: '+JSON.stringify(row)+'\n\n';
const head=(choices,extra)=>({id:'fixture_chat_1',object:'chat.completion.chunk',created:1,model:qualified,choices,...extra});
const textRows=()=>[
    head([{index:0,delta:{role:'assistant',content:''},finish_reason:null}]),
    head([{index:0,delta:{content:answer},finish_reason:null}]),
    head([{index:0,delta:{},finish_reason:'stop'}],{usage:usage()}),
];
const toolRows=()=>[
    head([{index:0,delta:{role:'assistant',content:''},finish_reason:null}]),
    head([{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'desk_read',arguments:args}}]},finish_reason:null}]),
    head([{index:0,delta:{},finish_reason:'tool_calls'}],{usage:usage()}),
];
const encode=(rows,tail=true)=>rows.map(frame).join('')+(tail?'data: [DONE]\n\n':'');

test('单轮纯文本 freezes the executor turn and translates the text answer',async()=>{
    const ctx=context();const x=exchange(ctx);ctx.limits.model='mutated';ctx.route.model='unrelated';ctx.route.provider='other';
    const p=x.prepare(ingress(requestBody())),wire=JSON.parse(p.body);
    assert.equal(p.path,'/v1/chat/completions');assert.equal(p.maxOutputTokens,512);
    assert.deepEqual(wire,{model:qualified,stream:true,max_tokens:512,
        messages:[{role:'system',content:systemText},{role:'user',content:prompt}],
        tools:[{type:'function',function:{name:'desk_read',description:'Read one project file.',parameters:readSchema}},
            {type:'function',function:{name:'desk_search',description:'Search project text.',parameters:searchSchema}}]});
    const raw=textStream(),out=await p.complete(upstream(raw));
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(out.responseSha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(out.outputTextHash,createHash('sha256').update(answer).digest('hex'));
    assert.equal(out.finishReason,'end_turn');assert.equal(out.observedUpstreamModel,qualified);assert.equal(out.model,model);
    const events=frames(out.sse);
    assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
    assert.deepEqual(events[0].message.usage,{input_tokens:6,output_tokens:0,cache_read_input_tokens:2,cache_creation_input_tokens:0});
    assert.deepEqual(events[1].content_block,{type:'text',text:''});
    assert.equal(events[2].delta.text,answer);assert.deepEqual(events[3],{type:'content_block_stop',index:0});
    assert.deepEqual(events[4].delta,{stop_reason:'end_turn',stop_sequence:null});assert.equal(events[4].usage.output_tokens,3);
    assert.throws(()=>x.prepare(ingress(requestBody())),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
    await assert.rejects(p.complete(upstream(raw)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
});

test('全文本无工具 declares no tools and replays a plain text history',async()=>{
    const body=requestBody();body.tools=[];
    body.messages=[user('read the tree'),assistantText('the tree has three files'),user('now report')];
    const wire=JSON.parse(exchange(context()).prepare(ingress(body)).body);
    assert.equal(Object.hasOwn(wire,'tools'),false);assert.equal(Object.hasOwn(wire,'tool_choice'),false);
    assert.deepEqual(wire.messages,[{role:'system',content:systemText},{role:'user',content:'read the tree'},
        {role:'assistant',content:'the tree has three files'},{role:'user',content:'now report'}]);
});

test('单工具往返 replays tool_use as a function call and tool_result as a tool turn',async()=>{
    const wire=JSON.parse(exchange(context()).prepare(ingress(roundTrip())).body);
    assert.deepEqual(wire.messages,[{role:'system',content:systemText},{role:'user',content:prompt},
        {role:'assistant',content:null,tool_calls:[{id:'toolu_01',type:'function',function:{name:'desk_read',arguments:args}}]},
        {role:'tool',tool_call_id:'toolu_01',content:'export const a = 1;'}]);
    const out=await complete(textStream());
    assert.equal(out.finishReason,'end_turn');assert.deepEqual(frames(out.sse).map(e=>e.type),
        ['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
});

test('多工具并行调用 keeps round order and emits one tool_use block per call',async()=>{
    const wire=JSON.parse(exchange(context()).prepare(ingress(parallel())).body);
    assert.deepEqual(wire.messages.slice(1),[{role:'user',content:prompt},
        {role:'assistant',content:null,tool_calls:[{id:'toolu_01',type:'function',function:{name:'desk_read',arguments:args}},
            {id:'toolu_02',type:'function',function:{name:'desk_search',arguments:'{"text":"export const"}'}}]},
        {role:'tool',tool_call_id:'toolu_01',content:'export const a = 1;'},
        {role:'tool',tool_call_id:'toolu_02',content:'src/app.ts:1'},
        {role:'assistant',content:null,tool_calls:[{id:'toolu_03',type:'function',function:{name:'desk_read',arguments:'{"path":"src/b.ts"}'}}]},
        {role:'tool',tool_call_id:'toolu_03',content:'export const b = 2;'}]);
    const out=await complete(parallelStream());
    assert.equal(out.finishReason,'tool_use');
    const events=frames(out.sse);
    assert.deepEqual(events.map(e=>e.type),['message_start',
        'content_block_start','content_block_delta','content_block_stop','content_block_start','content_block_delta','content_block_stop',
        'message_delta','message_stop']);
    assert.deepEqual(events[1].content_block,{type:'tool_use',id:'call_a',name:'desk_read',input:{}});
    assert.deepEqual(events[2].delta,{type:'input_json_delta',partial_json:'{"path":"src/app.ts"}'});
    assert.deepEqual(events[4].content_block,{type:'tool_use',id:'call_b',name:'desk_search',input:{}});
    assert.deepEqual(events[5].delta,{type:'input_json_delta',partial_json:'{"text":"export const"}'});
    assert.equal(events[7].delta.stop_reason,'tool_use');assert.equal(out.sse.includes(answer),false);
    assert.equal(out.outputTextHash,createHash('sha256').update('').digest('hex'));
});

test('多轮历史重放 stays byte-ordered for three completed calls',async()=>{
    const body=requestBody();
    body.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a.ts'}}]),results([{id:'toolu_01',output:'A'}]),
        assistantCalls([{id:'toolu_02',name:'desk_read',input:{path:'b.ts'}}],'next'),results([{id:'toolu_02',output:'B'}]),
        assistantCalls([{id:'toolu_03',name:'desk_search',input:{text:'c'}}]),results([{id:'toolu_03',output:'C'}])];
    const wire=JSON.parse(exchange(context()).prepare(ingress(body)).body);
    assert.deepEqual(wire.messages.map(row=>row.role),['system','user','assistant','tool','assistant','tool','assistant','tool']);
    assert.deepEqual(wire.messages.filter(row=>row.role==='tool').map(row=>[row.tool_call_id,row.content]),[['toolu_01','A'],['toolu_02','B'],['toolu_03','C']]);
    assert.deepEqual(wire.messages[4],{role:'assistant',content:'next',tool_calls:[{id:'toolu_02',type:'function',function:{name:'desk_read',arguments:'{"path":"b.ts"}'}}]});
});

test('text beside tool calls gets its own block before every tool_use',async()=>{
    const rows=toolRows();
    rows.splice(1,0,head([{index:0,delta:{content:'Reading.'},finish_reason:null}]));
    const out=await complete(encode(rows));
    const events=frames(out.sse);
    assert.deepEqual(events.map(e=>e.index).filter(index=>index!==undefined),[0,0,0,1,1,1]);
    assert.deepEqual(events[1].content_block,{type:'text',text:''});assert.equal(events[2].delta.text,'Reading.');
    assert.deepEqual(events[4].content_block,{type:'tool_use',id:'call_1',name:'desk_read',input:{}});
    assert.equal(out.finishReason,'tool_use');
});

test('tool_choice auto is forwarded verbatim',async()=>{
    const body=requestBody();body.tool_choice={type:'auto'};
    assert.equal(JSON.parse(exchange(context()).prepare(ingress(body)).body).tool_choice,'auto');
});

test('max_tokens clamps to the frozen output ceiling',async()=>{
    const body=requestBody();body.max_tokens=4096;
    assert.equal(exchange(context()).prepare(ingress(body)).maxOutputTokens,512);
});

test('a usage-only trailer frame is accepted and reconciled once',async()=>{
    const out=await complete(usageTrailerStream());
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(out.finishReason,'end_turn');
});

for(const [name,change] of Object.entries({
    'role planner2':c=>{c.role='planner2';},'role reviewer':c=>{c.role='reviewer';},'role planner1':c=>{c.role='planner1';},
    'runtime pi':c=>{c.route.runtime='pi';},'runtime claude':c=>{c.route.runtime='claude';},
    'protocol messages':c=>{c.route.protocol='anthropic-messages';},'protocol responses':c=>{c.route.protocol='openai-responses';},
    oauth:c=>{c.route.authentication='oauth';},'no account':c=>{c.accounts=[];},'ambiguous account':c=>{c.accounts.push({...c.accounts[0]});},
    'wrong authRef':c=>{c.accounts[0].authRef='other';},'wrong accountRef':c=>{c.accounts[0].accountRef='other';},
    'wrong upstreamAccountRef':c=>{c.accounts[0].upstreamAccountRef='fixture/other';},
    'native messages capability':c=>{c.accounts[0].capabilities.push({model,protocol:'anthropic-messages'});},
    'missing capability':c=>{delete c.accounts[0].capabilities;},'wrong protocol':c=>{c.accounts[0].capabilities[0].protocol='openai-responses';},
    'wrong capability model':c=>{c.accounts[0].capabilities[0].model='else';},'duplicate capability':c=>{c.accounts[0].capabilities.push(c.accounts[0].capabilities[0]);},
    'wrong frozen model':c=>{c.limits.model='other';},'invalid input cap':c=>{c.limits.maxInputTokens=-1;},'zero input cap':c=>{c.limits.maxInputTokens=0;},
    'huge output cap':c=>{c.limits.maxOutputTokens=16001;},'undeclared limit key':c=>{c.limits.prompt='x';},
}))test('deny lane '+name,()=>{const c=context();change(c);
    assert.throws(()=>exchange(c),e=>e.code==='MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'||e.code===invalid);});

const requestNegatives={
    'unknown top level member':b=>{b.temperature=0;},'metadata':b=>{b.metadata={user_id:'x'};},'stream false':b=>{b.stream=false;},
    'thinking enabled':b=>{b.thinking={type:'enabled'};},'missing thinking':b=>{delete b.thinking;},'wrong model':b=>{b.model='other';},
    'zero max_tokens':b=>{b.max_tokens=0;},'fractional max_tokens':b=>{b.max_tokens=1.5;},
    'blank system string':b=>{b.system='   ';},'empty system':b=>{b.system=[];},'blank system block':b=>{b.system=[{type:'text',text:' '}];},
    'image system block':b=>{b.system=[{type:'image',source:{}}];},'system cache control':b=>{b.system=[{type:'text',text:'x',cache_control:{type:'persistent'}}];},
    'nine tools':b=>{b.tools=Array.from({length:9},(_,i)=>({name:'t'+i,input_schema:{type:'object'}}));},
    'duplicate tool names':b=>{b.tools.push({...b.tools[0]});},'tool schema not object':b=>{b.tools[0].input_schema=[];},
    'tool schema missing':b=>{delete b.tools[0].input_schema;},'unknown tool field':b=>{b.tools[0].type='custom';},
    'bad tool name':b=>{b.tools[0].name='desk read';},'tool description type':b=>{b.tools[0].description=1;},
    'forced tool choice':b=>{b.tool_choice={type:'tool',name:'desk_read'};},'tool choice without tools':b=>{b.tools=[];b.tool_choice={type:'auto'};},
    'no messages':b=>{b.messages=[];},'assistant first':b=>{b.messages=[assistantText('x'),user()];},
    'two user turns':b=>{b.messages=[user(),user('again')];},'trailing assistant':b=>{b.messages=[user(),assistantText('x')];},
    'unknown message key':b=>{b.messages[0].name='x';},'unknown role':b=>{b.messages[0].role='system';},
    'empty content':b=>{b.messages[0].content=[];},'image block':b=>{b.messages[0].content=[{type:'image',source:{}}];},
    'thinking block':b=>{b.messages[0].content=[{type:'thinking',thinking:'x'}];},'blank text block':b=>{b.messages[0].content=[{type:'text',text:'  '}];},
    'orphan tool_result':b=>{b.messages=[results([{id:'toolu_x',output:'x'}])];},
    'unknown tool in history':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_delete',input:{}}]),results([{id:'toolu_01',output:'x'}])];},
    'tool input not an object':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:[]}]),results([{id:'toolu_01',output:'x'}])];},
    'tool input unknown key':b=>{b.messages=[user(),{role:'assistant',content:[{type:'tool_use',id:'toolu_01',name:'desk_read',input:{path:'a'},extra:1}]},results([{id:'toolu_01',output:'x'}])];},
    'bad call id':b=>{b.messages=[user(),{role:'assistant',content:[{type:'tool_use',id:'tool u1',name:'desk_read',input:{path:'a'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'tool u1',content:'x'}]}];},
    'result id mismatch':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}}]),results([{id:'toolu_02',output:'x'}])];},
    'result count mismatch':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}},{id:'toolu_02',name:'desk_read',input:{path:'b'}}]),results([{id:'toolu_01',output:'x'}])];},
    'result order swapped':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}},{id:'toolu_02',name:'desk_read',input:{path:'b'}}]),results([{id:'toolu_02',output:'b'},{id:'toolu_01',output:'a'}])];},
    'text beside result':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}}]),{role:'user',content:[{type:'text',text:'and'},{type:'tool_result',tool_use_id:'toolu_01',content:'x'}]}];},
    'duplicate call id across rounds':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}}]),results([{id:'toolu_01',output:'x'}]),
        assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'b'}}]),results([{id:'toolu_01',output:'y'}])];},
    'duplicate call id in one turn':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}},{id:'toolu_01',name:'desk_search',input:{text:'b'}}]),
        results([{id:'toolu_01',output:'x'},{id:'toolu_01',output:'y'}])];},
    'result content type':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}}]),{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_01',content:1}]}];},
    'result is_error type':b=>{b.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a'}}]),{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_01',content:'x',is_error:'yes'}]}];},
    'oversized history':b=>{b.messages=[user('x'.repeat(300000))];},
};
for(const [name,change] of Object.entries(requestNegatives))test('reject request '+name,()=>{
    const body=requestBody();change(body);
    assert.throws(()=>exchange(context()).prepare(ingress(body)),failure(invalid));
});

test('a tool_result is_error flag never authors replacement text',async()=>{
    const body=requestBody();
    body.tools.push({name:'desk_write',description:'Write one project file.',input_schema:{type:'object'}});
    body.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_write',input:{path:'a',content:'b'}}]),
        {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_01',content:'denied',is_error:true}]}];
    const wire=JSON.parse(exchange(context()).prepare(ingress(body)).body);
    assert.deepEqual(wire.messages.at(-1),{role:'tool',tool_call_id:'toolu_01',content:'denied'});
});

for(const [name,attr] of Object.entries({version:{version:'latest'},path:{path:'/v1/messages?x=1'},method:{method:'GET'},
    media:{contentType:'text/plain'},raw:{body:' '.repeat(262145)},'duplicate keys':{body:'{"model":"a","\u006dodel":"b"}'}}))test('reject ingress '+name,()=>{
    assert.throws(()=>exchange(context()).prepare({...ingress(requestBody()),...attr}),e=>[invalid,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(e.code));
});

const toolNegatives={
    'unknown tool name':r=>{r[1].choices[0].delta.tool_calls[0].function.name='desk_delete';},
    'arguments not json':r=>{r[1].choices[0].delta.tool_calls[0].function.arguments='{not json';},
    'arguments not an object':r=>{r[1].choices[0].delta.tool_calls[0].function.arguments='[1]';},
    'missing call id':r=>{r[1].choices[0].delta.tool_calls[0].id='';},
    'missing call type':r=>{r[1].choices[0].delta.tool_calls[0].type='';},
    'sparse call index':r=>{r[1].choices[0].delta.tool_calls[0].index=1;},
    'call index out of range':r=>{r[1].choices[0].delta.tool_calls[0].index=8;},
    'tool calls with stop':r=>{r[2].choices[0].finish_reason='stop';},
};
for(const [name,mutate] of Object.entries(toolNegatives))test('reject tool stream '+name,async()=>{
    const rows=toolRows();mutate(rows);
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream(encode(rows))),
        e=>[bad,unknown,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(e.code));
});

const responseNegatives={
    'stop without text':r=>{r[1].choices[0].delta={};},
    'truncated length':r=>{r[2].choices[0].finish_reason='length';},
    'content filtered':r=>{r[2].choices[0].finish_reason='content_filter';},
    'duplicate finish':r=>{r.push(JSON.parse(JSON.stringify(r[2])));},
    'content after finish':r=>{r.push(head([{index:0,delta:{content:'late'},finish_reason:null}]));},
    'reasoning delta':r=>{r[1].choices[0].delta.reasoning_content='x';},
    'legacy function call':r=>{r[1].choices[0].delta.function_call={name:'desk_read'};},
    'wrong delta role':r=>{r[0].choices[0].delta.role='user';},
    'wrong object':r=>{r[0].object='chat.completion';},
    'wrong model':r=>{for(const row of r)row.model='other/model';},
    'model drift':r=>{r[2].model=model;},
    'id drift':r=>{r[2].id='fixture_chat_2';},
    'two choices':r=>{r[1].choices.push({index:1,delta:{},finish_reason:null});},
    'wrong choice index':r=>{r[1].choices[0].index=1;},
    logprobs:r=>{r[2].choices[0].logprobs={content:[]};},
    'unknown delta key':r=>{r[1].choices[0].delta.audio='x';},
    'unknown chunk key':r=>{r[0].service_tier='auto';},
    'empty choices':r=>{r[1].choices=[];},
    'empty choices with usage':r=>{r[2].choices=[];},
    'missing usage':r=>{delete r[2].usage;},
    'cached above prompt':r=>{r[2].usage={prompt_tokens:2,completion_tokens:3,prompt_tokens_details:{cached_tokens:9},total_tokens:5};},
    'conflicting hit tokens':r=>{r[2].usage={...usage(),prompt_cache_hit_tokens:1};},
    'conflicting miss tokens':r=>{r[2].usage={...usage(),prompt_cache_miss_tokens:1};},
    'cache write charge':r=>{r[2].usage={...usage(),cache_creation_input_tokens:1};},
    'bad total':r=>{r[2].usage={...usage(),total_tokens:9};},
    'fractional tokens':r=>{r[2].usage={...usage(),prompt_tokens:7.5};},
    'missing cache detail':r=>{r[2].usage={prompt_tokens:8,completion_tokens:3,total_tokens:11};},
};
for(const [name,mutate] of Object.entries(responseNegatives))test('reject chat stream '+name,async()=>{
    const rows=textRows();mutate(rows);
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream(encode(rows))),
        e=>[bad,unknown,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(e.code));
});

test('reject chat stream no done sentinel',async()=>{
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream(textRows().map(frame).join(''))),failure(bad));
});
test('reject chat stream trailing frame after done',async()=>{
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream(encode(textRows())+frame(textRows()[0]))),
        failure(bad));
});
test('reject chat stream unterminated tail',async()=>{
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream(encode(textRows()).replace(/\n\n$/,''))),failure(bad));
});
test('reject chat stream leading empty frame',async()=>{
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream('\n\n'+encode(textRows()))),failure(bad));
});
test('reject chat stream foreign event field',async()=>{
    const raw=textRows().map((row,index)=>index===1?'event: message\ndata: '+JSON.stringify(row)+'\n\n':frame(row)).join('')+'data: [DONE]\n\n';
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream(raw)),failure(bad));
});
test('reject chat stream duplicate json key',async()=>{
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream('data: {"id":"a","\u0069d":"b"}\n\ndata: [DONE]\n\n')),
        e=>e.code==='MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID');
});
test('reject chat stream bare cr line endings',async()=>{
    await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(upstream(encode(textRows()).replace(/\n/g,'\r'))),failure(bad));
});

test('invalid media, status, size and utf-8 are refused before release',async()=>{
    for(const response of [upstream(textStream(),'application/json'),new Response('error',{status:429,headers:{'content-type':sse}}),
        upstream('x'.repeat(2000001)),upstream(Uint8Array.from([255]))])
        await assert.rejects(exchange(context()).prepare(ingress(roundTrip())).complete(response));
});

test('over budget preserves exact chargeable usage and no frames',async()=>{
    const c=context();c.limits.maxInputTokens=7;
    await assert.rejects(exchange(c).prepare(ingress(roundTrip())).complete(upstream(textStream())),e=>{
        assert.equal(e.code,'NATIVE_USAGE_BOUND_EXCEEDED');
        assert.deepEqual(e.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
        assert.equal(Object.hasOwn(e,'sse'),false);return true;
    });
});

test('an output overrun beyond the clamped ceiling is charged, not released',async()=>{
    const body=requestBody();body.max_tokens=2;
    await assert.rejects(exchange(context()).prepare(ingress(body)).complete(upstream(textStream())),failure('NATIVE_USAGE_BOUND_EXCEEDED'));
});

test('split text deltas are reassembled and checked before release',async()=>{
    let detected=false;const c=context();
    c.assertSafe=value=>{if(value===answer){detected=true;throw new Error('blocked');}};
    await assert.rejects(exchange(c).prepare(ingress(roundTrip())).complete(upstream(textStream())));
    assert.equal(detected,true);
});

// ---------------------------------------------------------------------------------------------
// The Responses outlet. One lane, one more wire: the same frozen executor turn, replayed as
// instructions plus ordered input items and read back from a closed Responses stream.
// ---------------------------------------------------------------------------------------------
const responsesRoute=()=>context('openai-responses');
const rsExchange=ctx=>createDshExecutorExchange(ctx);
const completeResponses=(raw,ctx=responsesRoute())=>rsExchange(ctx).prepare(ingress(roundTrip())).complete(upstream(raw));
const without=(events,type,occurrence=0)=>{let seen=0;return events.filter(event=>{if(event.type!==type)return true;return seen++!==occurrence;});};
const replace=(events,type,change,occurrence=0)=>{let seen=0;return events.map(event=>event.type===type&&seen++===occurrence?change({...event}):event);};
const withUsage=(events,usageRaw)=>replace(events,'response.completed',event=>({...event,response:{...event.response,usage:usageRaw}}));
const textBase=()=>responsesEvents(textParts());
const callBase=()=>responsesEvents(callParts({id:'fc_1',call_id:'call_fixture_1',name:'desk_read',arguments:args}));

test('responses 单轮纯文本 freezes an instructions/input turn and translates the text answer',async()=>{
    const ctx=responsesRoute();const x=rsExchange(ctx);ctx.limits.model='mutated';ctx.route.model='unrelated';ctx.route.provider='other';
    const p=x.prepare(ingress(requestBody()));
    assert.equal(p.path,'/v1/responses');assert.equal(p.maxOutputTokens,512);
    assert.deepEqual(JSON.parse(p.body),{model:qualified,store:false,stream:true,max_output_tokens:512,instructions:systemText,
        input:[{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}],
        tools:[{type:'function',name:'desk_read',description:'Read one project file.',parameters:readSchema},
            {type:'function',name:'desk_search',description:'Search project text.',parameters:searchSchema}]});
    const raw=responsesStream(textParts()),out=await p.complete(upstream(raw));
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(out.responseSha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(out.outputTextHash,createHash('sha256').update(answer).digest('hex'));
    assert.equal(out.finishReason,'end_turn');assert.equal(out.observedUpstreamModel,qualified);
    assert.equal(out.responseId,responseId);assert.equal(out.model,model);
    const events=frames(out.sse);
    assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
    assert.deepEqual(events[0].message.usage,{input_tokens:6,output_tokens:0,cache_read_input_tokens:2,cache_creation_input_tokens:0});
    assert.deepEqual(events[1].content_block,{type:'text',text:''});
    assert.equal(events[2].delta.text,answer);assert.deepEqual(events[3],{type:'content_block_stop',index:0});
    assert.deepEqual(events[4].delta,{stop_reason:'end_turn',stop_sequence:null});assert.equal(events[4].usage.output_tokens,3);
    assert.throws(()=>x.prepare(ingress(requestBody())),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
    await assert.rejects(p.complete(upstream(raw)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
});

test('responses 无工具 declares no tools and never forwards a declared auto tool choice',async()=>{
    const body=requestBody();body.tools=[];
    body.messages=[user('read the tree'),assistantText('the tree has three files'),user('now report')];
    const wire=JSON.parse(rsExchange(responsesRoute()).prepare(ingress(body)).body);
    assert.equal(Object.hasOwn(wire,'tools'),false);assert.equal(Object.hasOwn(wire,'tool_choice'),false);
    assert.deepEqual(wire.input,[{type:'message',role:'user',content:[{type:'input_text',text:'read the tree'}]},
        {type:'message',role:'assistant',content:[{type:'input_text',text:'the tree has three files'}]},
        {type:'message',role:'user',content:[{type:'input_text',text:'now report'}]}]);
    const choice=requestBody();choice.tool_choice={type:'auto'};
    assert.equal(Object.hasOwn(JSON.parse(rsExchange(responsesRoute()).prepare(ingress(choice)).body),'tool_choice'),false);
});

test('responses 两轮往返 replays tool_use as function_call and tool_result as function_call_output',async()=>{
    const wire=JSON.parse(rsExchange(responsesRoute()).prepare(ingress(parallel())).body);
    assert.deepEqual(wire.input,[{type:'message',role:'user',content:[{type:'input_text',text:prompt}]},
        {type:'function_call',call_id:'toolu_01',name:'desk_read',arguments:args},
        {type:'function_call',call_id:'toolu_02',name:'desk_search',arguments:'{"text":"export const"}'},
        {type:'function_call_output',call_id:'toolu_01',output:'export const a = 1;'},
        {type:'function_call_output',call_id:'toolu_02',output:'src/app.ts:1'},
        {type:'function_call',call_id:'toolu_03',name:'desk_read',arguments:'{"path":"src/b.ts"}'},
        {type:'function_call_output',call_id:'toolu_03',output:'export const b = 2;'}]);
});

test('responses 文本加工具 keeps the assistant prose as a message item ahead of its calls',()=>{
    const body=requestBody();
    body.messages=[user(),assistantCalls([{id:'toolu_01',name:'desk_read',input:{path:'a.ts'}}],'Reading.'),results([{id:'toolu_01',output:'A'}])];
    const wire=JSON.parse(rsExchange(responsesRoute()).prepare(ingress(body)).body);
    assert.deepEqual(wire.input,[{type:'message',role:'user',content:[{type:'input_text',text:prompt}]},
        {type:'message',role:'assistant',content:[{type:'input_text',text:'Reading.'}]},
        {type:'function_call',call_id:'toolu_01',name:'desk_read',arguments:'{"path":"a.ts"}'},
        {type:'function_call_output',call_id:'toolu_01',output:'A'}]);
});

test('responses 单工具 turns one function_call item into a tool_use block',async()=>{
    const out=await completeResponses(responsesStream(callParts({id:'fc_1',call_id:'call_fixture_1',name:'desk_read',arguments:args})));
    assert.equal(out.finishReason,'tool_use');
    assert.equal(out.outputTextHash,createHash('sha256').update('').digest('hex'));
    const events=frames(out.sse);
    assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
    assert.deepEqual(events[1].content_block,{type:'tool_use',id:'call_fixture_1',name:'desk_read',input:{}});
    assert.deepEqual(events[2].delta,{type:'input_json_delta',partial_json:'{"path":"src/app.ts"}'});
    assert.equal(events[4].delta.stop_reason,'tool_use');assert.equal(out.sse.includes(answer),false);
});

test('responses 多工具 keeps item order and emits one tool_use block per function_call',async()=>{
    const calls=[{id:'fc_a',call_id:'call_a',name:'desk_read',arguments:'{"path":"src/app.ts"}'},
        {id:'fc_b',call_id:'call_b',name:'desk_search',arguments:'{"text":"export const"}'},
        {id:'fc_c',call_id:'call_c',name:'desk_read',arguments:'{"path":"src/b.ts"}'}];
    const out=await completeResponses(responsesStream(callParts(...calls)));
    const events=frames(out.sse);
    assert.deepEqual(events.map(e=>e.type),['message_start',
        'content_block_start','content_block_delta','content_block_stop',
        'content_block_start','content_block_delta','content_block_stop',
        'content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
    assert.deepEqual(events.filter(e=>e.content_block).map(e=>e.content_block.id),['call_a','call_b','call_c']);
    assert.deepEqual(events.filter(e=>e.content_block).map(e=>e.index),[0,1,2]);
    assert.deepEqual(events.filter(e=>e.delta&&e.delta.type==='input_json_delta').map(e=>e.delta.partial_json),
        ['{"path":"src/app.ts"}','{"text":"export const"}','{"path":"src/b.ts"}']);
    assert.equal(out.finishReason,'tool_use');
});

test('responses text beside function calls gets its own block before every tool_use',async()=>{
    const out=await completeResponses(responsesStream([...textParts('Reading.'),...callParts({id:'fc_1',call_id:'call_fixture_1',name:'desk_read',arguments:args})]));
    const events=frames(out.sse);
    assert.deepEqual(events.filter(e=>e.content_block).map(e=>e.index),[0,1]);
    assert.deepEqual(events[1].content_block,{type:'text',text:''});assert.equal(events[2].delta.text,'Reading.');
    assert.deepEqual(events[4].content_block,{type:'tool_use',id:'call_fixture_1',name:'desk_read',input:{}});
    assert.equal(out.finishReason,'tool_use');assert.equal(out.sse.includes(answer),false);
});

test('responses admits exactly eight function calls and refuses a ninth item',async()=>{
    const calls=Array.from({length:8},(_,index)=>({id:'fc_'+index,call_id:'call_'+index,name:'desk_read',arguments:'{"path":"a'+index+'.ts"}'}));
    const out=await completeResponses(responsesStream(callParts(...calls)));
    assert.deepEqual(frames(out.sse).filter(e=>e.content_block).map(e=>e.content_block.id),calls.map(call=>call.call_id));
    await assert.rejects(completeResponses(responsesStream(callParts(...calls,{id:'fc_9',call_id:'call_9',name:'desk_read',arguments:'{}'}))),failure(bad));
});

test('responses accepts one trailing [DONE] sentinel after response.completed',async()=>{
    const out=await completeResponses(responsesStream(textParts(),{sentinel:true}));
    assert.equal(out.finishReason,'end_turn');assert.equal(frames(out.sse)[2].delta.text,answer);
});

test('a model that declares only Chat never reaches the Responses outlet',()=>{
    const chatOnly=responsesRoute();chatOnly.accounts[0].capabilities=[{model,protocol:'chat-completions'}];
    assert.throws(()=>rsExchange(chatOnly),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
    const native=responsesRoute();native.accounts[0].capabilities.push({model,protocol:'anthropic-messages'});
    assert.throws(()=>rsExchange(native),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
    const missing=responsesRoute();missing.accounts[0].capabilities=[{model,protocol:'chat-completions'},{model,protocol:'chat-completions'}];
    assert.throws(()=>rsExchange(missing),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
    // Both OpenAI wires declared: the resolved protocol is the one this exchange builds.
    const both=responsesRoute();both.accounts[0].capabilities.push({model,protocol:'chat-completions'});
    assert.equal(rsExchange(both).prepare(ingress(roundTrip())).path,'/v1/responses');
});

const responsesNegatives={
    'missing response.completed':e=>serializeResponses(without(e,'response.completed')),
    'missing output_item.done':e=>serializeResponses(without(e,'response.output_item.done')),
    'delta before the content part opens':e=>serializeResponses(without(e,'response.content_part.added')),
    'delta after the item is closed':e=>serializeResponses([...e.slice(0,-1),e[6],e.at(-1)]),
    'text done mismatch':e=>serializeResponses(replace(e,'response.output_text.done',event=>({...event,text:answer+'x'}))),
    'closing part mismatch':e=>serializeResponses(replace(e,'response.content_part.done',event=>({...event,part:{type:'output_text',text:'other',annotations:[]}}))),
    'closing item text mismatch':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,content:[{type:'output_text',text:'other',annotations:[]}]}}))),
    'closing item id mismatch':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,id:'msg_other'}}))),
    'closing item type mismatch':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,type:'function_call'}}))),
    'closing item status in progress':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,status:'in_progress'}}))),
    'completed output mismatch':e=>serializeResponses(replace(e,'response.completed',event=>({...event,response:{...event.response,output:[]}}))),
    'completed status incomplete':e=>serializeResponses(replace(e,'response.completed',event=>({...event,response:{...event.response,status:'incomplete'}}))),
    'completed error':e=>serializeResponses(replace(e,'response.completed',event=>({...event,response:{...event.response,error:{code:'server_error'}}}))),
    'completed incomplete details':e=>serializeResponses(replace(e,'response.completed',event=>({...event,response:{...event.response,incomplete_details:{reason:'max_output_tokens'}}}))),
    'completed id drift':e=>serializeResponses(replace(e,'response.completed',event=>({...event,response:{...event.response,id:'resp_other'}}))),
    'completed model drift':e=>serializeResponses(replace(e,'response.completed',event=>({...event,response:{...event.response,model:'other/model'}}))),
    'frame after completed':e=>serializeResponses([...e,e[1]]),
    'frame after the done sentinel':e=>serializeResponses(e,'data: [DONE]\n\n')+responsesFrame(e[1],99),
    'duplicate response.created':e=>serializeResponses([e[0],e[0],...e.slice(1)]),
    'unknown event type':e=>serializeResponses(replace(e,'response.output_text.delta',event=>({...event,type:'response.reasoning_text.delta'}))),
    'event name mismatch':e=>serializeResponses(replace(e,'response.output_text.delta',event=>({...event,name:'response.output_text.done'}))),
    'sequence gap':e=>serializeResponses(e.map((event,index)=>index===5?{...event,sequence_number:42}:event)),
    'missing sequence number':e=>serializeResponses(e.map((event,index)=>index===4?{...event,sequence_number:undefined}:event)),
    'bare carriage return':e=>serializeResponses(e).replace(/\n/g,'\r'),
    'unterminated tail':e=>serializeResponses(e).replace(/\n\n$/,''),
    'missing usage':e=>serializeResponses(replace(e,'response.completed',event=>{const {usage,...rest}=event.response;return {...event,response:rest};})),
    'usage total mismatch':e=>serializeResponses(withUsage(e,{...responsesUsage(),total_tokens:9})),
    'cached above input':e=>serializeResponses(withUsage(e,{...responsesUsage(),input_tokens_details:{cached_tokens:9}})),
    'missing cache detail':e=>serializeResponses(withUsage(e,{input_tokens:8,output_tokens:3,total_tokens:11})),
    'cache write charge':e=>serializeResponses(withUsage(e,{...responsesUsage(),cache_creation_input_tokens:1})),
    'fractional tokens':e=>serializeResponses(withUsage(e,{...responsesUsage(),input_tokens:7.5})),
    'negative output tokens':e=>serializeResponses(withUsage(e,{...responsesUsage(),output_tokens:-1})),
    'completed without an item':()=>serializeResponses(responsesEvents([])),
};
for(const [name,mutate] of Object.entries(responsesNegatives))test('reject responses stream '+name,async()=>{
    await assert.rejects(completeResponses(mutate(textBase())),e=>[bad,unknown,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(e.code));
});

const responsesCallNegatives={
    'undeclared tool name':e=>serializeResponses(replace(e,'response.output_item.added',event=>({...event,item:{...event.item,name:'desk_delete'}}))),
    'call id is not an id':e=>serializeResponses(replace(e,'response.output_item.added',event=>({...event,item:{...event.item,call_id:'call 1'}}))),
    'item id is not an id':e=>serializeResponses(replace(e,'response.output_item.added',event=>({...event,item:{...event.item,id:'fc 1'}}))),
    'arguments on the added item':e=>serializeResponses(replace(e,'response.output_item.added',event=>({...event,item:{...event.item,arguments:'{}'}}))),
    'missing arguments done':e=>serializeResponses(without(e,'response.function_call_arguments.done')),
    'arguments done mismatch':e=>serializeResponses(replace(e,'response.function_call_arguments.done',event=>({...event,arguments:args+' '}))),
    'closing call id mismatch':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,call_id:'call_other'}}))),
    'closing name mismatch':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,name:'desk_search'}}))),
    'closing arguments mismatch':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,arguments:'{}'}}))),
    'closing status in progress':e=>serializeResponses(replace(e,'response.output_item.done',event=>({...event,item:{...event.item,status:'in_progress'}}))),
    'unclosed item before completed':e=>serializeResponses(without(e,'response.output_item.done')),
    'second item opens while one is open':e=>serializeResponses([...e.slice(0,4),e[2],...e.slice(4)]),
    'item index skips':e=>serializeResponses(replace(e,'response.output_item.added',event=>({...event,output_index:1}))),
};
for(const [name,mutate] of Object.entries(responsesCallNegatives))test('reject responses function_call '+name,async()=>{
    await assert.rejects(completeResponses(mutate(callBase())),e=>[bad,unknown,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(e.code));
});

test('responses refuses a repeated call_id, a repeated item id and a second message item',async()=>{
    await assert.rejects(completeResponses(serializeResponses(responsesEvents(callParts(
        {id:'fc_a',call_id:'call_x',name:'desk_read',arguments:args},
        {id:'fc_b',call_id:'call_x',name:'desk_search',arguments:'{"text":"x"}'})))),failure(bad));
    await assert.rejects(completeResponses(serializeResponses(responsesEvents(callParts(
        {id:'fc_a',call_id:'call_x',name:'desk_read',arguments:args},
        {id:'fc_a',call_id:'call_y',name:'desk_search',arguments:'{"text":"x"}'})))),failure(bad));
    await assert.rejects(completeResponses(serializeResponses(responsesEvents(
        [{kind:'message',id:'msg_1',text:answer},{kind:'message',id:'msg_2',text:'again'}]))),failure(bad));
    // A tool call whose model declares no tools at all is never a declared call.
    const noTools=requestBody();noTools.tools=[];
    await assert.rejects(rsExchange(responsesRoute()).prepare(ingress(noTools))
        .complete(upstream(responsesStream(callParts({id:'fc_1',call_id:'call_fixture_1',name:'desk_read',arguments:args})))),failure(bad));
});

test('responses arguments must be one JSON object and are checked before release',async()=>{
    for(const raw of ['{not json','[1]','{"a":1}{"b":2}'])
        await assert.rejects(completeResponses(responsesStream(callParts({id:'fc_1',call_id:'call_fixture_1',name:'desk_read',arguments:raw}))),
            e=>[bad,unknown,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(e.code));
    let detected=false;const c=responsesRoute();
    c.assertSafe=value=>{if(value===answer){detected=true;throw new Error('blocked');}};
    await assert.rejects(completeResponses(responsesStream(textParts()),c));
    assert.equal(detected,true);
});

test('responses invalid media, status, size and utf-8 are refused before release',async()=>{
    for(const response of [upstream(responsesStream(textParts()),'application/json'),new Response('error',{status:429,headers:{'content-type':sse}}),
        upstream(serializeResponses(textBase())+'x'.repeat(2000001)),upstream(Uint8Array.from([255]))])
        await assert.rejects(rsExchange(responsesRoute()).prepare(ingress(roundTrip())).complete(response));
});

test('responses over budget preserves exact chargeable usage and no frames',async()=>{
    const c=responsesRoute();c.limits.maxInputTokens=7;
    await assert.rejects(completeResponses(responsesStream(textParts()),c),e=>{
        assert.equal(e.code,'NATIVE_USAGE_BOUND_EXCEEDED');
        assert.deepEqual(e.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
        assert.equal(Object.hasOwn(e,'sse'),false);return true;
    });
});

test('no partial release until EOF; abort while waiting; stale owner after EOF',async()=>{
    for(const mode of ['complete','abort','stale','late-invalid']){
        let controller,settled=false,current=true;
        const c=context(),abort=new AbortController();
        c.signal=abort.signal;c.assertCurrent=()=>{if(!current)throw new Error('stale');};
        const pending=exchange(c).prepare(ingress(roundTrip()))
            .complete(upstream(new ReadableStream({start(value){controller=value;}}))).finally(()=>{settled=true;});
        const bytes=Buffer.from(textStream());
        for(let offset=0;offset<bytes.length;offset+=13)controller.enqueue(bytes.subarray(offset,offset+13));
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(settled,false);
        if(mode==='abort')abort.abort();
        else{if(mode==='stale')current=false;if(mode==='late-invalid')controller.enqueue(Buffer.from('data: {\n\n'));controller.close();}
        if(mode==='complete')assert.ok((await pending).sse.includes(answer));else await assert.rejects(pending);
    }
});
