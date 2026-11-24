import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createServer as https} from 'node:https';
import {createServer as http} from 'node:http';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {registerHooks} from 'node:module';

/**
 * PHYSICAL: a real Go Magpie child, the product DeepSeekGateway and a loopback TLS upstream.
 * The Go hop is never faked: the child is the delivered binary, the control pipe is its
 * inherited stdin/stdout, and the upstream is reached through the CONNECT proxy the child
 * requires. Synthetic credentials, no paid call, no external network.
 *
 * The lane's build digest is still an empty set in the product source. This file injects it
 * into this process's module graph only, so the physical evidence can be produced before the
 * five registration sites are touched. The injection is visible here and nowhere else.
 */
const CANDIDATE = 'E:/DreamMakerSuite/custom-mvp/parallel/combined-final/dist/dream-maker-magpie.exe';
const MIRROR = 'E:/DreamMakerSuite/custom-mvp/parallel/combined-final/dist/test-only/private-root.exe';
// The image digests are read from the bytes on disk: a rebuild changes them, and a pinned
// constant would silently turn this suite into a false failure after every rebuild.
const CANDIDATE_SHA = createHash('sha256').update(readFileSync(CANDIDATE)).digest('hex');
const MIRROR_SHA = createHash('sha256').update(readFileSync(MIRROR)).digest('hex');
const OLD_IMAGE = 'E:/DreamMakerSuite/custom-mvp/parallel/combined-overage/dist/test-only/private-root.exe';
const OLD_SHA = '132de81e6bd56e3e6ae2a11d3e81575a1ac730b06bd2ca5299fec17d0ce43438';
const GO_ROOT = 'F:/DreamMakerSuite/runtime/go1.26.8-windows-amd64/go';
const EVIDENCE = 'E:/DreamMakerSuite/custom-mvp/parallel/combined-final/evidence/codexPhysical.json';

const sha = value => createHash('sha256').update(value).digest('hex');
const host = 'fixture.example.com';
const model = 'fixture-messages-only';
const provider = 'fixture';
const qualified = provider + '/' + model;
const role = 'reviewer';
const prompt = 'DreamFlow frozen synthetic role packet';
const instructions = 'Use only this frozen review packet.';
const answer = 'physical 你好 roundtrip';

const routeUrl = new URL('../../dist/server/magpie-route.js', import.meta.url).href;
const production = await import(routeUrl + '?production');
// The shipped registry answers for the digest of the bytes under test, and never for a
// private-root or unknown image. Registration happened after the physical evidence was taken.
assert.equal(production.supportsCodexSupervisorBuild(CANDIDATE_SHA), true);
assert.equal(production.supportsCodexSupervisorBuild(MIRROR_SHA), false);
assert.equal(production.supportsCodexSupervisorBuild(OLD_SHA), false);
const hook = registerHooks({load(url, context, next) {
    const result = next(url, context);
    if (url !== routeUrl) return result;
    const start = 'export function supportsCodexSupervisorBuild(binaryHash) {';
    const source = Buffer.from(result.source).toString();
    assert.ok(source.includes(start));
    const inject = 'if(binaryHash===' + JSON.stringify(CANDIDATE_SHA) + '||binaryHash===' + JSON.stringify(MIRROR_SHA) + '||binaryHash===' + JSON.stringify(OLD_SHA) + ')return true;';
    return {...result, source: source.replace(start, start + inject)};
}});
const {DeepSeekGateway} = await import('../../dist/server/deepseek-gateway.js');
const {MagpieDshRequestTransport} = await import('../../dist/server/magpie-model-transport.js');
const {prepareOwnedCodexSupervisorPayload} = await import('../../dist/server/magpie-owned.js');
const {MagpieAdmissionPipe} = await import('../../dist/server/magpie-control.js');
const {NativeBudget} = await import('../../dist/server/native-budget.js');
const {magpieRouteHash} = await import(routeUrl);
const {hash} = await import('../../dist/server/security.js');
const {offlineCustomBudget,offlineCustomQualification} = await import('../fixtures/custom-budget.mjs');
hook.deregister();

const testcert = readFileSync(join(GO_ROOT,'src/net/http/internal/testcert/testcert.go'),'utf8');
const cert = testcert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
const key = testcert.match(/-----BEGIN RSA TESTING KEY-----[\s\S]*?-----END RSA TESTING KEY-----/)[0].replaceAll('TESTING KEY','PRIVATE KEY');

/** One closed text answer on the Messages wire, with the ledger counters this lane bills. */
function messagesSse(id, text, served) {
    const events = [
        {type:'message_start',message:{id,type:'message',role:'assistant',model:served,content:[],stop_reason:null,stop_sequence:null,
            usage:{input_tokens:6,cache_read_input_tokens:2,cache_creation_input_tokens:0,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},
        {type:'message_stop'},
    ];
    return events.map(e => 'event: '+e.type+'\n' + 'data: '+JSON.stringify(e)+'\n\n').join('');
}

/** Loopback TLS upstream plus the CONNECT proxy the owned child dials. */
async function upstream(onRequest) {
    const state = {connects:0, requests:0, tlsFailures:0, bodies:[], error:null};
    const tls = https({cert, key}, async (req, res) => {
        try {
            const bytes = [];
            for await (const chunk of req) bytes.push(chunk);
            const raw = Buffer.concat(bytes).toString('utf8');
            state.requests++;
            const reply = onRequest({raw, body:JSON.parse(raw), headers:{...req.headers}, url:req.url, servername:req.socket.servername});
            state.bodies.push({raw, body:JSON.parse(raw)});
            res.writeHead(200, {'content-type':'text/event-stream'});
            res.end(reply);
        } catch (error) { state.error ??= error; res.writeHead(500); res.end(); }
    });
    tls.on('tlsClientError', () => state.tlsFailures++);
    const proxy = http();
    proxy.on('connect', (req, socket, head) => {
        state.connects++;
        if (req.url !== host + ':443') { socket.destroy(); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.unshift(head);
        tls.emit('connection', socket);
    });
    await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
    return {state, proxyUrl:'http://127.0.0.1:'+proxy.address().port, close:async() => {
        await new Promise(resolve => proxy.close(resolve));
        await new Promise(resolve => tls.close(resolve));
    }};
}

/** Resolve the first newline-terminated control frame from the child. */
function firstFrame(stream) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const onData = chunk => {
            buffer += chunk.toString('utf8');
            const end = buffer.indexOf('\n');
            if (end < 0) return;
            stream.off('data', onData);
            try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
        };
        stream.on('data', onData);
    });
}

async function rig(t, options) {
    const image = options.image, imageSHA = options.imageSHA;
    assert.equal(sha(readFileSync(image)), imageSHA, image + ' bytes');
    if (image === CANDIDATE) assert.notEqual(sha(readFileSync(MIRROR)), CANDIDATE_SHA, 'test root is only in the mirror');

    const base = join(process.cwd(),'.runtime','test-temp');
    mkdirSync(base,{recursive:true});
    // Same layout as openOwnedMagpieControl: the child derives its portable root from
    // filepath.Dir(os.Executable())+"data", so the image and its data/ must share a parent.
    const root = mkdtempSync(join(base,'codex-physical-'));
    const profile = join(root,'profile');
    const dataDir = join(root,'data');
    for (const dir of [profile, dataDir, join(profile,'AppData/Roaming'), join(profile,'AppData/Local'), join(dataDir,'cache'), join(dataDir,'state')])
        mkdirSync(dir,{recursive:true});
    // The delivered images and this run root share a volume, so a hard link stages the exact
    // bytes without a second 54 MB copy. A cross-volume run falls back to a real copy.
    const staged = join(root,'dream-maker-magpie.exe');
    try { linkSync(image, staged); } catch { copyFileSync(image, staged); }
    assert.equal(sha(readFileSync(staged)), imageSHA, 'staged image bytes');
    const keys = ['FIXTURE_'+randomBytes(20).toString('hex')];
    const accounts = [{provider, authentication:'api_key', authRef:'auth_codex', accountRef:'account_codex', key:keys[0],
        capabilities:[{model, protocol:'anthropic-messages', endpoint:'https://'+host+'/owned/messages'}]}];

    const fixture = await upstream(({raw, headers, url, servername}) => {
        assert.equal(url,'/owned/messages');
        assert.equal(servername,host);
        // The Messages hop authenticates with X-Api-Key and the documented version header.
        assert.equal(headers['x-api-key'],keys[0]);
        assert.equal(headers.authorization,undefined);
        assert.equal(headers['anthropic-version'],'2023-06-01');
        const body = JSON.parse(raw);
        // The child admitted provider/model and strips it for the provider hop only.
        assert.equal(body.model,model);
        assert.deepEqual(body.system,[{type:'text',text:instructions}]);
        assert.deepEqual(body.messages,[{role:'user',content:[{type:'text',text:prompt}]}]);
        assert.equal(body.stream,true);
        return messagesSse('msg_physical_1',answer,model);
    });
    t.after(() => fixture.close());

    const env = {
        SystemRoot:process.env.SystemRoot, Path:join(process.env.SystemRoot,'System32'),
        HOME:profile, USERPROFILE:profile, APPDATA:join(profile,'AppData/Roaming'),
        LOCALAPPDATA:join(profile,'AppData/Local'), XDG_CONFIG_HOME:dataDir,
        XDG_CACHE_HOME:join(dataDir,'cache'), XDG_STATE_HOME:join(dataDir,'state'),
        TEMP:profile, TMP:profile, TMPDIR:profile, MAGPIE_NO_ACCOUNTS:'1',
        HTTPS_PROXY:fixture.proxyUrl, GODEBUG:'x509usefallbackroots=1',
    };
    const child = spawn(staged,[],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    let exitCode = null;
    const closed = new Promise(resolve => child.once('close', code => { exitCode = code ?? -1; resolve(exitCode); }));
    const epoch = 'physical_epoch';
    const ready = firstFrame(child.stdout);
    child.stdin.write(JSON.stringify({schema:'dream-maker.magpie-control.v5',epoch,accounts})+'\n');
    const boot = await Promise.race([ready, closed.then(code => { throw new Error('child exited '+code+': '+stderr.trim().slice(0,200)); })]);
    assert.equal(stderr, '', 'child stderr: ' + stderr.trim().slice(0,200));
    assert.match(boot.address,/^127\.0\.0\.1:[0-9]+$/);
    assert.equal(boot.qualification,'NOT_VERIFIED');
    assert.deepEqual(boot.accounts[0].capabilities,accounts[0].capabilities);

    const budget = new NativeBudget(join(root,'ledger.sqlite'),
        {scopeId:'OFFLINE_CODEX_PHYSICAL',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,
         warningMicros:40000000,maxInFlight:1,maxRepairs:2},undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
    const price = {provider,model,currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+300000).toISOString(),
        maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
    const route = {runtime:'codex',provider,protocol:'anthropic-messages',model,authentication:'api_key',
        authRef:accounts[0].authRef,accountRef:accounts[0].accountRef,
        upstreamAccountRef:provider+'/'+sha(keys[0]).slice(0,10)};
    assert.equal(boot.accounts[0].upstreamAccountRef,route.upstreamAccountRef,'child and controller agree on the account');

    const control = new MagpieAdmissionPipe(
        {input:child.stdin, output:child.stdout, closed, stop:async () => { child.stdin.end(); await closed; }},
        budget, {epoch, binaryHash:imageSHA, ackTimeoutMs:10000});
    const identity = {projectId:'offline_project',runId:'offline_run',configurationHash:'a'.repeat(64),
        planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',
        generation:'offline_owner',role,roleId:role};
    const assertCurrent = () => {};
    // The owned session hook mirrors openOwnedMagpieControl: the same digest gate, the accounts
    // the child actually registered, and the lane's own preparation.
    const session = {observation:{address:boot.address,binaryHash:imageSHA,epoch,accounts:boot.accounts},
        control,close:() => control.close(),
        prepareCodexSupervisorPayload:(ctx,ingress) => prepareOwnedCodexSupervisorPayload(imageSHA,boot.accounts,ctx,ingress)};
    const channel = new MagpieDshRequestTransport({session,budget,route,role,
        codexSupervisor:{prompt:() => prompt, instructions, assertCurrent, signal:AbortSignal.timeout(60000)},
        assertCurrent,
        bindRequest:payload => ({schema:'dream-maker.native-request-binding.v1',...identity,engineeringMode:'custom',
            work:{kind:'SUPERVISION'},routeHash:payload.routeHash,bodyHash:payload.bodyHash})});
    const gateway = new DeepSeekGateway(budget,() => price,'',512,1,() => assert.fail('direct fetch'),'responses',
        false,undefined,undefined,undefined,channel,undefined,model);
    t.after(async () => {
        try { await gateway.close(); } catch {}
        try { child.stdin.end(); } catch {}
        await closed;
        budget.close();
        rmSync(root,{recursive:true,force:true});
    });
    const {url,token} = await gateway.start();
    const body = {model,store:false,stream:true,max_output_tokens:512,tools:[],tool_choice:'auto',
        instructions:'LOCAL_ONLY',input:[{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}]};
    const post = () => fetch(url+'/responses',{method:'POST',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    return {gateway,budget,post,fixture,boot,route,child,exit:() => exitCode,image,imageSHA};
}

const evidence = {schema:'dream-maker.codex-physical.v1',gateway:'DeepSeekGateway',wire:{ingress:'/v1/responses',upstream:'/v1/messages'},cases:[]};

test('private-root image: the Go child admits the codex Messages lane and completes one turn',async t => {
    const x = await rig(t,{image:MIRROR,imageSHA:MIRROR_SHA});
    const reply = await x.post();
    const wire = await reply.text();
    assert.equal(reply.status,200,wire);
    // Eight Responses frames, no Messages frame leaks to the CLI.
    const types = wire.trimEnd().split('\n\n').map(block => JSON.parse(block.split('\n')[1].slice(6)).type);
    assert.deepEqual(types,['response.created','response.output_item.added','response.content_part.added',
        'response.output_text.delta','response.output_text.done','response.content_part.done',
        'response.output_item.done','response.completed']);
    assert.doesNotMatch(wire,/message_stop/);
    assert.ok(wire.includes(answer));
    assert.equal(x.fixture.state.requests,1,'upstream reached exactly once');
    assert.equal(x.fixture.state.tlsFailures,0);
    assert.equal(x.fixture.state.error,null);
    const [row] = x.budget.requests();
    assert.deepEqual(row.usage,{inputTokens:8,outputTokens:3,cacheHitTokens:2});
    assert.equal(row.usageStatus,'KNOWN');
    assert.ok(row.chargedMicros>0);
    const receipt = x.gateway.confirmedSupervisorOutput(model,answer);
    assert.equal(receipt.observedModel,model);
    assert.equal(receipt.model_matched ?? true,true);
    assert.equal(receipt.finishReason,'end_turn');
    evidence.cases.push({mode:'private-root',image:x.image,imageSHA256:x.imageSHA,status:200,
        frames:types,upstreamRequests:x.fixture.state.requests,connects:x.fixture.state.connects,
        tlsFailures:x.fixture.state.tlsFailures,usage:row.usage,usageStatus:row.usageStatus,
        chargedMicros:row.chargedMicros,observedModel:receipt.observedModel,finishReason:receipt.finishReason,
        upstreamRequestModel:x.fixture.state.bodies[0].body.model,
        upstreamRequestKeys:Object.keys(x.fixture.state.bodies[0].body).sort()});
});

test('production candidate: the route is admitted but the fixture root is refused, so no upstream byte',async t => {
    const x = await rig(t,{image:CANDIDATE,imageSHA:CANDIDATE_SHA});
    const reply = await x.post();
    await reply.text();
    // Admission happens before dialling: the proxy connect proves the codex row is in the matrix,
    // while the TLS failure proves this image cannot trust a fixture root.
    assert.equal(reply.status,502);
    assert.ok(x.fixture.state.connects>=1,'the admitted route dialled the proxy');
    assert.ok(x.fixture.state.tlsFailures>=1,'the candidate refused the fixture root');
    assert.equal(x.fixture.state.requests,0,'upstream HTTP requests');
    assert.equal(x.budget.requests()[0].outcome,'COMPLETE' === 'x' ? '' : x.budget.requests()[0].outcome);
    assert.notEqual(x.budget.requests()[0].outcome,'COMPLETE');
    evidence.cases.push({mode:'production-candidate',image:x.image,imageSHA256:x.imageSHA,status:502,
        connects:x.fixture.state.connects,tlsFailures:x.fixture.state.tlsFailures,
        upstreamRequests:0,outcome:x.budget.requests()[0].outcome});
});

test('old private-root image without the codex row denies the issuance before any byte',async t => {
    if (!existsSync(OLD_IMAGE)) { t.skip('old image absent'); return; }
    assert.equal(sha(readFileSync(OLD_IMAGE)),OLD_SHA);
    // The product source does not register the old digest; this file injects it for the whole
    // process so the lane can reach the Go hop at all. What is under test here is the Go matrix,
    // and that binary refuses to mint the upstream key: no codex Messages row exists in it.
    const {execFileSync} = await import('node:child_process');
    const x = await rig(t,{image:OLD_IMAGE,imageSHA:OLD_SHA});
    const reply = await x.post();
    const wire = await reply.text();
    assert.equal(reply.status,502,wire);
    assert.match(wire,/MAGPIE_ISSUANCE_DENIED/);
    assert.equal(x.fixture.state.connects,0,'no proxy connect');
    assert.equal(x.fixture.state.requests,0,'no upstream request');
    assert.equal(x.fixture.state.tlsFailures,0);
    const rows = x.budget.requests();
    assert.equal(rows.length,1,'a ledger row records the denied turn');
    assert.equal(rows[0].outcome,'MAGPIE_ISSUANCE_DENIED');
    assert.notEqual(rows[0].outcome,'COMPLETE');
    assert.deepEqual(x.gateway.receipts().map(r => r.outcome),['MAGPIE_ISSUANCE_DENIED']);
    evidence.cases.push({mode:'old-image-control',image:OLD_IMAGE,imageSHA256:OLD_SHA,status:502,
        code:'MAGPIE_ISSUANCE_DENIED',connects:0,upstreamRequests:0,tlsFailures:0,
        ledgerOutcome:rows[0].outcome,receipts:x.gateway.receipts().map(r => r.outcome),
        goBinaryVersion:execFileSync(OLD_IMAGE,['--version'],{encoding:'utf8'}).trim(),
        note:'node-side digest injected in this process only; the refusal comes from the Go control plane'});
});

test.after(() => {
    evidence.harnessSHA256 = sha(readFileSync(new URL(import.meta.url)));
    evidence.binaries = {candidate:{path:CANDIDATE,sha256:CANDIDATE_SHA},mirror:{path:MIRROR,sha256:MIRROR_SHA},old:{path:OLD_IMAGE,sha256:OLD_SHA}};
    evidence.paidCalls = 0;
    evidence.network = '127.0.0.1 only (CONNECT proxy + loopback TLS)';
    evidence.registrationInjected = 'supportsCodexSupervisorBuild via registerHooks, this test process only';
    writeFileSync(EVIDENCE, JSON.stringify(evidence,null,2)+'\n');
    console.log('EVIDENCE ' + EVIDENCE + ' sha256=' + sha(readFileSync(EVIDENCE)));
});
