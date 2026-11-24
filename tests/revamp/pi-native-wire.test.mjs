import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dist=resolve(process.env.DM_PI_WIRE_DIST ?? 'dist');
const {piNativeRequestBody,readPiNativeSse,assertPiNativeReplySafe,PI_NATIVE_CONTROLLER_SYSTEM}=await import(pathToFileURL(resolve(dist,'server/flow/pi-native-wire.js')));
const model='native-only', prompt='Read the fixture.', name='desk_read', args='{"path":"allowed.txt"}', output='{"content":"hello 世界"}', ephemeral={type:'ephemeral'};
const turn={callId:'call_fixture',itemId:'fc_fixture',name,arguments:args,output};
const root=new URL('../../integrations/magpie/v5/overlay/internal/gateway/dm_explicit_test.go',import.meta.url);
const golden=readFileSync(root,'utf8').match(/const dmNativeFixture = \x60([\s\S]*?)\x60/)[1];
const parse=s=>s.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\ndata: ')[1]));
const serialize=frames=>frames.map(f=>'event: '+f.type+'\ndata: '+JSON.stringify(f)+'\n\n').join('');
const stream=s=>new Response(s).body;
const flags=protocol=>({protocol,model,prompt,tools:[name],maxInputTokens:128,maxOutputTokens:512});
const schema={type:'object',properties:{path:{type:'string'}},required:['path']};
const desc=name+' (Dream Maker controlled project tool)';
function request(protocol,second=false){
    if(protocol==='openai-responses')return {model,tools:[{type:'function',name,description:desc,parameters:schema}],stream:true,store:false,max_output_tokens:512,prompt_cache_key:'fixture_key',input:[
        {role:'system',content:'CLI metadata'},{role:'user',content:[{type:'input_text',text:prompt}]},
        ...(second?[{type:'function_call',id:turn.itemId,call_id:turn.callId,name,arguments:args},{type:'function_call_output',call_id:turn.callId,output}]:[])]};
    return {model,max_tokens:512,stream:true,system:[{type:'text',text:'CLI metadata',cache_control:ephemeral}],tools:[{name,description:desc,eager_input_streaming:true,input_schema:schema,cache_control:ephemeral}],
        messages:[{role:'user',content:[{type:'text',text:prompt,...(second?{}:{cache_control:ephemeral})}]},...(second?[{role:'assistant',content:[{type:'tool_use',id:turn.callId,name,input:JSON.parse(args)}]},
        {role:'user',content:[{type:'tool_result',tool_use_id:turn.callId,content:output,is_error:false,cache_control:ephemeral}]}]:[])]};
}
function responsesTool(arg=args){
    const item={type:'function_call',id:turn.itemId,call_id:turn.callId,name,arguments:arg,status:'completed'};
    const envelope={id:'resp_fixture',model,object:'response',status:'completed',output:[item],usage:{input_tokens:9,input_tokens_details:{cached_tokens:2},output_tokens:4,total_tokens:13}};
    return [{type:'response.created',response:{id:envelope.id,model,object:'response',status:'in_progress',output:[]}},
        {type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},
        ...[arg.slice(0,7),arg.slice(7)].map(delta=>({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta})),
        {type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:arg},
        {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:envelope}];
}
function messages(tool,arg=args){
    return [{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:7,cache_read_input_tokens:2,cache_creation_input_tokens:0,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:turn.callId,name,input:{}}:{type:'text',text:''}},
        ...[tool?arg.slice(0,6):'héllo ',tool?arg.slice(6):'世界'].map(s=>({type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:s}:{type:'text_delta',text:s}})),
        {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:4}},{type:'message_stop'}];
}
for (const protocol of ['openai-responses','anthropic-messages']){
    const limits=flags(protocol), responses=protocol==='openai-responses';
    const toolFrames=arg=>responses?responsesTool(arg):messages(true,arg);
    const decode=(frames,l=limits)=>readPiNativeSse(stream(serialize(frames)),l);
    test(protocol+' freezes both captured request shapes and excludes unbound metadata',()=>{
        for(const second of [false,true]){
            const raw=request(protocol,second),history=second?[turn]:[],frozen=piNativeRequestBody(raw,limits,history);
            assert.ok(!JSON.stringify(frozen).includes('CLI metadata'));assert.ok(!JSON.stringify(frozen).includes('fixture_key'));
            // The Anthropic wire always carries a system block, taken from the frozen prompt or the controller line.
            if(!responses)assert.deepEqual(frozen.system,[{type:'text',text:PI_NATIVE_CONTROLLER_SYSTEM}]);
            const pinned={...limits,system:'CLI metadata',...(responses?{promptCacheKey:'fixture_key'}:{})};
            // Anthropic outbound keeps the frozen system text but always as blocks: the Go ingress rejects a bare string.
            const expected=responses?raw:{...raw,system:[{type:'text',text:'CLI metadata'}]};
            assert.deepEqual(piNativeRequestBody(raw,pinned,history),expected);
            assert.throws(()=>piNativeRequestBody(raw,{...pinned,system:'other'},history));
            if(responses)assert.throws(()=>piNativeRequestBody(raw,{...pinned,promptCacheKey:'other'},history));
            for(const change of [r=>r.model='other',r=>r.stream=false,r=>r[responses?'max_output_tokens':'max_tokens']++,r=>r.extra=true,r=>r.tools[0].name='desk_run',r=>r.tools.push(r.tools[0]),r=>r.tools[0].description+='extra',r=>r.tools[0][responses?'parameters':'input_schema'].properties.extra={type:'string'}]){
                const broken=structuredClone(raw);change(broken);assert.throws(()=>piNativeRequestBody(broken,limits,history));
            }
            assert.throws(()=>piNativeRequestBody(raw,{...limits,prompt:'other'},history));
        }
        const second=request(protocol,true);assert.throws(()=>piNativeRequestBody(second,limits));
        for(const change of [{output:'wrong'},{callId:'wrong'},{arguments:'{"path":"other"}'},{name:'desk_search'}])assert.throws(()=>piNativeRequestBody(second,limits,[{...turn,...change}]));
    });
    test(protocol+' fully verifies text, tool, cache and qualified response identity',async()=>{
        for(const [frames,tool] of [[toolFrames(),true],[responses?parse(golden):messages(false),false]]){
            const r=await decode(frames);assert.deepEqual(r.usage,{inputTokens:9,outputTokens:4,cacheHitTokens:2});assert.equal(r.usageLimitExceeded,false);
            assert.equal(r.text,tool?'':'héllo 世界');assert.equal(r.toolCall?.name??null,tool?name:null);if(tool)assert.equal(r.toolCall.arguments,args);
            assert.deepEqual(parse(r.sse),frames);assert.equal((await decode(frames,{...limits,maxInputTokens:8})).usageLimitExceeded,true);
            assert.equal((await decode(frames,{...limits,maxOutputTokens:3})).usageLimitExceeded,true);
            await assert.rejects(decode(frames,{...limits,responseModel:'other/'+model}));
            for(const corrupt of [frames.slice(0,-1),frames.slice(1),[...frames,frames[0]],[...frames.slice(0,2),frames[1],...frames.slice(2)]])await assert.rejects(decode(corrupt));
        }
    });
    test(protocol+' blocks undeclared args, duplicate keys, hidden string values, and index drift',async()=>{
        for(const bad of ['{}','[]','{"path":42}','{"path":"a","path":"b"}','{"path":"a","unexpected":false}','{bad'])await assert.rejects(decode(toolFrames(bad)));
        await assert.rejects(decode(toolFrames(),{...limits,tools:[]}));const drift=toolFrames();if(responses)drift[2].item_id='other';else drift[2].index=1;await assert.rejects(decode(drift));
        const encoded=await decode(toolFrames('{"path":"h\\u0069dden"}'));assert.throws(()=>assertPiNativeReplySafe(encoded,s=>assert.ok(!s.includes('hidden'))));
    });
}
test('SSE framing, byte cap, cancellation, terminal snapshots and usage',async()=>{
    const l=flags('openai-responses'), read=s=>readPiNativeSse(stream(s),l);
    const bytes=Buffer.from(golden.replaceAll('\n','\r\n'));let i=0;
    assert.equal((await readPiNativeSse(new ReadableStream({pull(c){if(i===bytes.length)c.close();else c.enqueue(bytes.subarray(i,++i));}}),l)).text,'héllo 世界');
    for(const s of [golden.replace('"cached_tokens":2','"cached_tokens":7,"cached_tokens":2'),golden.trimEnd(),golden+'data: [DONE]\n\n',golden.replace('event: response.created','event: wrong'),Buffer.from([0xff]),'x'.repeat(2*1024*1024+1)])await assert.rejects(read(s));
    for(const mutate of [f=>f.at(-1).response.model='other',f=>f.at(-1).response.id='other',f=>f.at(-1).response.output[0].content[0].text='other',f=>delete f.at(-1).response.usage,f=>f.at(-1).response.usage.input_tokens_details.cached_tokens=10,f=>f.at(-1).response.usage.output_tokens=-1,f=>f.at(-1).response.usage.total_tokens=0]){const f=parse(golden);mutate(f);await assert.rejects(read(serialize(f)));}
    let canceled=false;const ac=new AbortController(),promise=readPiNativeSse(new ReadableStream({cancel(){canceled=true;}}),l,ac.signal);ac.abort();await assert.rejects(promise);assert.ok(canceled);
    for(const mutate of [f=>f[0].message.usage.cache_creation_input_tokens=1,f=>f.at(-2).usage.cache_creation_input_tokens=1,f=>delete f[0].message.usage.cache_read_input_tokens,f=>f.at(-2).delta.stop_reason='tool_use',f=>f.at(-2).usage.input_tokens=42]){const f=messages(false);mutate(f);await assert.rejects(readPiNativeSse(stream(serialize(f)),flags('anthropic-messages')));}
});
