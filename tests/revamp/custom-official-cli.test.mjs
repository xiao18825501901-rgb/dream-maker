import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {copyFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = process.env.DM_CUSTOM_OFFICIAL_TEST_BUILD ?? resolve('dist');
const {runCustomOfficialCli,bindOfficialCliReceipt,openCodeResult,clineSessionId} = await import(pathToFileURL(join(build,'server/providers/custom-official-cli.js')));
const {startOfficialCliTransport} = await import(pathToFileURL(join(build,'server/providers/custom-official-cli-transport.js')));
const sha = s => createHash('sha256').update(s).digest('hex');
const text = 'Offline receipt fixture.';
const id = 'msg_offline';
const model = 'owner-lab/series/DM-Test:revision_2';
const input = {model,signal:new AbortController().signal,assertCurrent(){},prompt:'@./file /skill $& local packet',maxOutputTokens:1024,gatewayToken:'local-fixture-only'};
function receipt(model) { return {id:'owner-reservation-1',requestedModel:model,observedModel:model,responseModelMatched:true,completionObserved:true,outcome:'COMPLETE',finishReason:'stop',responseId:id,responseSha256:sha(text),outputTextHash:sha(text),usage:{inputTokens:10,outputTokens:3}}; }
function chat(model){ return {id,object:'chat.completion',model,choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}; }
async function fixture(fn) {
    const calls = [], server = createServer(async(req,res)=>{
        let data=''; for await(const c of req)data+=c;
        const body=JSON.parse(data); calls.push({path:req.url,body,auth:req.headers.authorization,apiKey:req.headers['x-api-key']});fn(body,res);
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    return {calls,url:'http://127.0.0.1:'+server.address().port+'/v1', async close(){const done=once(server,'close');server.close();server.closeAllConnections();await done;}};
}
function request(bridge,changes={}) {return fetch(bridge.url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({model,stream:true,messages:[{role:'user',content:bridge.marker}],...changes})});}

test('one exclusive completed owner receipt binds session, text, usage and reservation',()=>{
    const row=receipt(model); const bind=(rows,overrides={})=>bindOfficialCliReceipt({...input,receipts:()=>rows,...overrides},'native-session',text,id);
    assert.deepEqual(bind([row]),{model,text,sessionId:'native-session',requestId:row.id,inputTokens:10,outputTokens:3,costUsd:null});
    for(const patch of [{outcome:'UNKNOWN'},{outputTextHash:sha('other')},{observedModel:'other'},{responseId:'other'},{completionObserved:false},{finishReason:'tool_use'},{responseSha256:null}]) assert.throws(()=>bind([{...row,...patch}]));
    for(const rows of [[],[row,row]])assert.throws(()=>bind(rows));
    assert.throws(()=>bind([row],{assertCurrent:async()=>{}}));
});

test('OpenCode binds every text frame to one native session and message',()=>{
    const frame=(type,part)=>({type,sessionID:'session-A.v2',part:{type:type.replace('_','-'),sessionID:'session-A.v2',messageID:'message-A.v2',...part}});
    const rows=[frame('step_start',{}),frame('text',{text}),frame('step_finish',{reason:'stop'})];
    const parse=()=>openCodeResult(rows.map(r=>JSON.stringify(r)).join('\n'));
    assert.deepEqual(parse(),{sessionId:'session-A.v2',text});
    rows[1].part.sessionID='ses_B';assert.throws(parse);
    rows[1].part.sessionID='session-A.v2';rows[1].part.messageID='msg_B';assert.throws(parse);
});

test('Cline reads the matching manifest in the sole native session directory', t=>{
    const data=mkdtempSync(join(tmpdir(),'dm-cline-sessions-'));
    t.after(()=>rmSync(data,{recursive:true,force:true}));
    const sessions=join(data,'sessions'), sessionId='conversation.2026-V2', dir=join(sessions,sessionId);
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(sessions,'index.json'),'{}');
    const manifest={session_id:sessionId,source:'cli',status:'completed',exit_code:0,interactive:false,provider:'openai-compatible',model,cwd:data,workspace_root:data,prompt:'marker'};
    const file=join(dir,sessionId+'.json'), read=()=>clineSessionId(data,model,data,'marker');
    writeFileSync(file,JSON.stringify(manifest));assert.equal(read(),sessionId);
    for(const change of [{session_id:'another-id'},{model:'DM-Test:revision_2'},{prompt:'stale'},{cwd:dir}]){
        writeFileSync(file,JSON.stringify({...manifest,...change}));assert.throws(read);
    }
    writeFileSync(file,JSON.stringify(manifest));mkdirSync(join(sessions,'second'));assert.throws(read);
});

test('Custom model IDs are passed verbatim and old Claude supervisor retains its contract',async()=>{
    const {launchClaudeSupervisor,runClaudeSupervisor}=await import(pathToFileURL(join(build,'server/providers/claude-supervisor.js')));
    const base={...input,controllerRoot:resolve('.'),command:resolve('absent.exe'),role:'reviewer',gatewayUrl:'http://127.0.0.1:1234',timeoutMs:1000,signal:AbortSignal.abort()};
    for(const name of [model,'vendor:release','vendor/family','plain-model'])await assert.rejects(launchClaudeSupervisor({...base,model:name}),{code:'RUN_CANCELLED'});
    await assert.rejects(runClaudeSupervisor(base),{code:'CLAUDE_SUPERVISOR_INPUT_INVALID'});
    for(const name of ['../escape','vendor//model','vendor/../x','https://url','-option','model\n','v'.repeat(161)])await assert.rejects(launchClaudeSupervisor({...base,model:name}),{code:'CLAUDE_SUPERVISOR_INPUT_INVALID'});
});

test('reject executor, remote route, stale state and a pre-used gateway before process start',async()=>{
    const base={...input,runtime:'opencode',role:'reviewer',timeoutMs:1000,gatewayUrl:'http://127.0.0.1:1234/v1',controllerRoot:resolve('.'),commandRef:{path:resolve('absent.exe'),sha256:'0'.repeat(64)},receipts:()=>[]};
    for(const patch of [{role:'executor'},{gatewayUrl:'https://example.invalid'},{assertCurrent(){throw Error('stale');}},{receipts:()=>[receipt(model)]},{signal:AbortSignal.abort()}])await assert.rejects(runCustomOfficialCli({...base,...patch}));
});

test('bridge admits one request, forwards only bounded chat and returns a text stream',async()=>{
    const owner=await fixture((_,res)=>res.end(JSON.stringify(chat(model))));
    const bridge=await startOfficialCliTransport({...input,gatewayUrl:owner.url});
    try {
        const response=await request(bridge,{tools:[{type:'function',function:{name:'unused'}}],max_tokens:999999});assert.equal(response.status,200);assert.match(await response.text(),/Offline receipt fixture/);
        assert.equal((await request(bridge)).status,403);assert.equal(bridge.responseId(),id);
        assert.deepEqual(owner.calls,[{path:'/v1/chat/completions',auth:'Bearer '+input.gatewayToken,apiKey:undefined,body:{model,messages:[{role:'user',content:input.prompt}],max_tokens:1024,stream:false}}]);
    } finally {await bridge.close();await owner.close();}
});

test('bridge withholds tool calls, foreign models and stale completions',async()=>{
    for(const kind of ['tool','model','stale','cancel','marker']){
        const controller=new AbortController(); let checks=0;
        const owner=await fixture((_,res)=>{const doc=chat(model);if(kind==='tool')doc.choices[0].message.tool_calls=[{}];if(kind==='model')doc.model='other';if(kind==='cancel')controller.abort();res.end(JSON.stringify(doc));});
        const bridge=await startOfficialCliTransport({...input,gatewayUrl:owner.url,signal:controller.signal,assertCurrent(){if(++checks===2&&kind==='stale')throw Error('stale');}});
        try{const response=await request(bridge,kind==='marker'?{messages:[{role:'user',content:'wrong'}]}:{});assert.equal(response.status,502);assert.equal(await response.text(),'');assert.equal(bridge.responseId(),undefined);if(kind==='marker')assert.equal(owner.calls.length,0);}finally{await bridge.close();await owner.close();}
    }
});

function anthropic(model,res){
    const frames=[['message_start',{message:{id,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}}],['content_block_start',{index:0,content_block:{type:'text',text:''}}],['content_block_delta',{index:0,delta:{type:'text_delta',text}}],['content_block_stop',{index:0}],['message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}}],['message_stop',{}]];
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(frames.map(([type,body])=>'event: '+type+'\ndata: '+JSON.stringify({type,...body})+'\n\n').join(''));
}
// Each optional integration uses an explicit operator-supplied binary and its trusted digest.
for(const runtime of ['opencode','cline','claude']){
    const prefix='DM_CUSTOM_TEST_'+runtime.toUpperCase(), command=process.env[prefix], sha256=process.env[prefix+'_SHA256'];
    test(runtime+' official executable completes independent no-tools planner and reviewer sessions',{skip:!command||!sha256},async()=>{
        const root=mkdtempSync(join(tmpdir(),'dm-cli-test-'));mkdirSync(join(root,'scripts','isolation'),{recursive:true});copyFileSync(resolve('scripts/isolation/windows-owned-job.cs'),join(root,'scripts','isolation','windows-owned-job.cs'));
        const observed=new Set();const selected=model;
        try{for(const role of ['planner2','reviewer']){
            const rows=[];const owner=await fixture((body,res)=>{rows.push(receipt(selected));if(runtime==='claude')anthropic(selected,res);else res.end(JSON.stringify(chat(selected)));});
            try{const result=await runCustomOfficialCli({...input,model:selected,role,runtime,commandRef:{path:command,sha256},gatewayUrl:owner.url,controllerRoot:root,timeoutMs:300000,receipts:()=>rows});
                assert.equal(owner.calls.length,1);const call=owner.calls[0];assert.equal(call.body.model,selected);assert.ok(!call.body.tools?.length);assert.ok(JSON.stringify(call.body.messages).includes(input.prompt));assert.ok(call.auth==='Bearer '+input.gatewayToken||call.apiKey===input.gatewayToken);
                assert.equal(result.requestId,rows[0].id);assert.equal(result.text,text);assert.ok(!observed.has(result.sessionId));observed.add(result.sessionId);
            }finally{await owner.close();}
        }}finally{rmSync(root,{recursive:true,force:true,maxRetries:3});}
    });
}
