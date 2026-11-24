import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = process.env.DM_CUSTOM_OFFICIAL_TEST_BUILD ?? resolve('dist');
const {officialCliClineProvider,officialCliClineProviders,officialCliOpenCodeConfig,runCustomOfficialCli} = await import(pathToFileURL(join(build,'server/providers/custom-official-cli.js')));
const {startOfficialCliMessagesTransport} = await import(pathToFileURL(join(build,'server/providers/custom-official-cli-messages-transport.js')));

const model = 'owner-lab/series/DM-Test:revision_2';
const id = 'msg_dm_offline_1';
const text = 'Offline messages fixture.';
const input = {model,signal:new AbortController().signal,assertCurrent(){},prompt:'@./file /skill $& local packet',maxOutputTokens:1024,gatewayToken:'local-fixture-only'};
const message = (patch={}) => ({id,type:'message',role:'assistant',model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:3},...patch});

async function gateway(handler) {
    const calls = [], server = createServer(async (req,res) => {
        let data = '';
        for await (const chunk of req) data += chunk;
        const row = {method:req.method,path:req.url,headers:req.headers,body:data ? JSON.parse(data) : undefined};
        calls.push(row);
        handler(row,res);
    });
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    return {calls,url:'http://127.0.0.1:'+server.address().port+'/v1',
        async close(){const done=once(server,'close');server.close();server.closeAllConnections();await done;}};
}
const key = bridge => ({'x-api-key':bridge.token,'anthropic-version':'2023-06-01'});
function request(bridge,{path='/messages',headers={},body}={}) {
    return fetch(bridge.url + path, {method:'POST',redirect:'error',headers:{'content-type':'application/json',...headers},
        body:JSON.stringify(body ?? {model,stream:true,messages:[{role:'user',content:[{type:'text',text:bridge.marker}]}]})});
}
const bridgeFor = async url => startOfficialCliMessagesTransport({...input,gatewayUrl:url});

test('the Messages bridge refuses every caller that is not the one x-api-key owner',async()=>{
    const upstream = await gateway((_,res)=>res.end(JSON.stringify(message())));
    const bridge = await bridgeFor(upstream.url);
    try {
        const bearer = await fetch(bridge.url + '/messages',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer ' + bridge.token},body:'{}'});
        assert.equal(bearer.status,403);
        assert.equal((await request(bridge,{headers:{...key(bridge),authorization:'Bearer ' + bridge.token}})).status,403);
        assert.equal((await request(bridge,{headers:{'x-api-key':'wrong-token'}})).status,403);
        assert.equal((await request(bridge,{headers:{}})).status,403);
        assert.equal((await request(bridge,{path:'/v1/chat/completions',headers:key(bridge)})).status,403);
        assert.equal((await request(bridge,{path:'/v1/messages?beta=true',headers:key(bridge)})).status,403);
        assert.equal(upstream.calls.length,0);
        assert.equal(bridge.responseId(),undefined);
    } finally {await bridge.close();await upstream.close();}
});

test('the Messages bridge forwards exactly one bounded text-only turn',async()=>{
    const upstream = await gateway((_,res)=>res.end(JSON.stringify(message())));
    const bridge = await bridgeFor(upstream.url);
    try {
        for (const change of [{tools:[{name:'read_files',input_schema:{type:'object'}}]},{tools:'none'},{stream:false},{stream:'yes'},{model:'other/model'},
            {messages:[]},{messages:new Array(65).fill({role:'user',content:'x'})},
            {messages:[{role:'user',content:[{type:'image',source:{}}]}]},{messages:[{role:'user',content:bridge.marker}]},
            {messages:[{role:'assistant',content:'hi'}],stream:true}]) {
            const other = await bridgeFor(upstream.url);
            try {
                const response = await request(other,{headers:key(other),body:change});
                assert.equal(response.status,502);
                assert.equal(await response.text(),'');
                assert.equal(other.responseId(),undefined);
            } finally {await other.close();}
        }
        assert.equal(upstream.calls.length,0);
    } finally {await bridge.close();await upstream.close();}
});

test('a gateway outside the loopback boundary is refused before a listener exists',async()=>{
    for (const url of ['http://example.invalid/v1','https://127.0.0.1:1234/v1','http://127.0.0.1/v1','http://localhost:1234/v1','','http://127.0.0.1:1234/v1?x=1'])
        await assert.rejects(bridgeFor(url),{code:'CUSTOM_OFFICIAL_CLI_UNVERIFIED'});
});

test('a completed owner answer becomes the six native Messages frames with echoed usage',async()=>{
    const upstream = await gateway((_,res)=>res.end(JSON.stringify(message({system_ignored:true}))));
    const bridge = await bridgeFor(upstream.url);
    try {
        const response = await request(bridge,{headers:{...key(bridge),'anthropic-version':'2023-06-01'},body:{model,stream:true,max_tokens:7,system:[{type:'text',text:'role instructions'}],tools:[],messages:[{role:'user',content:bridge.marker}]}});
        assert.equal(response.status,200);
        assert.equal(response.headers.get('content-type'),'text/event-stream');
        assert.equal(response.headers.get('cache-control'),'no-store');
        const frames = (await response.text()).trim().split('\n\n').map(chunk => {
            const lines = chunk.split('\n');
            assert.equal(lines.length,2);
            assert.equal(lines[0],'event: '+JSON.parse(lines[1].slice(6)).type);
            return JSON.parse(lines[1].slice(6));
        });
        assert.deepEqual(frames.map(frame=>frame.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
        assert.deepEqual(frames[0],{type:'message_start',message:{id,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
        assert.deepEqual(frames[1],{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
        assert.deepEqual(frames[2],{type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
        assert.deepEqual(frames[3],{type:'content_block_stop',index:0});
        assert.deepEqual(frames[4],{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});
        assert.deepEqual(frames[5],{type:'message_stop'});
        assert.equal(bridge.responseId(),id);
        assert.equal(upstream.calls.length,1);
        const call = upstream.calls[0];
        assert.equal(call.method,'POST');
        assert.equal(call.path,'/v1/messages');
        assert.equal(call.headers['x-api-key'],input.gatewayToken);
        assert.equal(call.headers['anthropic-version'],'2023-06-01');
        assert.equal(call.headers.authorization,undefined);
        assert.deepEqual(call.body,{model,messages:[{role:'user',content:input.prompt}],max_tokens:1024,stream:false,system:[{type:'text',text:'role instructions'}]});
        assert.equal((await request(bridge,{headers:key(bridge)})).status,403);
    } finally {await bridge.close();await upstream.close();}
});

test('an unusable owner answer is a bare 502 that never echoes the upstream body',async()=>{
    const failure = {error:{type:'invalid_request_error',message:'UPSTREAM SECRET DETAIL'}};
    for (const kind of ['status','tool_use','max_tokens','model','empty','garbage']) {
        const upstream = await gateway((_,res)=>{
            if (kind === 'status') {res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify(failure));return;}
            if (kind === 'garbage') {res.writeHead(200,{'content-type':'text/plain'});res.end('UPSTREAM SECRET DETAIL');return;}
            const doc = message();
            if (kind === 'tool_use') doc.content = [{type:'tool_use',id:'toolu_1',name:'read_files',input:{}}];
            if (kind === 'max_tokens') doc.stop_reason = 'max_tokens';
            if (kind === 'model') doc.model = 'other/model';
            if (kind === 'empty') doc.content = [{type:'text',text:'   '}];
            res.writeHead(200,{'content-type':'application/json'});
            res.end(JSON.stringify(doc));
        });
        const bridge = await bridgeFor(upstream.url);
        try {
            const response = await request(bridge,{headers:key(bridge)});
            assert.equal(response.status,502);
            const body = await response.text();
            assert.equal(body,'');
            assert.ok(!body.includes('SECRET'));
            assert.equal(bridge.responseId(),undefined);
        } finally {await bridge.close();await upstream.close();}
    }
});

test('the declared wire chooses the native Messages transport on both read-only CLIs',()=>{
    const base = 'http://127.0.0.1:4321/v1';
    const chat = officialCliOpenCodeConfig('chat-completions',model,base,'local-token',1024);
    const messages = officialCliOpenCodeConfig('anthropic-messages',model,base,'local-token',1024);
    assert.equal(chat.provider.dm.npm,'@ai-sdk/openai-compatible');
    assert.equal(messages.provider.dm.npm,'@ai-sdk/anthropic');
    assert.deepEqual(messages.provider.dm.options,{baseURL:base,apiKey:'local-token'});
    assert.deepEqual({...messages,provider:{dm:{...messages.provider.dm,npm:chat.provider.dm.npm}}},chat);
    assert.equal(officialCliClineProvider('chat-completions'),'openai-compatible');
    assert.equal(officialCliClineProvider('anthropic-messages'),'anthropic');
    const settings = {provider:'anthropic',model,apiKey:'local-token',baseUrl:base,protocol:'anthropic',client:'anthropic',maxTokens:1024,
        catalog:{loadLatestOnInit:false,includeClineCloudModels:false,loadPrivateOnAuth:false}};
    const anthropic = officialCliClineProviders('anthropic-messages',model,base,'local-token',1024);
    assert.equal(anthropic.version,1);
    assert.equal(anthropic.lastUsedProvider,'anthropic');
    assert.deepEqual(Object.keys(anthropic.providers),['anthropic']);
    assert.deepEqual(anthropic.providers.anthropic.settings,settings);
    assert.equal(anthropic.providers.anthropic.tokenSource,'manual');
    const clineChat = officialCliClineProviders('chat-completions',model,base,'local-token',1024);
    assert.deepEqual(clineChat.providers['openai-compatible'].settings,{...settings,provider:'openai-compatible',protocol:'openai-chat',client:'openai-compatible'});
});

test('a wire outside the two declared transports is refused before any process start',async()=>{
    const base = {...input,runtime:'opencode',role:'reviewer',timeoutMs:1000,gatewayUrl:'http://127.0.0.1:1234/v1',controllerRoot:resolve('.'),commandRef:{path:resolve('absent.exe'),sha256:'0'.repeat(64)},receipts:()=>[]};
    for (const wire of ['responses','openai-responses','chat',{}])
        await assert.rejects(runCustomOfficialCli({...base,wire}),{code:'CUSTOM_OFFICIAL_CLI_UNVERIFIED'});
});

test('a quoted bridge marker counts as the same single frozen slot',async()=>{
    const upstream = await gateway((_,res)=>res.end(JSON.stringify(message())));
    const bridge = await bridgeFor(upstream.url);
    try {
        const quoted = await request(bridge,{headers:key(bridge),body:{model,stream:true,messages:[{role:'user',content:[{type:'text',text:'"'+bridge.marker+'"'}]}]}});
        assert.equal(quoted.status,200);
        assert.equal(upstream.calls.length,1);
        assert.equal(upstream.calls[0].body.messages[0].content[0].text,input.prompt);
        assert.equal(upstream.calls.length,1);
    } finally {await bridge.close();await upstream.close();}
});
