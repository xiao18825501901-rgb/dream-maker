import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';

// The lane's build digest exists only in this test process's module graph.
const fixtureHash='c2'.repeat(32);
const routeUrl=new URL('../../dist/server/magpie-route.js',import.meta.url).href;
const production=await import(routeUrl+'?production');
assert.equal(production.supportsCodexSupervisorBuild(fixtureHash),false);
const hook=registerHooks({load(url,context,next){
    const result=next(url,context);
    if(url!==routeUrl)return result;
    const start='export function supportsCodexSupervisorBuild(binaryHash) {';
    const source=Buffer.from(result.source).toString();
    assert.ok(source.includes(start));
    return {...result,source:source.replace(start,start+'if(binaryHash==='+JSON.stringify(fixtureHash)+')return true;')};
}});
const {DeepSeekGateway}=await import('../../dist/server/deepseek-gateway.js');
const {MagpieDshRequestTransport}=await import('../../dist/server/magpie-model-transport.js');
const {prepareOwnedCodexSupervisorPayload}=await import('../../dist/server/magpie-owned.js');
const {NativeBudget}=await import('../../dist/server/native-budget.js');
const {magpieRouteHash}=await import(routeUrl);
const {hash,DomainError}=await import('../../dist/server/security.js');
const {offlineCustomBudget,offlineCustomQualification}=await import('../fixtures/custom-budget.mjs');
const {context,model,prompt,instructions,answer,requestBody,messageEvents,encode}=await import('../fixtures/codex-supervisor-wire.mjs');
hook.deregister();

/** Codex posts Responses to the loopback gateway; the transport carries Messages to the account. */
async function setup(t,role,mode){
    const ctx=context(role),{route,accounts}=ctx;
    const base=join(process.cwd(),'.runtime','test-temp');mkdirSync(base,{recursive:true});
    const root=mkdtempSync(join(base,'codex-translated-'));
    const budget=new NativeBudget(join(root,'ledger.sqlite'),{scopeId:'OFFLINE_CODEX_TRANSLATED',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2},undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
    const identity={projectId:'offline_project',runId:'offline_run',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',generation:'offline_owner',role,roleId:role};
    const price={provider:route.provider,model,currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+300000).toISOString(),maxInputTokens:64,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
    const epoch='offline_codex_epoch';
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
    let sends=0,responseBytes,observedAccept,observedVersion;
    const session={observation:{address:'127.0.0.1:12345',binaryHash:fixtureHash,epoch,accounts},control,close:()=>control.close(),
        prepareCodexSupervisorPayload:(context,raw)=>prepareOwnedCodexSupervisorPayload(fixtureHash,accounts,context,raw)};
    const assertCurrent=()=>{if(mode==='stale'&&sends)throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);};
    const channel=new MagpieDshRequestTransport({session,budget,route,role,codexSupervisor:{prompt:()=>prompt,instructions,assertCurrent,signal:ctx.signal},assertCurrent,
        bindRequest:payload=>({schema:'dream-maker.native-request-binding.v1',...identity,engineeringMode:'custom',work:{kind:'SUPERVISION'},routeHash:payload.routeHash,bodyHash:payload.bodyHash}),
        transport:async(url,init)=>{
            sends++;observedAccept=init.headers.accept;observedVersion=init.headers['anthropic-version'];
            assert.equal(url,'http://127.0.0.1:12345/v1/messages');
            assert.equal(init.headers.accept,'text/event-stream');
            // The Messages hop keeps its documented protocol version.
            assert.equal(init.headers['anthropic-version'],'2023-06-01');
            const [row]=budget.requests();assert.equal(row.binding.bodyHash,hash(init.body));assert.equal(row.routerAdmission.status,'ACKNOWLEDGED');
            const wire=JSON.parse(init.body);
            // The owned Magpie admits exactly provider/model on the body it receives.
            assert.equal(wire.model,'fixture/'+model);
            assert.deepEqual(wire.system,[{type:'text',text:instructions}]);
            assert.deepEqual(wire.messages,[{role:'user',content:[{type:'text',text:prompt}]}]);
            assert.ok(!init.body.includes('LOCAL_ONLY'));
            assert.equal(wire.max_tokens,32);assert.equal(row.maxOutputTokens,32);
            const events=messageEvents();
            if(mode==='unknown')events.pop();
            // The terminal counter lives on message_delta, not on the closing message_stop.
            if(mode==='over')Object.assign(events.at(-2),{usage:{output_tokens:33}});
            if(mode==='model')events[0].message.model='another/model';
            responseBytes=encode(events);
            return new Response(responseBytes,{headers:{'content-type':'text/event-stream'}});
        }});
    const gateway=new DeepSeekGateway(budget,()=>price,'',128,1,()=>assert.fail('direct fetch'),'responses',false,undefined,undefined,undefined,channel,undefined,model);
    t.after(async()=>{try{await gateway.close();}finally{budget.close();rmSync(root,{recursive:true,force:true});}});
    const {url,token}=await gateway.start();
    const body={...requestBody(),max_output_tokens:32};
    // The gateway already serves the `/v1` base, exactly as prepareCodexMagpieHome wires Codex.
    const post=()=>fetch(url+'/responses',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    return {budget,gateway,post,sends:()=>sends,accept:()=>observedAccept,version:()=>observedVersion,responseHash:()=>hash(responseBytes),session,route,role};
}

for(const role of ['planner2','reviewer'])test(role+' translated Responses to Messages',async t=>{
    const x=await setup(t,role,'ok'),reply=await x.post(),wire=await reply.text();
    assert.equal(reply.status,200,wire);
    assert.match(reply.headers.get('content-type'),/text\/event-stream/);
    // The CLI receives the Responses event sequence, never a Messages frame and never the qualifier.
    assert.match(wire,/event: response\.completed/);assert.match(wire,/event: response\.output_text\.delta/);
    assert.doesNotMatch(wire,/message_stop/);assert.ok(wire.includes(answer));assert.ok(!wire.includes('fixture/'+model));
    assert.equal(x.accept(),'text/event-stream');assert.equal(x.version(),'2023-06-01');
    const [row]=x.budget.requests();
    assert.deepEqual(row.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});assert.ok(row.chargedMicros>0);
    const receipt=x.gateway.confirmedSupervisorOutput(model,answer);
    assert.equal(row.id,receipt.id);assert.equal(receipt.responseSha256,x.responseHash());
    assert.equal(receipt.observedModel,model);assert.equal(receipt.finishReason,'end_turn');
    // One request per turn: a second post is refused before any second admission.
    assert.equal((await x.post()).status,409);assert.equal(x.sends(),1);
});

test('a short upstream stream is refused and never reported as a completed turn',async t=>{
    const x=await setup(t,'reviewer','unknown');
    const reply=await x.post();
    assert.equal(reply.status,502);
    assert.equal((await reply.text()).includes(answer),false);
    const [row]=x.budget.requests();assert.notEqual(row.outcome,'COMPLETE');assert.equal(row.usage,null);
});
test('usage beyond the frozen bound settles the reported charge and releases no text',async t=>{
    const x=await setup(t,'reviewer','over');
    const reply=await x.post();
    assert.equal(reply.status,502);
    const [row]=x.budget.requests();assert.equal(row.usageStatus,'KNOWN');assert.deepEqual(row.usage,{inputTokens:8,outputTokens:33,cacheHitTokens:2});
});
test('an upstream model other than the selected one is refused',async t=>{
    const x=await setup(t,'reviewer','model');
    assert.equal((await x.post()).status,502);
    assert.notEqual(x.budget.requests()[0].outcome,'COMPLETE');
});
test('a stale controller binding blocks the send before the account is touched',async t=>{
    const x=await setup(t,'reviewer','stale');
    assert.equal((await x.post()).status,502);
    assert.equal(x.sends(),1);
});
test('the qualification probe lane stays closed until it is wired',async()=>{
    // The probe transport has no hook for this lane, so a probe route fails closed instead of
    // silently borrowing the Claude or DSH supervisor lane.
    const {MagpieDshRequestTransport}=await import('../../dist/server/magpie-model-transport.js');
    const {context,model:selected}=await import('../fixtures/codex-supervisor-wire.mjs');
    const route=context('reviewer').route;
    assert.equal(route.protocol,'anthropic-messages');assert.equal(route.runtime,'codex');
    const ctx=context('reviewer');
    assert.throws(()=>new MagpieDshRequestTransport({session:{observation:{address:'127.0.0.1:12345',binaryHash:fixtureHash,accounts:ctx.accounts},control:{prepare(){throw Error('unexpected');}},close:async()=>{}},budget:{},route,role:'reviewer',assertCurrent(){},bindRequest:()=>({})}),{code:'MAGPIE_MODEL_ROLE_INVALID'});
    assert.equal(selected,model);
});
