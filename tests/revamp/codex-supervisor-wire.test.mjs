import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCodexSupervisorExchange} from '../../dist/server/flow/codex-supervisor-wire.js';
import {context,model,prompt,instructions,answer,messageId,requestBody,ingress,messageEvents,encode,upstream} from '../fixtures/codex-supervisor-wire.mjs';
const sse='text/event-stream';
const exchange = ctx=>createCodexSupervisorExchange(ctx);
const prepare = (ctx=context())=>exchange(ctx).prepare(ingress(requestBody()));
const completion = (body,ctx=context())=>prepare(ctx).complete(upstream(body));
const failure = code => e=>e.code===code && !Object.hasOwn(e,'sse') && !Object.hasOwn(e,'text');
const invalid='MODEL_GATEWAY_COMPLETION_INVALID', unknown='NATIVE_USAGE_UNKNOWN', badRequest='CODEX_RESPONSES_REQUEST_INVALID';

// The positive case the whole lane exists for: one frozen text turn, one Messages answer.
for (const role of ['planner2','reviewer']) test(role+' freezes the Codex turn and rebuilds it as Responses frames',async()=>{
    const ctx=context(role);const x=exchange(ctx);
    // Later mutation must not reach the frozen copy.
    ctx.limits.instructions='mutated';ctx.route.model='unrelated';ctx.prompt=()=>prompt;
    const b=requestBody();b.max_output_tokens=1024;
    const p=x.prepare(ingress(b));const body=JSON.parse(p.body);
    assert.equal(p.path,'/v1/messages');
    assert.deepEqual(body,{model:'fixture/'+model,stream:true,max_tokens:512,system:[{type:'text',text:instructions}],
        messages:[{role:'user',content:[{type:'text',text:prompt}]}]});
    assert.equal(p.maxOutputTokens,512);
    // The CLI's own system text, tool groups and structured-output request never cross the wire.
    assert.equal(p.body.includes('LOCAL_ONLY'),false);
    const raw=encode(messageEvents());
    const out=await p.complete(upstream(raw));
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(out.responseSha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(out.outputTextHash,createHash('sha256').update(answer).digest('hex'));
    assert.equal(out.observedUpstreamModel,'fixture/'+model);
    assert.equal(out.finishReason,'end_turn');assert.equal(out.model,model);
    assert.equal(out.sse.endsWith('\n\n'),true);
    const frames=out.sse.trimEnd().split('\n\n').map(block=>{
        const lines=block.split('\n');
        assert.equal(lines.length,2);assert.ok(lines[0].startsWith('event: '));assert.ok(lines[1].startsWith('data: '));
        const event=JSON.parse(lines[1].slice(6));assert.equal(lines[0].slice(7),event.type);return event;
    });
    assert.deepEqual(frames.map(e=>e.type),['response.created','response.output_item.added','response.content_part.added',
        'response.output_text.delta','response.output_text.done','response.content_part.done','response.output_item.done','response.completed']);
    assert.equal(frames[0].response.status,'in_progress');assert.deepEqual(frames[0].response.output,[]);
    assert.equal(frames[0].response.model,model);assert.match(frames[0].response.id,/^resp_[a-f0-9]{24}$/);
    assert.equal(frames[1].output_index,0);assert.deepEqual(frames[1].item.content,[]);assert.equal(frames[1].item.status,'in_progress');
    assert.deepEqual(frames[2].part,{type:'output_text',text:'',annotations:[]});assert.equal(frames[2].content_index,0);
    assert.equal(frames[3].delta,answer);assert.equal(frames[4].text,answer);
    assert.equal(frames[5].part.text,answer);
    assert.equal(frames[6].item.status,'completed');assert.equal(frames[6].item.content[0].text,answer);
    assert.equal(frames[7].response.status,'completed');assert.equal(frames[7].response.model,model);
    assert.deepEqual(frames[7].response.output,[frames[6].item]);
    assert.deepEqual(frames[7].response.usage,{input_tokens:8,output_tokens:3,total_tokens:11,input_tokens_details:{cached_tokens:2}});
    const id=frames[1].item.id;
    for(const frame of frames.filter(f=>f.item_id!==undefined))assert.equal(frame.item_id,id);
    assert.throws(()=>x.prepare(ingress(b)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
    await assert.rejects(p.complete(upstream(raw)),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
});

test('an omitted max_output_tokens clamps to the frozen ceiling and a low one is honoured',async()=>{
    const b=requestBody();delete b.max_output_tokens;
    assert.equal(prepare(context()).path,'/v1/messages');
    assert.equal(JSON.parse(exchange(context()).prepare(ingress(b)).body).max_tokens,512);
    const low=requestBody();low.max_output_tokens=2;const p=exchange(context()).prepare(ingress(low));
    assert.equal(p.maxOutputTokens,2);assert.equal(JSON.parse(p.body).max_tokens,2);
    await assert.rejects(p.complete(upstream(encode(messageEvents()))),e=>{
        assert.equal(e.code,'NATIVE_USAGE_BOUND_EXCEEDED');
        assert.deepEqual(e.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
        assert.equal(Object.hasOwn(e,'sse'),false);return true;
    });
});

for(const [name,change] of Object.entries({
    'no user turn':b=>{b.input=b.input.slice(0,2);},
    'two user turns':b=>{b.input.push({type:'message',role:'user',content:[{type:'input_text',text:prompt}]});},
    'prompt substring':b=>{b.input.at(-1).content[0].text='x'+prompt;},
    'prompt emptied':b=>{b.input.at(-1).content[0].text=' ';},
    'second text part':b=>{b.input.at(-1).content.push({type:'input_text',text:'extra'});},
    'two system texts':b=>{b.input.splice(1,0,{type:'message',role:'system',content:[{type:'input_text',text:'another'}]});},
    'unknown role':b=>{b.input.at(-1).role='assistant';},
    'unknown item type':b=>{b.input.push({type:'function_call',name:'desk_read'});},
    'tool declaration':b=>{b.tools=[{type:'function',name:'desk_read'}];},
    'forced tool':b=>{b.tool_choice={type:'function',name:'desk_read'};},
    'additional tools without tools':b=>{b.input[0].tools='none';},
    'non-input part':b=>{b.input.at(-1).content[0].type='output_text';},
    'store true':b=>{b.store=true;},
    'stream false':b=>{b.stream=false;},
    'missing stream':b=>{delete b.stream;},
    'missing store':b=>{delete b.store;},
    'missing input':b=>{delete b.input;},
    'empty input':b=>{b.input=[];},
    'wrong model':b=>{b.model='unselected';},
    'zero max output':b=>{b.max_output_tokens=0;},
    'fractional max output':b=>{b.max_output_tokens=1.5;},
    'negative max output':b=>{b.max_output_tokens=-1;},
    'string max output':b=>{b.max_output_tokens='1024';},
    'loose text options':b=>{b.text.extra=true;},
    'unstructured free text':b=>{b.text={verbosity:'high'};b.text.verbosity='loud';},
    'yaml format':b=>{b.text.format.type='yaml';},
    'non-strict schema':b=>{b.text.format.strict=false;},
    'schema not an object':b=>{b.text.format.schema=[];},
    'unknown top-level key':b=>{b.previous_response_id='other';},
    'instructions not text':b=>{b.instructions={};},
    'reasoning shape':b=>{b.reasoning='high';},
    'reasoning unknown switch':b=>{b.reasoning.extra=true;},
    'reasoning non text effort':b=>{b.reasoning.effort=1;},
})) test('reject request '+name,()=>{
    const b=requestBody();change(b);
    assert.throws(()=>exchange(context()).prepare(ingress(b)),failure(badRequest));
});
for(const [name,attr] of Object.entries({'wrong path':{path:'/v1/responses?x=1'},'chat path':{path:'/v1/chat/completions'},
    'get':{method:'GET'},'media':{contentType:'text/plain'},'raw bytes':{body:' '.repeat(262145)},
    'duplicate keys':{body:'{"model":"a","\\u006dodel":"b"}'}}))test('reject ingress '+name,()=>{
    const input={...ingress(requestBody()),...attr};
    // Duplicate keys are refused by the shared strict JSON reader, not by this lane.
    if(name==='duplicate keys'){assert.throws(()=>exchange(context()).prepare(input));return;}
    assert.throws(()=>exchange(context()).prepare(input),failure(badRequest));
});
test('a frozen prompt that is still unbound fails the preparation',()=>{
    const ctx=context();
    assert.throws(()=>exchange({...ctx,prompt:()=>{throw new Error('unbound');}}).prepare(ingress(requestBody())));
    assert.throws(()=>exchange({...ctx,prompt:()=>''}).prepare(ingress(requestBody())),failure(badRequest));
});

for(const [name,change] of Object.entries({
    executor:c=>c.role='executor',planner1:c=>c.role='planner1',oauth:c=>c.route.authentication='oauth',
    'other runtime':c=>c.route.runtime='claude','other protocol':c=>c.route.protocol='openai-responses',
    'no prompt reader':c=>delete c.prompt,
    'no account':c=>c.accounts=[],'ambiguous account':c=>c.accounts.push({...c.accounts[0]}),'wrong authRef':c=>c.accounts[0].authRef='other',
    'wrong accountRef':c=>c.accounts[0].accountRef='other','wrong upstreamAccountRef':c=>c.accounts[0].upstreamAccountRef='fixture/other',
    'missing capability':c=>delete c.accounts[0].capabilities,'wrong protocol':c=>c.accounts[0].capabilities[0].protocol='chat-completions',
    'wrong capability model':c=>c.accounts[0].capabilities[0].model='else','duplicate capability':c=>c.accounts[0].capabilities.push(c.accounts[0].capabilities[0]),
    'competing Responses capability':c=>c.accounts[0].capabilities.push({model,protocol:'openai-responses'}),
    'wrong frozen model':c=>c.limits.model='other','empty instructions':c=>c.limits.instructions=' ','invalid input cap':c=>c.limits.maxInputTokens=-1,
    'huge output cap':c=>c.limits.maxOutputTokens=16001,'unknown limit field':c=>c.limits.outputSchema={type:'object'},
})) test('deny '+name,()=>{const c=context();change(c);assert.throws(()=>exchange(c));});

for(const [name,change,code] of [
    ['missing terminal frame',e=>e.pop(),invalid],
    ['trailing frame',e=>e.push({type:'ping'}),invalid],
    ['trailing done marker',e=>e.push('[DONE]'),invalid],
    ['late message_stop',e=>e.push({type:'message_stop'}),invalid],
    ['duplicate message_stop',e=>e.splice(6,0,e[6]),invalid],
    ['missing message_start',e=>e.shift(),invalid],
    ['model mismatch',e=>e[0].message.model='another',invalid],
    ['missing model',e=>delete e[0].message.model,invalid],
    ['wrong message type',e=>e[0].message.type='text',invalid],
    ['wrong role',e=>e[0].message.role='user',invalid],
    ['prefilled content',e=>e[0].message.content.push({type:'text',text:'x'}),invalid],
    ['start stop reason',e=>e[0].message.stop_reason='end_turn',invalid],
    ['tool block',e=>e[1].content_block={type:'tool_use',id:'toolu_1',name:'desk_read',input:{}},invalid],
    ['non empty block start',e=>e[1].content_block.text='x',invalid],
    ['wrong block index',e=>e[2].index=1,invalid],
    ['json delta',e=>e[2].delta={type:'input_json_delta',partial_json:'{}'},invalid],
    ['missing stop reason',e=>delete e[5].delta.stop_reason,invalid],
    ['truncated stop reason',e=>e[5].delta.stop_reason='max_tokens',invalid],
    ['empty text',e=>{e[2].delta.text='';e[3].delta.text=' ';},invalid],
    ['empty stream',e=>{e.length=0;},invalid],
    ['event name drift',e=>e[0].type='message_delta',invalid],
    ['duplicate message_start',e=>e.splice(1,0,e[0]),invalid],
    ['missing usage',e=>delete e[0].message.usage,unknown],
    ['non integer input',e=>e[0].message.usage.input_tokens=1.5,unknown],
    ['negative output',e=>e[5].usage.output_tokens=-1,unknown],
    ['cache write charged',e=>e[0].message.usage.cache_creation_input_tokens=1,unknown],
    ['cache read above input',e=>e[0].message.usage.cache_read_input_tokens=9,unknown],
    ['input drift',e=>e[5].usage.input_tokens=7,unknown],
    ['cache read drift',e=>e[5].usage.cache_read_input_tokens=1,unknown],
    ['cache write drift',e=>e[5].usage.cache_creation_input_tokens=1,unknown],
    ['output regressed',e=>{e[0].message.usage.output_tokens=5;},unknown],
    ['output beyond the frozen cap',e=>e[5].usage.output_tokens=513,'NATIVE_USAGE_BOUND_EXCEEDED'],
    ['unknown delta usage field',e=>e[5].usage.total_tokens=11,unknown],
    ['unknown message field',e=>e[0].message.extra=true,invalid],
]) test('Messages '+name,async()=>{const e=messageEvents();change(e);await assert.rejects(completion(encode(e)),failure(code));});

for(const [name,mutate] of Object.entries({
    'bare CR':s=>s.replace('\n','\r'),
    'unterminated last frame':s=>s.slice(0,-1),
    'trailing blank line':s=>s+'\n',
    'trailing bytes':s=>s+'x',
    'garbage frame':s=>s+'data: {\n\n',
    'duplicate JSON key':s=>s.replace('"type":"message_start"','"type":"message_stop","type":"message_start"'),
    'event without data':s=>s.replace('data: {"type":"message_stop"}',''),
}))test('SSE '+name,async()=>assert.rejects(completion(mutate(encode(messageEvents())))));
test('CRLF framing is accepted and rebuilt as LF frames',async()=>{
    const out=await completion(encode(messageEvents()).replaceAll('\n','\r\n'));
    assert.equal(out.sse.includes('\r'),false);
    assert.deepEqual(out.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
});
test('invalid UTF-8, media, size and HTTP status',async()=>{
    for(const r of [upstream(Uint8Array.from([255])),upstream('x','application/json'),upstream(' '.repeat(2000001)),
        new Response('error',{status:429}),new Response('',{status:200})])await assert.rejects(prepare().complete(r));
});
test('split chunks and a decoded secret are checked before release',async()=>{
    const events=messageEvents();const first=events[2];
    events.splice(2,2,{...first,delta:{type:'text_delta',text:answer.slice(0,3)}},{...first,delta:{type:'text_delta',text:answer.slice(3)}});
    const ctx=context();let detected=false;ctx.assertSafe=value=>{if(value===answer){detected=true;throw new Error('blocked');}};
    await assert.rejects(prepare(ctx).complete(upstream(encode(events))));assert.equal(detected,true);
});
test('no partial release until EOF; abort while waiting; stale owner after EOF',async()=>{
    for(const mode of ['complete','abort','stale','late-invalid']){
        let controller,settled=false,current=true;const ctx=context();const abort=new AbortController();ctx.signal=abort.signal;ctx.assertCurrent=()=>{if(!current)throw new Error('stale');};
        const bytes=Buffer.from(encode(messageEvents()));const read=new ReadableStream({start(v){controller=v;}});
        const p=prepare(ctx).complete(upstream(read)).finally(()=>{settled=true;});
        for(let off=0;off<bytes.length;off+=13)controller.enqueue(bytes.subarray(off,off+13));
        await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
        if(mode==='abort')abort.abort();else{if(mode==='stale')current=false;if(mode==='late-invalid')controller.enqueue(Buffer.from('data: {\n\n'));controller.close();}
        if(mode==='complete')assert.ok((await p).sse.includes(answer));else await assert.rejects(p);
    }
});
test('a stated message id is reported unchanged and the item ids stay derived',async()=>{
    const out=await prepare().complete(upstream(encode(messageEvents())));
    assert.equal(out.responseId,messageId);
    const frames=out.sse.trimEnd().split('\n\n').map(b=>JSON.parse(b.split('\n')[1].slice(6)));
    assert.equal(frames[0].response.id,'resp_'+createHash('sha256').update(messageId).digest('hex').slice(0,24));
    assert.equal(frames[1].item.id,'msg_'+createHash('sha256').update(messageId).digest('hex').slice(0,20));
});
