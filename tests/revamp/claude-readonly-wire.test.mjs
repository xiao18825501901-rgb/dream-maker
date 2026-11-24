import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createClaudeReadOnlyExchange} from '../../dist/server/flow/claude-readonly-wire.js';
import {context,model,prompt,instructions,answer,requestBody,ingress,chatDoc,responseEvents,encode,upstream} from '../fixtures/claude-readonly-wire.mjs';
const chat='chat-completions', responses='openai-responses', sse='text/event-stream';
const exchange = ctx=>createClaudeReadOnlyExchange(ctx);
const prepare = (protocol=chat,ctx=context(protocol))=>exchange(ctx).prepare(ingress(requestBody()));
const completion = (protocol,body)=>prepare(protocol).complete(upstream(body,protocol===chat?'application/json':sse));
const failure = (code) => e=>e.code===code && !Object.hasOwn(e,'sse') && !Object.hasOwn(e,'text');
const bad = 'MODEL_GATEWAY_COMPLETION_INVALID', unknown='NATIVE_USAGE_UNKNOWN';

for (const protocol of [chat,responses]) for (const role of ['planner2','reviewer']) test(role+' '+protocol+' frozen request, output and usage',async()=>{
    const ctx=context(protocol,role); const x=exchange(ctx);ctx.limits.prompt='mutated';ctx.route.model='unrelated';
    const b=requestBody(); b.max_tokens=1024;
    const p=x.prepare(ingress(b));const body=JSON.parse(p.body);
    assert.equal(p.maxOutputTokens,512);assert.equal(body.model,'fixture/'+model);assert.equal(p.body.includes('LOCAL_ONLY'),false);
    if(protocol===chat) {
        assert.equal(p.path,'/v1/chat/completions');
        assert.deepEqual(body,{model:'fixture/'+model,stream:false,max_tokens:512,messages:[{role:'system',content:instructions},{role:'user',content:prompt}]});
    } else {
        assert.equal(p.path,'/v1/responses');assert.equal(body.input[0].content[0].text,prompt);assert.equal(body.instructions,instructions);
        assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.max_output_tokens,512);
    }
    const raw=protocol===chat?JSON.stringify(chatDoc()):encode(responseEvents()).replaceAll('\n','\r\n');
    const out=await p.complete(upstream(raw,protocol===chat?'application/json':sse));
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(out.responseSha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(out.outputTextHash,createHash('sha256').update(answer).digest('hex'));
    const events=out.sse.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
    assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
    assert.equal(events[0].message.model,model);assert.deepEqual(events[0].message.usage,{input_tokens:6,output_tokens:0,cache_read_input_tokens:2,cache_creation_input_tokens:0});
    assert.equal(events[2].delta.text,answer);assert.equal(events[4].usage.output_tokens,3);assert.equal(events[4].delta.stop_reason,'end_turn');
    assert.throws(()=>x.prepare(ingress(b)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
    await assert.rejects(p.complete(upstream(raw)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
});
for(const [name,change] of Object.entries({executor:c=>c.role='executor',oauth:c=>c.route.authentication='oauth',runtime:c=>c.route.runtime='cline',messages:c=>c.route.protocol='anthropic-messages',
    'no account':c=>c.accounts=[], 'ambiguous account':c=>c.accounts.push({...c.accounts[0]}),'wrong authRef':c=>c.accounts[0].authRef='other',
    'wrong accountRef':c=>c.accounts[0].accountRef='other','wrong upstreamAccountRef':c=>c.accounts[0].upstreamAccountRef='fixture/other',
    'preserve native Messages route':c=>c.accounts[0].capabilities.push({model,protocol:'anthropic-messages'}),
    'missing capability':c=>delete c.accounts[0].capabilities,'wrong protocol':c=>c.accounts[0].capabilities[0].protocol=responses,
    'wrong capability model':c=>c.accounts[0].capabilities[0].model='else','duplicate capability':c=>c.accounts[0].capabilities.push(c.accounts[0].capabilities[0]),
    'wrong frozen model':c=>c.limits.model='other','invalid input cap':c=>c.limits.maxInputTokens=-1,'huge output cap':c=>c.limits.maxOutputTokens=16001,
    'undeclared schema support':c=>c.limits.outputSchema={type:'object'},
})) test('deny '+name,()=>{const c=context();change(c);assert.throws(()=>exchange(c));});
for(const [name,change] of Object.entries({multi:b=>b.tools=[{name:'a'},{name:'b'}],single:b=>b.tools=[{name:'Read'}],toolChoice:b=>b.tool_choice='auto',stream:b=>b.stream=false,
    'extra user':b=>b.messages.push(b.messages[0]), 'assistant prefix':b=>b.messages[0].role='assistant','extra text':b=>b.messages[0].content.push({type:'text',text:'extra'}),
    'prompt substring':b=>b.messages[0].content[0].text='x'+prompt,'image':b=>b.messages[0].content[0].type='image',
    'system tool block':b=>b.system[0].type='tool_result','cache ttl':b=>b.messages[0].content[0].cache_control.ttl='1h','metadata extra':b=>b.metadata.extra=true,
    'unknown option':b=>b.output_config.format={},'zero max':b=>b.max_tokens=0,'wrong model':b=>b.model='unselected',
}))test('reject request '+name,()=>{const b=requestBody();change(b);assert.throws(()=>exchange(context()).prepare(ingress(b)),failure('CLAUDE_MESSAGES_REQUEST_INVALID'));});
for (const [name,attr] of Object.entries({version:{version:'latest'},path:{path:'/v1/messages?x=1'},method:{method:'GET'},media:{contentType:'text/plain'},
    'raw bytes':{body:' '.repeat(262145)},'duplicate keys':{body:'{"model":"a","\\u006dodel":"b"}'}}))test('reject ingress '+name,()=>{
    assert.throws(()=>exchange(context()).prepare({...ingress(requestBody()),...attr}));
});
for(const [name,change,code] of [
    ['extra choice',d=>d.choices.push(d.choices[0]),bad],['wrong model',d=>d.model='other',bad],['tool',d=>d.choices[0].message.tool_calls=[{}],bad],
    ['two tools',d=>d.choices[0].message.tool_calls=[{},{}],bad],['legacy function',d=>d.choices[0].message.function_call={},bad],['refusal',d=>d.choices[0].message.refusal='x',bad],
    ['truncated',d=>d.choices[0].finish_reason='length',bad],['missing usage',d=>delete d.usage,unknown],['missing cache',d=>delete d.usage.prompt_tokens_details,unknown],
    ['invalid hit',d=>d.usage.prompt_tokens_details.cached_tokens=9,unknown],['conflicting hit',d=>d.usage.prompt_cache_hit_tokens=1,unknown],['conflicting miss',d=>d.usage.prompt_cache_miss_tokens=1,unknown],
    ['unsupported cache write charge',d=>d.usage.cache_creation_input_tokens=1,unknown],['bad total',d=>d.usage.total_tokens=9,unknown],['negative',d=>d.usage.completion_tokens=-1,unknown],['fractional',d=>d.usage.prompt_tokens=0.5,unknown],
])test('chat '+name,async()=>{const doc=chatDoc();change(doc);await assert.rejects(completion(chat,JSON.stringify(doc)),failure(code));});
test('explicit DeepSeek hit/miss aliases and zero cache',async()=>{const doc=chatDoc();delete doc.usage.prompt_tokens_details;doc.usage.prompt_cache_hit_tokens=0;doc.usage.prompt_cache_miss_tokens=8;
    assert.equal((await completion(chat,JSON.stringify(doc))).usage.cacheHitTokens,0);
});
for (const [name,change] of Object.entries({
    'unreconciled reasoning':e=>e.splice(1,0,{type:'response.output_item.added',output_index:0,item:{id:'rs_1',type:'reasoning',summary:[]}}),
    'contradictory created error':e=>e[0].response.error={code:'failed'},'contradictory completion':e=>e.at(-1).response.incomplete_details={reason:'max_output_tokens'},
    'truncated terminal':e=>e.pop(),'missing item done':e=>e.splice(-2,1),'duplicate item done':e=>e.splice(-1,0,e.at(-2)),'missing text done':e=>e.splice(4,1),
    'late event':e=>e.push(e[0]),'extra completion':e=>e.push(e.at(-1)),'tool item':e=>e[1].item.type='function_call',
    'wrong model':e=>e.at(-1).response.model='another','model drift':e=>e.at(-1).response.model=model,'wrong response id':e=>e.at(-1).response.id='other',
    'wrong item id':e=>e[3].item_id='other','wrong output index':e=>e[3].output_index=2,'wrong content index':e=>e[3].content_index=1,
    'bad terminal text':e=>e.at(-1).response.output[0].content[0].text='other','extra message':e=>e.at(-1).response.output.push(e.at(-1).response.output[0]),
    'missing cache':e=>delete e.at(-1).response.usage.input_tokens_details,'unknown usage':e=>delete e.at(-1).response.usage,
    'unsupported cache write':e=>e.at(-1).response.usage.input_tokens_details.cache_write_tokens=1,'sum mismatch':e=>e.at(-1).response.usage.total_tokens=12,'forged metadata binding':e=>e.splice(1,0,{type:'response.metadata',response_id:'other'}),
    'sequence gap':e=>{e.forEach((v,i)=>v.sequence_number=i);e[3].sequence_number=8;},
}))test('Responses '+name,async()=>{const e=responseEvents();change(e);await assert.rejects(completion(responses,encode(e)));});
for(const [name,mutate] of Object.entries({'bad JSON suffix':s=>s+'data: {\n\n','event name drift':s=>s.replace('event: response.created','event: error'),
    'last frame unterminated':s=>s.slice(0,-1),'duplicate JSON key':s=>s.replace('"type":"response.created"','"type":"response.completed","type":"response.created"'),
    'trailing done marker':s=>s+'data: [DONE]\n\n','duplicate event names':s=>s.replace('event: response.created','event: error\nevent: response.created')})) {
    test('SSE '+name,async()=>assert.rejects(completion(responses,mutate(encode(responseEvents())))));
}
for(const protocol of [chat,responses]) test('over budget preserves exact chargeable usage and no text '+protocol,async()=>{
    const c=context(protocol);c.limits.maxInputTokens=7;const p=prepare(protocol,c);
    await assert.rejects(p.complete(protocol===chat?upstream(JSON.stringify(chatDoc())):upstream(encode(responseEvents()),sse)),e=>{
        assert.equal(e.code,'NATIVE_USAGE_BOUND_EXCEEDED');assert.deepEqual(e.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});assert.equal(Object.hasOwn(e,'sse'),false);return true;
    });
});
test('output limit clamps to native request',async()=>{const b=requestBody();b.max_tokens=2;const p=exchange(context()).prepare(ingress(b));
    assert.equal(p.maxOutputTokens,2);await assert.rejects(p.complete(upstream(JSON.stringify(chatDoc()))),failure('NATIVE_USAGE_BOUND_EXCEEDED'));
});
test('split deltas and decoded secret are checked before release',async()=>{
    const events=responseEvents();const first=events[3];events.splice(3,1,{...first,delta:answer.slice(0,5)},{...first,delta:answer.slice(5)});
    const c=context(responses);let detected=false;c.assertSafe=s=>{if(s===answer){detected=true;throw new Error('blocked');}};
    await assert.rejects(prepare(responses,c).complete(upstream(encode(events),sse)));assert.equal(detected,true);
});
test('invalid UTF-8, media, size and HTTP status',async()=>{
    for(const r of [upstream(Uint8Array.from([255])),upstream('x',sse),upstream(' '.repeat(2000001)),new Response('error',{status:429})]) await assert.rejects(prepare().complete(r));
});
test('no partial release until EOF; abort while waiting; stale owner after EOF',async()=>{
    for(const mode of ['complete','abort','stale','late-invalid']) {
        let controller,settled=false,current=true;const c=context(responses);const abort=new AbortController();c.signal=abort.signal;c.assertCurrent=()=>{if(!current) throw new Error('stale');};
        const bytes=Buffer.from(encode(responseEvents()));const read=new ReadableStream({start(v){controller=v;}});
        const p=prepare(responses,c).complete(upstream(read,sse)).finally(()=>{settled=true;});
        for(let off=0;off<bytes.length;off+=13) controller.enqueue(bytes.subarray(off,off+13));
        await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
        if(mode==='abort')abort.abort();else {if(mode==='stale')current=false;if(mode==='late-invalid')controller.enqueue(Buffer.from('data: {\n\n'));controller.close();}
        if(mode==='complete')assert.ok((await p).sse.includes(answer));else await assert.rejects(p);
    }
});
