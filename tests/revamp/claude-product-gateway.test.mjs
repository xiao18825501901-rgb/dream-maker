import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';

// The extra digest exists only in this test process's module graph.
const fixtureHash='c1'.repeat(32);
const routeUrl=new URL('../../dist/server/magpie-route.js',import.meta.url).href;
const production=await import(routeUrl+'?production');
assert.equal(production.supportsClaudeReadOnlyBuild(fixtureHash),false);
const hook=registerHooks({load(url,context,next){
    const result=next(url,context);
    if(url!==routeUrl)return result;
    const start='export function supportsClaudeReadOnlyBuild(binaryHash) {';
    const source=Buffer.from(result.source).toString();
    assert.ok(source.includes(start));
    return {...result,source:source.replace(start,start+'if(binaryHash==='+JSON.stringify(fixtureHash)+')return true;')};
}});
const {DeepSeekGateway}=await import('../../dist/server/deepseek-gateway.js');
const {MagpieDshRequestTransport}=await import('../../dist/server/magpie-model-transport.js');
const {prepareOwnedClaudePayload}=await import('../../dist/server/magpie-owned.js');
const {NativeBudget}=await import('../../dist/server/native-budget.js');
const {magpieRouteHash}=await import(routeUrl);
const {hash,DomainError}=await import('../../dist/server/security.js');
const {offlineCustomBudget,offlineCustomQualification}=await import('../fixtures/custom-budget.mjs');
const {context,model,prompt,instructions,answer,requestBody,ingress,chatDoc,responseEvents,encode}=await import('../fixtures/claude-readonly-wire.mjs');
hook.deregister();

async function setup(t,protocol,role,mode,qualification=false){
    const ctx=context(protocol,role),{route,accounts}=ctx;
    const base=join(process.cwd(),'.runtime','test-temp');mkdirSync(base,{recursive:true});
    const root=mkdtempSync(join(base,'claude-gateway-'));
    const budget=new NativeBudget(join(root,'ledger.sqlite'),{scopeId:'OFFLINE_CLAUDE',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2},undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
    const identity={projectId:'offline_project',runId:'offline_run',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',generation:'offline_owner',role,roleId:role};
    const cap={currency:'CNY',maxMicros:5000000};
    const probe={...identity,schema:'dream-maker.custom-probe-budget.v1',probeId:'custom_probe_offline',bindingHash:'d'.repeat(64),routeHash:magpieRouteHash(route),flowBudget:cap,roleBudget:cap};
    const permit=qualification&&budget.beginCustomProbe(probe);
    const price={provider:route.provider,model,currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+300000).toISOString(),maxInputTokens:64,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
    const epoch='offline_claude_epoch';
    const {PassThrough,Writable}=await import('node:stream');
    const {MagpieAdmissionPipe}=await import('../../dist/server/magpie-control.js');
    const output=new PassThrough(),closed=Promise.withResolvers();
    const input=new Writable({write(bytes,_encoding,callback){
        const raw=bytes.toString().trimEnd(),frame=JSON.parse(raw),a=frame.request??frame.admission;
        const receipt={epoch,id:a.id,reservationId:a.reservationId,controlHash:hash(raw),accepted:true};
        const reply=frame.type==='issue'?{type:'issued',schema:'dream-maker.magpie-issued-key.v1',upstreamKeyId:'e'.repeat(24),upstreamKey:'sk-magpie-key-'+'f'.repeat(48),expiresAtMs:Date.now()+120000}:{type:'admission',schema:'dream-maker.magpie-admission-ack.v2'};
        output.write(JSON.stringify({...receipt,...reply})+'\n');callback();
    }});
    const control=new MagpieAdmissionPipe({input,output,closed:closed.promise,stop:async()=>closed.resolve()},budget,{epoch,binaryHash:fixtureHash,ackTimeoutMs:5000});
    let sends=0,responseBytes;
    const session={observation:{address:'127.0.0.1:12345',binaryHash:fixtureHash,epoch,accounts},control,close:()=>control.close(),prepareClaudePayload:(context,raw)=>prepareOwnedClaudePayload(fixtureHash,accounts,context,raw)};
    const assertCurrent=()=>{if(mode==='stale'&&sends||mode==='stale after settlement'&&budget.requests().some(row=>row.usageStatus==='KNOWN'))throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);};
    const channel=new MagpieDshRequestTransport({session,budget,route,role,claude:{prompt,instructions,assertCurrent,signal:ctx.signal},assertCurrent,
        bindRequest:payload=>({schema:'dream-maker.native-request-binding.v1',...identity,engineeringMode:'custom',work:permit?{kind:'QUALIFICATION',probeId:probe.probeId,bindingHash:probe.bindingHash}:{kind:'SUPERVISION'},routeHash:payload.routeHash,bodyHash:payload.bodyHash}),
        transport:async(url,init)=>{
            sends++;
            const chat=protocol==='chat-completions';
            assert.equal(url,'http://127.0.0.1:12345'+(chat?'/v1/chat/completions':'/v1/responses'));
            assert.equal(init.headers.accept,chat?'application/json':'text/event-stream');
            const [row]=budget.requests();assert.equal(row.binding.bodyHash,hash(init.body));assert.equal(row.routerAdmission.status,'ACKNOWLEDGED');
            const wire=JSON.parse(init.body);assert.equal(wire.model,'fixture/'+model);assert.ok(!init.body.includes('LOCAL_ONLY'));assert.equal(row.maxOutputTokens,32);
            assert.equal(chat?wire.messages[0].content:wire.instructions,instructions);
            if(chat){const doc=chatDoc();if(mode==='unknown')delete doc.usage;if(mode==='over')Object.assign(doc.usage,{completion_tokens:33,total_tokens:41});responseBytes=JSON.stringify(doc);}
            else {const events=responseEvents();if(mode==='unknown')events.pop();if(mode==='over')Object.assign(events.at(-1).response.usage,{output_tokens:33,total_tokens:41});responseBytes=encode(events);}
            return new Response(responseBytes,{headers:{'content-type':init.headers.accept}});
        }});
    const gateway=new DeepSeekGateway(budget,()=>price,'',128,1,()=>assert.fail('direct fetch'),'anthropic-messages',true,undefined,undefined,undefined,channel,permit?{permit,assertCurrent}:undefined,model);
    t.after(async()=>{try{await gateway.close();}finally{if(permit)budget.endCustomProbe(permit);budget.close();rmSync(root,{recursive:true,force:true});}});
    const {url,token}=await gateway.start();
    const post=(body={...requestBody(),max_tokens:32})=>fetch(url+'/messages?beta=true',{method:'POST',headers:{'x-api-key':token,'anthropic-version':'2023-06-01','content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
    return {budget,gateway,post,sends:()=>sends,responseHash:()=>hash(responseBytes)};
}
for(const protocol of ['chat-completions','openai-responses']){
    for(const role of ['planner2','reviewer'])for(const qualification of [false,true])test([protocol,role,qualification?'probe':'formal'].join(' '),async t=>{
        const x=await setup(t,protocol,role,'ok',qualification),reply=await x.post(),wire=await reply.text();
        assert.equal(reply.status,200,wire);assert.match(wire,/event: message_stop/);assert.ok(wire.includes(answer));assert.ok(!wire.includes('fixture/'+model));
        const [row]=x.budget.requests();assert.deepEqual(row.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});assert.ok(row.chargedMicros>0);
        const receipt=x.gateway.confirmedSupervisorOutput(model,answer);assert.equal(row.id,receipt.id);assert.equal(receipt.responseSha256,x.responseHash());
        assert.equal((await x.post()).status,409);assert.equal(x.sends(),1);
    });
    for(const mode of ['unknown','over','stale','tool'])test(protocol+' fails closed on '+mode,async t=>{
        const x=await setup(t,protocol,'reviewer',mode);const body={...requestBody(),max_tokens:32};if(mode==='tool')body.tools=[{name:'write'}];
        const reply=await x.post(body),wire=await reply.text();assert.ok(reply.status>=400,wire);assert.ok(!wire.includes(answer));
        const rows=x.budget.requests();if(mode==='tool'){assert.equal(rows.length,0);assert.equal(x.sends(),0);return;}
        assert.equal(rows.length,1);assert.equal(x.sends(),1);
        assert.equal(rows[0].usageStatus,mode==='over'?'KNOWN':'UNKNOWN');if(mode==='over'){assert.equal(rows[0].usage.outputTokens,33);assert.equal(x.gateway.receipts()[0].responseSha256,x.responseHash());}
        assert.throws(()=>x.gateway.confirmedSupervisorOutput(model,answer));
    });
}
for(const protocol of ['chat-completions','openai-responses']){
    test(protocol+' rejects duplicate original JSON keys before reservation',async t=>{
        const x=await setup(t,protocol,'planner2','ok');
        const raw=JSON.stringify(requestBody()).replace('{','{"model":"unselected",');
        const reply=await x.post(raw);assert.ok(reply.status>=400);assert.equal(x.sends(),0);assert.equal(x.budget.requests().length,0);
    });
    test(protocol+' suppresses text when ledger settlement throws',async t=>{
        const x=await setup(t,protocol,'reviewer','ok');
        let settlement=false;x.budget.settle=()=>{settlement=true;throw new DomainError('BUDGET_SETTLEMENT_CONFLICT',409);};
        await assert.rejects(x.post());assert.equal(settlement,true);assert.equal(x.sends(),1);
        assert.equal(x.budget.requests()[0].usageStatus,'PENDING');assert.deepEqual(x.gateway.receipts(),[]);
    });
    test(protocol+' suppresses settled text after binding revocation',async t=>{
        const x=await setup(t,protocol,'planner2','stale after settlement');
        const reply=await x.post(),wire=await reply.text();assert.equal(reply.status,502);assert.ok(!wire.includes(answer));
        assert.equal(x.budget.requests()[0].usageStatus,'KNOWN');assert.equal(x.gateway.receipts()[0].completionObserved,false);
    });
}
test('physical admission rejects unknown digest, executor, native preference and ambiguous account',()=>{
    const ctx=context(),raw=ingress(requestBody());
    const attempt=(digest,accounts,role)=>()=>prepareOwnedClaudePayload(digest,accounts,{...ctx,role},raw);
    for(const check of [attempt('a'.repeat(64),ctx.accounts,'reviewer'),attempt(fixtureHash,ctx.accounts,'executor'),attempt(fixtureHash,[...ctx.accounts,...ctx.accounts],'reviewer'),attempt(fixtureHash,[{...ctx.accounts[0],capabilities:[...ctx.accounts[0].capabilities,{model,protocol:'anthropic-messages'}]}],'reviewer')])assert.throws(check,{code:'MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'});
});
