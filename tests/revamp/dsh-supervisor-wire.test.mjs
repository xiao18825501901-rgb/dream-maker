import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDshSupervisorExchange} from '../../dist/server/flow/dsh-supervisor-wire.js';
import {context,model,prompt,system,answer,tool,toolInput,inputSchema,toolArguments,requestBody,ingress,chatDoc,chatToolDoc,responseTextEvents,responseToolEvents,encode,upstream} from '../fixtures/dsh-supervisor-wire.mjs';
const chat='chat-completions', responses='openai-responses', sse='text/event-stream';
const exchange = ctx=>createDshSupervisorExchange(ctx);
const prepare = (protocol=chat,ctx=context(protocol))=>exchange(ctx).prepare(ingress(requestBody()));
const completion = (protocol,body)=>prepare(protocol).complete(upstream(body,protocol===chat?'application/json':sse));
const failure = (code) => e=>e.code===code && !Object.hasOwn(e,'sse') && !Object.hasOwn(e,'text');
const bad = 'MODEL_GATEWAY_COMPLETION_INVALID', unknown='NATIVE_USAGE_UNKNOWN';

for (const protocol of [chat,responses]) for (const role of ['planner2','reviewer']) test(role+' '+protocol+' freezes the supervision turn and translates the text answer',async()=>{
    const ctx=context(protocol,role); const x=exchange(ctx);ctx.limits.model='mutated';ctx.route.model='unrelated';
    const b=requestBody(); b.max_tokens=1024;
    const p=x.prepare(ingress(b));const body=JSON.parse(p.body);
    assert.equal(p.maxOutputTokens,512);assert.equal(body.model,'fixture/'+model);
    if(protocol===chat){
        assert.equal(p.path,'/v1/chat/completions');
        assert.deepEqual(body,{model:'fixture/'+model,stream:false,max_tokens:512,messages:[{role:'system',content:system},{role:'user',content:prompt}],
            tools:[{type:'function',function:{name:tool,description:'Submit the frozen review.',parameters:inputSchema}}],
            tool_choice:{type:'function',function:{name:tool}}});
    }else{
        assert.equal(p.path,'/v1/responses');
        assert.deepEqual(body.input,[{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}]);
        assert.equal(body.instructions,system);assert.equal(body.store,false);assert.equal(body.stream,true);
        assert.equal(body.max_output_tokens,512);
        assert.deepEqual(body.tools,[{type:'function',name:tool,description:'Submit the frozen review.',parameters:inputSchema}]);
        assert.deepEqual(body.tool_choice,{type:'function',name:tool});
    }
    const raw=protocol===chat?JSON.stringify(chatDoc()):encode(responseTextEvents());
    const out=await p.complete(upstream(raw,protocol===chat?'application/json':sse));
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(out.responseSha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(out.outputTextHash,createHash('sha256').update(answer).digest('hex'));
    assert.equal(out.finishReason,'end_turn');assert.equal(out.observedUpstreamModel,'fixture/'+model);
    const events=out.sse.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
    assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
    assert.equal(events[0].message.model,model);assert.deepEqual(events[0].message.usage,{input_tokens:6,output_tokens:0,cache_read_input_tokens:2,cache_creation_input_tokens:0});
    assert.deepEqual(events[1].content_block,{type:'text',text:''});
    assert.equal(events[2].delta.text,answer);assert.equal(events[4].usage.output_tokens,3);assert.equal(events[4].delta.stop_reason,'end_turn');
    assert.throws(()=>x.prepare(ingress(b)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
    await assert.rejects(p.complete(upstream(raw)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
});

for (const protocol of [chat,responses]) test(protocol+' returns the single terminal tool call as tool_use frames',async()=>{
    const p=prepare(protocol);
    const raw=protocol===chat?JSON.stringify(chatToolDoc()):encode(responseToolEvents());
    const out=await p.complete(upstream(raw,protocol===chat?'application/json':sse));
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(out.finishReason,'tool_use');assert.equal(out.outputTextHash,createHash('sha256').update('').digest('hex'));
    const events=out.sse.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
    assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
    assert.deepEqual(events[1].content_block,{type:'tool_use',id:'call_fixture_1',name:tool,input:{}});
    assert.deepEqual(events[2].delta,{type:'input_json_delta',partial_json:toolArguments});
    assert.equal(events[4].delta.stop_reason,'tool_use');assert.equal(events[4].usage.output_tokens,3);
    assert.equal(out.sse.includes(answer),false);
});

for(const [name,change] of Object.entries({executor:c=>c.role='executor',planner1:c=>c.role='planner1',oauth:c=>c.route.authentication='oauth',
    runtime:c=>c.route.runtime='claude',messages:c=>c.route.protocol='anthropic-messages',
    'no account':c=>c.accounts=[], 'ambiguous account':c=>c.accounts.push({...c.accounts[0]}),'wrong authRef':c=>c.accounts[0].authRef='other',
    'wrong accountRef':c=>c.accounts[0].accountRef='other','wrong upstreamAccountRef':c=>c.accounts[0].upstreamAccountRef='fixture/other',
    'preserve native Messages route':c=>c.accounts[0].capabilities.push({model,protocol:'anthropic-messages'}),
    'missing capability':c=>delete c.accounts[0].capabilities,'wrong protocol':c=>c.accounts[0].capabilities[0].protocol='openai-responses',
    'wrong capability model':c=>c.accounts[0].capabilities[0].model='else','duplicate capability':c=>c.accounts[0].capabilities.push(c.accounts[0].capabilities[0]),
    'wrong frozen model':c=>c.limits.model='other','invalid input cap':c=>c.limits.maxInputTokens=-1,'huge output cap':c=>c.limits.maxOutputTokens=16001,
    'undeclared schema support':c=>c.limits.outputSchema={type:'object'},
})) test('deny '+name,()=>{const protocol=chat;const c=context(protocol);change(c);assert.throws(()=>exchange(c));});

for(const [name,change] of Object.entries({
    'no tools':b=>b.tools=[], 'two tools':b=>b.tools=[{name:'a',input_schema:{}},{name:'b',input_schema:{}}],
    'unknown key':b=>b.tool_choice={type:'tool',name:tool}, 'stream false':b=>b.stream=false,
    'thinking enabled':b=>b.thinking={type:'enabled'}, 'missing thinking':b=>delete b.thinking,
    'system empty':b=>b.system=' ', 'two system blocks':b=>b.system=[{type:'text',text:'a'},{type:'text',text:'b'}],
    'extra user':b=>b.messages.push({role:'user',content:[{type:'text',text:'x'}]}),
    'assistant prefix':b=>b.messages[0].role='assistant','extra text':b=>b.messages[0].content.push({type:'text',text:'extra'}),
    'empty prompt':b=>b.messages[0].content[0].text=' ','image':b=>b.messages[0].content[0].type='image',
    'cache control':b=>b.messages[0].content[0].cache_control={type:'ephemeral'},
    'schema not object':b=>b.tools[0].input_schema=[], 'schema missing':b=>delete b.tools[0].input_schema,
    'deferred tool':b=>b.tools[0].defer_loading=true,'unknown tool field':b=>b.tools[0].type='custom',
    'zero max':b=>b.max_tokens=0,'wrong model':b=>b.model='unselected','metadata':b=>b.metadata={user_id:'x'},
    'output config':b=>b.output_config={effort:'high'},
}))test('reject request '+name,()=>{const b=requestBody();change(b);assert.throws(()=>exchange(context()).prepare(ingress(b)),failure('CLAUDE_MESSAGES_REQUEST_INVALID'));});

for (const [name,attr] of Object.entries({version:{version:'latest'},path:{path:'/v1/messages?x=1'},method:{method:'GET'},media:{contentType:'text/plain'},
    'raw bytes':{body:' '.repeat(262145)},'duplicate keys':{body:'{"model":"a","\\u006dodel":"b"}'}}))test('reject ingress '+name,()=>{
    assert.throws(()=>exchange(context()).prepare({...ingress(requestBody()),...attr}));
});

for(const [name,change,code] of [
    ['extra choice',d=>d.choices.push(d.choices[0]),bad],['wrong model',d=>d.model='other',bad],
    ['two tool calls',d=>d.choices[0].message.tool_calls.push({...d.choices[0].message.tool_calls[0],index:1,id:'call_fixture_2'}),bad],
    ['parallel calls without index',d=>d.choices[0].message.tool_calls.push({id:'call_fixture_2',type:'function',function:{name:tool,arguments:toolArguments}}),bad],
    ['unknown tool name',d=>d.choices[0].message.tool_calls[0].function.name='submit_plan',bad],
    ['text beside tool',d=>d.choices[0].message.content=answer,bad],
    ['text finish with tool',d=>d.choices[0].finish_reason='stop',bad],
    ['tool finish with text',d=>{d.choices[0].message.tool_calls=undefined;d.choices[0].finish_reason='tool_calls';},bad],
    ['legacy function',d=>d.choices[0].message.function_call={},bad],['refusal',d=>d.choices[0].message.refusal='x',bad],
    ['truncated',d=>d.choices[0].finish_reason='length',bad],['missing usage',d=>delete d.usage,unknown],
    ['missing cache',d=>delete d.usage.prompt_tokens_details,unknown],['invalid hit',d=>d.usage.prompt_tokens_details.cached_tokens=9,unknown],
    ['conflicting hit',d=>d.usage.prompt_cache_hit_tokens=1,unknown],['conflicting miss',d=>d.usage.prompt_cache_miss_tokens=1,unknown],
    ['unsupported cache write charge',d=>d.usage.cache_creation_input_tokens=1,unknown],['bad total',d=>d.usage.total_tokens=9,unknown],
    ['negative',d=>d.usage.completion_tokens=-1,unknown],['fractional',d=>d.usage.prompt_tokens=0.5,unknown],
])test('chat '+name,async()=>{const doc=chatToolDoc();change(doc);await assert.rejects(completion(chat,JSON.stringify(doc)),failure(code));});
test('chat arguments must be one JSON object',async()=>{
    for(const argumentsText of ['{not json','["a"]','"text"','1','{}}']){const doc=chatToolDoc();doc.choices[0].message.tool_calls[0].function.arguments=argumentsText;
        await assert.rejects(completion(chat,JSON.stringify(doc)),e=>['MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID',bad].includes(e.code));}
});

for (const [name,change] of Object.entries({
    'unreconciled reasoning':e=>e.splice(1,0,{type:'response.output_item.added',output_index:0,item:{id:'rs_1',type:'reasoning',summary:[]}}),
    'contradictory created error':e=>e[0].response.error={code:'failed'},'contradictory completion':e=>e.at(-1).response.incomplete_details={reason:'max_output_tokens'},
    'truncated terminal':e=>e.pop(),'missing item done':e=>e.splice(-2,1),'duplicate item done':e=>e.splice(-1,0,e.at(-2)),
    'missing text done':e=>e.splice(4,1),'late event':e=>e.push(e[0]),'extra completion':e=>e.push(e.at(-1)),
    'wrong model':e=>e.at(-1).response.model='another','model drift':e=>e.at(-1).response.model=model,
    'wrong response id':e=>e.at(-1).response.id='other','wrong item id':e=>e[3].item_id='other',
    'wrong output index':e=>e[3].output_index=2,'wrong content index':e=>e[3].content_index=1,
    'bad terminal text':e=>e.at(-1).response.output[0].content[0].text='other',
    'extra message':e=>e.at(-1).response.output.push(e.at(-1).response.output[0]),
    'missing cache':e=>delete e.at(-1).response.usage.input_tokens_details,'unknown usage':e=>delete e.at(-1).response.usage,
    'unsupported cache write':e=>e.at(-1).response.usage.input_tokens_details.cache_write_tokens=1,
    'sum mismatch':e=>e.at(-1).response.usage.total_tokens=12,'forged metadata binding':e=>e.splice(1,0,{type:'response.metadata',response_id:'other'}),
    'sequence gap':e=>{e.forEach((v,i)=>v.sequence_number=i);e[3].sequence_number=8;},
}))test('Responses '+name,async()=>{const e=responseTextEvents();change(e);await assert.rejects(completion(responses,encode(e)));});

for (const [name,change] of Object.entries({
    'two function calls':e=>{const completed=e.at(-1);const call=completed.response.output[0];
        const second=JSON.parse(JSON.stringify(call));second.id='fc_second';second.call_id='call_fixture_2';
        completed.response.output.push(second);
        e.splice(-1,0,{type:'response.output_item.added',output_index:1,item:{...second,status:'in_progress',arguments:''}},
            {type:'response.function_call_arguments.delta',output_index:1,item_id:'fc_second',delta:toolArguments},
            {type:'response.function_call_arguments.done',output_index:1,item_id:'fc_second',arguments:toolArguments},
            {type:'response.output_item.done',output_index:1,item:second});},
    'unknown tool name':e=>{e[1].item.name='submit_plan';e.at(-1).response.output[0].name='submit_plan';},
    'tool arguments changed':e=>{e[2].delta='{"verdict":"fail"}';},
    'missing call id':e=>{e.at(-1).response.output[0].call_id='';},
}))test('Responses tool '+name,async()=>{const e=responseToolEvents();change(e);await assert.rejects(completion(responses,encode(e)));});

for(const [name,mutate] of Object.entries({'bad JSON suffix':s=>s+'data: {\n\n','event name drift':s=>s.replace('event: response.created','event: error'),
    'last frame unterminated':s=>s.slice(0,-1),'duplicate JSON key':s=>s.replace('"type":"response.created"','"type":"response.completed","type":"response.created"'),
    'trailing done marker':s=>s+'data: {}\n\n','duplicate event names':s=>s.replace('event: response.created','event: error\nevent: response.created')})) {
    test('SSE '+name,async()=>assert.rejects(completion(responses,mutate(encode(responseTextEvents())))));
}

for(const protocol of [chat,responses]) test('over budget preserves exact chargeable usage and no text '+protocol,async()=>{
    const c=context(protocol);c.limits.maxInputTokens=7;const p=prepare(protocol,c);
    await assert.rejects(p.complete(protocol===chat?upstream(JSON.stringify(chatDoc())):upstream(encode(responseTextEvents()),sse)),e=>{
        assert.equal(e.code,'NATIVE_USAGE_BOUND_EXCEEDED');assert.deepEqual(e.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});assert.equal(Object.hasOwn(e,'sse'),false);return true;
    });
});
test('output limit clamps to the frozen request',async()=>{const b=requestBody();b.max_tokens=2;const p=exchange(context()).prepare(ingress(b));
    assert.equal(p.maxOutputTokens,2);await assert.rejects(p.complete(upstream(JSON.stringify(chatDoc()))),failure('NATIVE_USAGE_BOUND_EXCEEDED'));
});
test('split deltas and a decoded secret are checked before release',async()=>{
    const events=responseTextEvents();const first=events[3];events.splice(3,1,{...first,delta:answer.slice(0,5)},{...first,delta:answer.slice(5)});
    const c=context(responses);let detected=false;c.assertSafe=s=>{if(s===answer){detected=true;throw new Error('blocked');}};
    await assert.rejects(prepare(responses,c).complete(upstream(encode(events),sse)));assert.equal(detected,true);
});
test('invalid UTF-8, media, size and HTTP status',async()=>{
    for(const r of [upstream(Uint8Array.from([255])),upstream('x',sse),upstream(' '.repeat(2000001)),new Response('error',{status:429})]) await assert.rejects(prepare().complete(r));
});
test('no partial release until EOF; abort while waiting; stale owner after EOF',async()=>{
    for (const mode of ['complete','abort','stale','late-invalid']) {
        let controller,settled=false,current=true;const c=context(responses);const abort=new AbortController();c.signal=abort.signal;c.assertCurrent=()=>{if(!current) throw new Error('stale');};
        const bytes=Buffer.from(encode(responseTextEvents()));const read=new ReadableStream({start(v){controller=v;}});
        const p=prepare(responses,c).complete(upstream(read,sse)).finally(()=>{settled=true;});
        for(let off=0;off<bytes.length;off+=13) controller.enqueue(bytes.subarray(off,off+13));
        await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
        if(mode==='abort')abort.abort();else {if(mode==='stale')current=false;if(mode==='late-invalid')controller.enqueue(Buffer.from('data: {\n\n'));controller.close();}
        if(mode==='complete')assert.ok((await p).sse.includes(answer));else await assert.rejects(p);
    }
});
