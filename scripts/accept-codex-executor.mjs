#!/usr/bin/env node
// PRODUCT-LEVEL physical acceptance for the Codex CLI executor leg.
//
//   node scripts/accept-codex-executor.mjs --codex <codex.exe> --mirror <private-root.exe> [--out <json>]
//
// What this proves, and with what:
//   - the real installed codex.exe runs ONE executor turn through the real product path:
//     providers/cli-executor.ts -> DeepSeekGateway -> MagpieDshRequestTransport -> the real Go
//     Magpie child (openai-responses body admission) -> a loopback TLS upstream fixture;
//   - the turn spends TWO model requests: the first is answered with a function_call, the second
//     replays that call and its output and is answered with the terminal text;
//   - each request has its own ledger row and its own reserve/settle pair;
//   - the CLI's own tools are visible in the request the Go child forwards upstream;
//   - the exit code is the CLI's real exit code.
//
// Zero paid calls: the upstream is a loopback TLS stub reached through the CONNECT proxy the Go
// child requires, with a synthetic account key. Nothing outside 127.0.0.1 is dialled.
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,linkSync} from 'node:fs';
import {createServer as https} from 'node:https';
import {createServer as http} from 'node:http';
import {join,resolve} from 'node:path';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf('--' + name); return i === -1 ? undefined : argv[i + 1]; };
for (const required of ['codex','mirror']) if (!opt(required) || !existsSync(opt(required))) {
    console.error('usage: node scripts/accept-codex-executor.mjs --codex <codex.exe> --mirror <private-root.exe> [--out <json>]');
    process.exit(2);
}
const CODEX = resolve(opt('codex')), MIRROR = resolve(opt('mirror'));
const OUT = opt('out') ?? resolve('.runtime/accept-codex-executor.json');
const GO_ROOT = opt('go-root') ?? 'F:/DreamMakerSuite/runtime/go1.26.8-windows-amd64/go';

const sha = value => createHash('sha256').update(value).digest('hex');
const CODEX_SHA = sha(readFileSync(CODEX)), MIRROR_SHA = sha(readFileSync(MIRROR));

// The lane's digest set is still empty in the product source; registration happens only after this
// evidence exists. The injection is confined to this process's module graph and is visible here.
const {registerHooks} = await import('node:module');
const routeUrl = new URL('../dist/server/magpie-route.js', import.meta.url).href;
const hook = registerHooks({load(url, context, next) {
    const result = next(url, context);
    if (url !== routeUrl) return result;
    let patched = Buffer.from(result.source).toString();
    const inject = 'if(binaryHash===' + JSON.stringify(MIRROR_SHA) + ')return true;';
    const start = 'export function supportsCodexExecutorBuild(binaryHash) {';
    if (patched.includes(start)) patched = patched.replace(start, start + inject);
    return {...result, source: patched};
}});

const {DeepSeekGateway} = await import('../dist/server/deepseek-gateway.js');
const {MagpieDshRequestTransport} = await import('../dist/server/magpie-model-transport.js');
const {openOwnedMagpieControl} = await import('../dist/server/magpie-owned.js');
const {NativeBudget} = await import('../dist/server/native-budget.js');
const {runCliExecutorTurn} = await import('../dist/server/providers/cli-executor.js');
const {own} = await import('../dist/server/process.js');
const {offlineCustomBudget,offlineCustomQualification} = await import('../tests/fixtures/custom-budget.mjs');
hook.deregister();

const gatewayErrors = [];
const sendError = DeepSeekGateway.prototype.error;
DeepSeekGateway.prototype.error = function (res, status, code, ...rest) {
    gatewayErrors.push({status, code});
    console.log('gateway', status, code);
    return sendError.call(this, res, status, code, ...rest);
};

const testcert = readFileSync(join(GO_ROOT,'src/net/http/internal/testcert/testcert.go'),'utf8');
const cert = testcert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
const key = testcert.match(/-----BEGIN RSA TESTING KEY-----[\s\S]*?-----END RSA TESTING KEY-----/)[0].replaceAll('TESTING KEY','PRIVATE KEY');

const host = 'fixture.example.com', provider = 'fixture', model = 'claude-sonnet-5';
const PROMPT = 'Run one command and report CODEX_EXECUTOR_DONE.';
const ANSWER = 'CODEX_EXECUTOR_DONE';
const CALL_ID = 'call_exec_1';

const frames = events => events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');

/** A Responses SSE answer that asks for one exec_command: the shape dmExecutorTranscript admits. */
function callReply(served) {
    const args = JSON.stringify({cmd:'echo CODEX_EXECUTOR_OK'});
    const item = {id:'fc_exec_1', type:'function_call', status:'completed', call_id:CALL_ID, name:'exec_command', arguments:args};
    return frames([
        {type:'response.created', response:{id:'resp_exec_1', object:'response', status:'in_progress', model:served, output:[], usage:null}},
        {type:'response.output_item.added', output_index:0, item:{id:'fc_exec_1', type:'function_call', status:'in_progress', call_id:CALL_ID, name:'exec_command', arguments:''}},
        {type:'response.function_call_arguments.delta', item_id:'fc_exec_1', output_index:0, delta:args},
        {type:'response.function_call_arguments.done', item_id:'fc_exec_1', output_index:0, arguments:args},
        {type:'response.output_item.done', output_index:0, item},
        {type:'response.completed', response:{id:'resp_exec_1', object:'response', status:'completed', model:served, output:[item],
            usage:{input_tokens:13, input_tokens_details:{cached_tokens:0}, output_tokens:9, output_tokens_details:{reasoning_tokens:0}, total_tokens:22}}},
    ]);
}

/** The terminal text answer, message-shaped exactly as the same validator requires. */
function textReply(served, text) {
    const item = {id:'msg_exec_2', type:'message', role:'assistant', status:'completed', content:[{type:'output_text', text, annotations:[]}]};
    return frames([
        {type:'response.created', response:{id:'resp_exec_2', object:'response', status:'in_progress', model:served, output:[], usage:null}},
        {type:'response.output_item.added', output_index:0, item:{id:'msg_exec_2', type:'message', role:'assistant', status:'in_progress', content:[]}},
        {type:'response.content_part.added', item_id:'msg_exec_2', output_index:0, content_index:0, part:{type:'output_text', text:'', annotations:[]}},
        {type:'response.output_text.delta', item_id:'msg_exec_2', output_index:0, content_index:0, delta:text},
        {type:'response.output_text.done', item_id:'msg_exec_2', output_index:0, content_index:0, text},
        {type:'response.content_part.done', item_id:'msg_exec_2', output_index:0, content_index:0, part:{type:'output_text', text, annotations:[]}},
        {type:'response.output_item.done', output_index:0, item},
        {type:'response.completed', response:{id:'resp_exec_2', object:'response', status:'completed', model:served, output:[item],
            usage:{input_tokens:41, input_tokens_details:{cached_tokens:0}, output_tokens:5, output_tokens_details:{reasoning_tokens:0}, total_tokens:46}}},
    ]);
}

async function upstream(onReply) {
    const state = {connects:0, requests:0, tlsFailures:0, bodies:[], error:null};
    const tls = https({cert, key}, async (req, res) => {
        try {
            const bytes = [];
            for await (const chunk of req) bytes.push(chunk);
            const raw = Buffer.concat(bytes).toString('utf8');
            const body = JSON.parse(raw);
            state.requests += 1;
            state.bodies.push({raw, body, headers:{...req.headers}, url:req.url});
            res.writeHead(200, {'content-type':'text/event-stream'});
            res.end(onReply(body, state.requests));
        } catch (error) { state.error ??= error; res.writeHead(500); res.end(); }
    });
    tls.on('tlsClientError', () => state.tlsFailures++);
    const proxy = http();
    proxy.on('connect', (req, socket, head) => {
        state.connects += 1;
        if (req.url !== host + ':443') { socket.destroy(); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.unshift(head);
        tls.emit('connection', socket);
    });
    await new Promise(done => proxy.listen(0,'127.0.0.1',done));
    return {state, proxyUrl:'http://127.0.0.1:'+proxy.address().port, close:async () => {
        await new Promise(done => proxy.close(done));
        await new Promise(done => tls.close(done));
    }};
}

async function rig(tag, {image, imageSHA}) {
    if (sha(readFileSync(image)) !== imageSHA) throw new Error(image + ' bytes changed');
    const base = resolve('.runtime/test-temp');
    mkdirSync(base, {recursive:true});
    const root = mkdtempSync(join(base, 'codex-executor-'+tag+'-'));
    const workspace = join(root,'workspace'), profile = join(root,'profile'), dataDir = join(root,'data');
    for (const dir of [workspace, profile, dataDir, join(profile,'AppData/Roaming'), join(profile,'AppData/Local'), join(dataDir,'cache'), join(dataDir,'state')]) mkdirSync(dir,{recursive:true});
    writeFileSync(join(workspace,'seed.txt'), 'seed\n');
    mkdirSync(join(root,'scripts','isolation'),{recursive:true});
    copyFileSync(resolve('scripts/isolation/windows-owned-job.cs'), join(root,'scripts','isolation','windows-owned-job.cs'));
    const staged = join(root,'dream-maker-magpie.exe');
    try { linkSync(image, staged); } catch { copyFileSync(image, staged); }
    if (sha(readFileSync(staged)) !== imageSHA) throw new Error('staged image bytes');
    const accountKey = 'DM_SYNTHETIC_' + randomBytes(20).toString('hex');
    const capabilities = [{model, protocol:'openai-responses', endpoint:'https://'+host+'/v1/responses'}];
    const fixture = await upstream((body, turn) => turn === 1 ? callReply(model) : textReply(model, ANSWER));
    const spawnEnv = {GODEBUG:'x509usefallbackroots=1'};
    const proxy = fixture.proxyUrl;
    const networkEnvironment = base => ({...base, HTTP_PROXY:proxy, http_proxy:proxy, HTTPS_PROXY:proxy, https_proxy:proxy, ALL_PROXY:proxy, all_proxy:proxy,
        NO_PROXY:'localhost,127.0.0.1,::1,[::1]', no_proxy:'localhost,127.0.0.1,::1,[::1]'});
    const budget = new NativeBudget(join(root,'ledger.sqlite'),
        {scopeId:'OFFLINE_CODEX_EXECUTOR',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,
         warningMicros:40000000,maxInFlight:1,maxRepairs:2},undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
    const session = await openOwnedMagpieControl({root, binary:{path:image,sha256:imageSHA}, budget, timeoutMs:30000,
        bootstrapAccounts:[{provider, authRef:'AUTH_CODEX', accountRef:'ACCOUNT_CODEX', key:accountKey, capabilities}], networkEnvironment},
        (file, args, options) => own(file, args, {...options, env:{...options.env, ...spawnEnv}}));
    const route = {runtime:'codex', provider, protocol:'openai-responses', model, authentication:'api_key',
        authRef:'AUTH_CODEX', accountRef:'ACCOUNT_CODEX', upstreamAccountRef: provider+'/'+sha(accountKey).slice(0,10)};
    if (session.observation.accounts[0].upstreamAccountRef !== route.upstreamAccountRef) throw new Error('child and controller disagree on the account');
    const price = {provider,model,currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+300000).toISOString(),
        maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
    const identity = {projectId:'offline_project',runId:'offline_run',configurationHash:'a'.repeat(64),
        planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',generation:'offline_owner',role:'executor',roleId:'executor'};
    const counters = {reserve:0,settle:0};
    for (const method of ['reserve','settle']) { const original = budget[method].bind(budget); budget[method] = (...args) => { const result = original(...args); counters[method] += 1; return result; }; }
    const channel = new MagpieDshRequestTransport({session, budget, route, role:'executor', assertCurrent:() => {},
        bindRequest: payload => ({schema:'dream-maker.native-request-binding.v1',...identity,engineeringMode:'custom',
            work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},routeHash:payload.routeHash,bodyHash:payload.bodyHash})});
    const gateway = new DeepSeekGateway(budget, () => price, '', 512, 16, () => { throw new Error('no direct fetch'); },
        'responses', false, undefined, undefined, undefined, channel, undefined, model);
    const address = await gateway.start();
    return {root, workspace, fixture, session, route, budget, counters, gateway, channel, address, image, imageSHA};
}

async function closeRig(x) {
    try { await x.gateway.close(); } catch {}
    try { await x.session.close(); } catch {}
    try { await x.fixture.close(); } catch {}
    x.budget.close?.();
    try { rmSync(x.root, {recursive:true, force:true}); } catch {}
}

// The production candidate cannot reach a fixture: it trusts only the real provider root, so the Go
// row is the only thing it can prove here. A body that is admitted and then fails TLS leaves the
// child with a non-zero upstream request count and zero forwarded bytes - which is the proof that
// the admission itself passed. This mode asserts exactly that, the way the Claude leg's candidate
// case does.
if (argv.includes('--candidate')) {
    const x = await rig('candidate', {image:MIRROR, imageSHA:MIRROR_SHA});
    const outcome = {mode:'production-candidate', image:x.image, imageSHA256:x.imageSHA};
    try {
        const observation = await runCliExecutorTurn({runtime:'codex', commandRef:{path:CODEX,sha256:CODEX_SHA},
            controllerRoot:x.root, workspace:x.workspace, gatewayUrl:x.address.url, gatewayToken:x.address.token, model,
            prompt:PROMPT, signal:AbortSignal.timeout(180000), timeoutMs:120000, maxOutputTokens:512, assertCurrent:() => {}})
            .catch(error => ({error:String(error?.code ?? error)}));
        const rows = x.budget.requests(), receipts = x.gateway.receipts();
        const denied = gatewayErrors.filter(entry => entry.status === 400 || entry.code === 'MAGPIE_MODEL_ADMISSION_DENIED' ||
            entry.code === 'MODEL_GATEWAY_MODEL_OR_LIMIT_DENIED' || entry.code === 'MAGPIE_PAYLOAD_INVALID');
        Object.assign(outcome, {pass: x.fixture.state.connects >= 1 && x.fixture.state.tlsFailures >= 1 && x.fixture.state.requests === 0 &&
            rows.length >= 1 && denied.length === 0, checks: {
                admitted: x.fixture.state.connects >= 1,
                tlsRefused: x.fixture.state.tlsFailures >= 1,
                noUpstreamByte: x.fixture.state.requests === 0,
                noAdmissionRefusal: denied.length === 0,
                reservationMade: rows.length >= 1,
                notComplete: rows.every(row => row.outcome !== 'COMPLETE'),
            }, observation: observation.error ?? {exitCode: observation.exitCode, modelResponses: observation.modelResponses},
            ledger: rows.map(row => ({outcome:row.outcome})), gatewayStatuses: gatewayErrors.slice(0, 4),
            physical:{connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures}});
    } catch (error) {
        Object.assign(outcome, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,300)});
    } finally { await closeRig(x); }
    mkdirSync(resolve(OUT,'..'),{recursive:true});
    writeFileSync(OUT, JSON.stringify({schema:'dream-maker.codex-executor-acceptance.v1', paidCalls:0, network:'127.0.0.1 only', codex:outcome}, null, 2) + String.fromCharCode(10));
    console.log('CODEX_CANDIDATE ' + JSON.stringify(outcome));
    process.exit(outcome.pass ? 0 : 1);
}

const x = await rig('mirror', {image:MIRROR, imageSHA:MIRROR_SHA});
const out = {runtime:'codex', image:x.image, imageSHA256:x.imageSHA, cli:{path:CODEX,sha256:CODEX_SHA}};
gatewayErrors.length = 0;
const attempts = [];
try {
    const originalPrepare = x.channel.prepare.bind(x.channel);
    x.channel.prepare = (raw) => {
        try { return originalPrepare(raw); }
        catch (error) { attempts.push({attempt: attempts.length + 1, body: raw, status: 'PREPARE', code: String(error?.code ?? error)}); throw error; }
    };
    let attempt = 0;
    const originalSend = x.channel.send.bind(x.channel);
    x.channel.send = async (prepared, reservationId, signal) => {
        attempts.push({attempt: ++attempt, bodyHash: prepared.binding.bodyHash, body: prepared.body});
        return originalSend(prepared, reservationId, signal);
    };
    const observation = await runCliExecutorTurn({runtime:'codex', commandRef:{path:CODEX,sha256:CODEX_SHA},
        controllerRoot:x.root, workspace:x.workspace, gatewayUrl:x.address.url, gatewayToken:x.address.token, model,
        prompt:PROMPT, signal:AbortSignal.timeout(240000), timeoutMs:180000, maxOutputTokens:512, assertCurrent:() => {}});
    const receipts = x.gateway.receipts(), rows = x.budget.requests(), bodies = x.fixture.state.bodies;
    const firstTools = bodies.length ? (bodies[0].body.tools ?? []).map(tool => tool.name) : [];
    const secondInput = bodies[1]?.body?.input ?? [];
    const replayCall = secondInput.find(item => item.type === 'function_call');
    const replayOutput = secondInput.find(item => item.type === 'function_call_output');
    const checks = {
        twoModelRequests: observation.modelResponses === 2 && receipts.length === 2 && rows.length === 2,
        allComplete: receipts.every(row => row.outcome === 'COMPLETE') && rows.every(row => row.outcome === 'COMPLETE'),
        reserveSettlePerRequest: x.counters.reserve === 2 && x.counters.settle === 2,
        eachReserved: rows.every(row => Number.isSafeInteger(row.reservedMicros) && row.reservedMicros > 0),
        eachCharged: rows.every(row => Number.isSafeInteger(row.chargedMicros) && row.chargedMicros > 0),
        upstreamTwoPosts: x.fixture.state.requests === 2,
        toolsVisible: firstTools.includes('exec_command'),
        toolCallObserved: observation.toolUses >= 1,
        callReplayedWithOutput: !!replayCall && !!replayOutput && replayCall.call_id === replayOutput.call_id,
        exitCodeZero: observation.exitCode === 0,
        textAnswer: observation.text.trim() === ANSWER,
        loopbackOnly: x.fixture.state.tlsFailures === 0 && x.fixture.state.error === null,
    };
    Object.assign(out, {pass: Object.values(checks).every(Boolean), checks, sessionId:observation.sessionId, text:observation.text,
        modelResponses:observation.modelResponses, toolUses:observation.toolUses, toolResults:observation.toolResults,
        deniedToolResults:observation.deniedToolResults, requestTools:firstTools,
        ledger: rows.map(row => ({outcome:row.outcome, reservedMicros:row.reservedMicros, chargedMicros:row.chargedMicros})),
        receipts: receipts.map(row => ({outcome:row.outcome, upstreamHttpStatus:row.upstreamHttpStatus, upstreamBodyCode:row.upstreamBodyCode, protocolFailureStage:row.protocolFailureStage})),
        firstRequestBodyKeys: bodies.length ? Object.keys(bodies[0].body).sort() : [],
        secondInputTypes: secondInput.map(item => item.type + (item.role ? ':' + item.role : '') + (item.name ? ':' + item.name : '')),
        commandLine: observation.commandLine, fileChanges: observation.fileChanges,
        physical:{connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures}});
} catch (error) {
    Object.assign(out, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,400),
        gatewayErrors:[...gatewayErrors], ledger:x.budget.requests().map(row => ({outcome:row.outcome})),
        refusedBody: attempts.at(-1)?.body ?? null,
        refusedBodyKeys: attempts.at(-1) ? Object.keys(JSON.parse(attempts.at(-1).body)) : [],
        receipts: x.gateway.receipts().map(row => ({outcome:row.outcome, upstreamHttpStatus:row.upstreamHttpStatus, protocolFailureStage:row.protocolFailureStage, transportErrorCode:row.transportErrorCode})),
        physical:{connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures}});
} finally { await closeRig(x); }
mkdirSync(resolve(OUT,'..'),{recursive:true});
writeFileSync(OUT, JSON.stringify({schema:'dream-maker.codex-executor-acceptance.v1', paidCalls:0, network:'127.0.0.1 only', codex:out}, null, 2) + '\n');
console.log('CODEX ' + JSON.stringify(out));
process.exit(out.pass ? 0 : 1);
