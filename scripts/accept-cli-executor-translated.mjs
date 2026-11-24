#!/usr/bin/env node
// PRODUCT-LEVEL physical acceptance for the TRANSLATED CLI executor outlet.
//
//   node scripts/accept-cli-executor-translated.mjs --claude <claude.exe> --magpie <image.exe> \
//        [--opencode <opencode.exe>] [--codex <codex.exe>] [--out <json>]
//
// What this proves, and with what:
//   - the real installed CLI runs ONE executor turn through the real product path
//     (providers/claude-executor.ts | providers/cli-executor.ts -> DeepSeekGateway ->
//      MagpieDshRequestTransport -> flow/cli-executor-wire.ts -> the real Go Magpie child ->
//      a loopback TLS upstream fixture that speaks CHAT COMPLETIONS, not the CLI's own wire);
//   - the model's account declares ONLY `chat-completions`, so the route resolves the translated
//     outlet and the native leg is unreachable by construction;
//   - the turn spends one model request per tool round: the fixture answers the first with a
//     tool_calls chunk, the CLI executes it, and the second request replays the call with its
//     result — which the product built and the Go body check admitted;
//   - the answer the CLI finally reads is a Messages stream this product rebuilt from Chat deltas.
//
// Zero paid calls: the upstream is a loopback TLS stub reached through the CONNECT proxy the Go
// child requires, with a synthetic account key. Nothing outside 127.0.0.1 is dialled.
//
// The translated build sets are still empty in the product source; registration happens only after
// this evidence exists, so the harness injects the exercised image into those four sets for the
// lifetime of this process only (registerHooks, visible below).
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createServer as https} from 'node:https';
import {createServer as http} from 'node:http';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {registerHooks} from 'node:module';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf('--' + name); return i === -1 ? undefined : argv[i + 1]; };
const OUT = opt('out') ?? resolve('.runtime/accept-cli-executor-translated.json');
const GO_ROOT = opt('go-root') ?? 'F:/DreamMakerSuite/runtime/go1.26.8-windows-amd64/go';
const CANDIDATE = opt('magpie') && resolve(opt('magpie'));
// The private-root image of the same Go source trusts this fixture's test root; the production
// candidate does not. A real translated turn therefore runs on the mirror, and the candidate is
// only ever used to prove the same lane row is admitted (scripts/accept-claude-executor.mjs).
const MIRROR = opt('mirror') && resolve(opt('mirror'));
if (!CANDIDATE || !existsSync(CANDIDATE)) { console.error('usage: node scripts/accept-cli-executor-translated.mjs --magpie <candidate.exe> [--mirror <private-root.exe>] [--claude <exe>] [--opencode <exe>] [--codex <exe>] [--out <json>]'); process.exit(2); }
const sha = value => createHash('sha256').update(value).digest('hex');
const CANDIDATE_SHA = sha(readFileSync(CANDIDATE));
const IMAGE = MIRROR && existsSync(MIRROR) ? MIRROR : CANDIDATE;
const IMAGE_SHA = sha(readFileSync(IMAGE));

function commandTarget(command) {
    if (!command || !existsSync(command)) return undefined;
    if (command.toLowerCase().endsWith('.exe')) return command;
    const directory = dirname(resolve(command));
    for (const match of readFileSync(command, 'utf8').matchAll(/"?([^"\r\n]*?\.exe)"?/gi)) {
        const spelled = match[1].replace(/^~?%dp0%\\?/i, '');
        if (!spelled) continue;
        const candidate = isAbsolute(spelled) ? spelled : join(directory, spelled);
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}
function resolveCli(name, flag) {
    const hint = opt(flag) ?? process.env['CUSTOM_' + name.toUpperCase() + '_COMMAND'];
    if (hint) return commandTarget(hint);
    for (const directory of (process.env.PATH ?? '').split(';').filter(Boolean))
        for (const shim of [name + '.cmd', name + '.ps1', name + '.exe']) {
            const target = commandTarget(join(directory, shim));
            if (target) return target;
        }
    return undefined;
}

// Open the translated outlet for exactly this image, in this process only.
const routeUrl = new URL('../dist/server/magpie-route.js', import.meta.url).href;
const hook = registerHooks({load(url, context, next) {
    const result = next(url, context);
    if (url !== routeUrl) return result;
    let patched = Buffer.from(result.source).toString();
    const inject = 'if(binaryHash===' + JSON.stringify(IMAGE_SHA) + '||binaryHash===' + JSON.stringify(CANDIDATE_SHA) + ')return true;';
    for (const name of ['supportsClaudeExecutorTranslatedBuild','supportsOpencodeExecutorTranslatedBuild',
        'supportsClineExecutorTranslatedBuild','supportsCodexExecutorTranslatedBuild']) {
        const start = 'export function ' + name + '(binaryHash) {';
        if (patched.includes(start)) patched = patched.replace(start, start + inject);
    }
    return {...result, source: patched};
}});
const {DeepSeekGateway} = await import('../dist/server/deepseek-gateway.js');
const {MagpieDshRequestTransport} = await import('../dist/server/magpie-model-transport.js');
const {openOwnedMagpieControl} = await import('../dist/server/magpie-owned.js');
const {NativeBudget} = await import('../dist/server/native-budget.js');
const {own} = await import('../dist/server/process.js');
const {runClaudeExecutorTurn} = await import('../dist/server/providers/claude-executor.js');
const {runCliExecutorTurn} = await import('../dist/server/providers/cli-executor.js');
const {offlineCustomBudget,offlineCustomQualification} = await import('../tests/fixtures/custom-budget.mjs');
hook.deregister();

// Diagnostic: the exact CLI request that the lane refused, so a refusal names its own cause.
const refusedBodies = [];
const {MagpieDshRequestTransport:TransportForDiagnostics} = await import('../dist/server/magpie-model-transport.js');
const originalPrepareCli = TransportForDiagnostics.prototype.prepareCliExecutor;
TransportForDiagnostics.prototype.prepareCliExecutor = function (ingress, ...rest) {
    try { return originalPrepareCli.call(this, ingress, ...rest); }
    catch (error) {
        const first = refusedBodies.length === 0;
        refusedBodies.push({code:String(error?.code ?? error), keys:Object.keys(JSON.parse(ingress.body)), body:ingress.body.slice(0,4000)});
        // Every refusal is written whole so the lane can be reproduced offline, byte for byte
        // (the last one wins: it is the body closest to what the CLI finally gave up on).
        try { writeFileSync(resolve('.runtime/translated-refused-body-' + (first ? '1' : refusedBodies.length) + '.json'), ingress.body); } catch {}
        throw error;
    }
};
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

const host = 'fixture.example.com', provider = 'fixture', model = 'flash-executor-1';
const PROMPT = 'Write the file, then report.';
const ANSWER = 'TRANSLATED_TURN_COMPLETE';
const INSIDE = 'written-by-translated.txt';
// The id is per round: messagesSse derives the CLI's message_start id from it, so two rounds must
// carry two ids for the CLI's own response counter to agree with the ledger.
const chatFrame = (choices, extra = {}, id = 'chatcmpl-fixture-1') => 'data: ' + JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices,...extra}) + '\n\n';
const usage = () => ({prompt_tokens:12,completion_tokens:6,prompt_tokens_details:{cached_tokens:2},total_tokens:18});
/** First round: one Write call. The CLI executes it and replays the result in the next request. */
const toolReply = (toolName, args) => {
    const id = 'chatcmpl-fixture-round1';
    return [
        chatFrame([{index:0,delta:{role:'assistant',content:''},finish_reason:null}],{},id),
        chatFrame([{index:0,delta:{tool_calls:[{index:0,id:'call_translated_1',type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]},finish_reason:null}],{},id),
        chatFrame([{index:0,delta:{},finish_reason:'tool_calls'}],{usage:usage()},id),
        'data: [DONE]\n\n',
    ].join('');
};
const textReply = text => {
    const id = 'chatcmpl-fixture-round2';
    return [
        chatFrame([{index:0,delta:{role:'assistant',content:text},finish_reason:null}],{},id),
        chatFrame([{index:0,delta:{},finish_reason:'stop'}],{usage:usage()},id),
        'data: [DONE]\n\n',
    ].join('');
};

async function upstream(onReply) {
    const state = {connects:0, requests:0, tlsFailures:0, bodies:[], error:null};
    const tls = https({cert, key}, async (req, res) => {
        try {
            const bytes = [];
            for await (const chunk of req) bytes.push(chunk);
            const raw = Buffer.concat(bytes).toString('utf8');
            const body = JSON.parse(raw);
            state.requests += 1;
            state.bodies.push({raw, body, url:req.url});
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
    return {state, proxyUrl:'http://127.0.0.1:' + proxy.address().port, close: async () => {
        await new Promise(done => proxy.close(done));
        await new Promise(done => tls.close(done));
    }};
}

async function rig(tag, runtime) {
    const base = resolve('.runtime/test-temp');
    mkdirSync(base, {recursive:true});
    const root = mkdtempSync(join(base, 'translated-'+tag+'-'));
    const workspace = join(root,'workspace'), profile = join(root,'profile'), dataDir = join(root,'data');
    for (const dir of [workspace, profile, dataDir, join(profile,'AppData/Roaming'), join(profile,'AppData/Local'), join(dataDir,'cache'), join(dataDir,'state')]) mkdirSync(dir,{recursive:true});
    mkdirSync(join(root,'scripts','isolation'),{recursive:true});
    copyFileSync(resolve('scripts/isolation/windows-owned-job.cs'), join(root,'scripts','isolation','windows-owned-job.cs'));
    const staged = join(root,'dream-maker-magpie.exe');
    try { linkSync(IMAGE, staged); } catch { copyFileSync(IMAGE, staged); }
    const accountKey = 'DM_SYNTHETIC_' + randomBytes(20).toString('hex');
    // ONLY the Chat wire is declared: the CLI's own wire is absent, so the route can resolve nothing
    // but the translated outlet.
    const capabilities = [{model, protocol:'chat-completions', endpoint:'https://'+host+'/v1/chat/completions'}];
    const toolName = runtime === 'opencode' ? 'write' : runtime === 'codex' ? 'exec_command' : 'Write';
    const args = runtime === 'opencode'
        ? {filePath: join(workspace, INSIDE), content:'written by the translated turn\n'}
        : runtime === 'codex'
            ? {cmd:'echo TRANSLATED_TURN_COMPLETE'}
            : {file_path: join(workspace, INSIDE), content:'written by the translated turn\n'};
    const fixture = await upstream((body, turn) => turn === 1 ? toolReply(toolName, args) : textReply(ANSWER));
    const spawnEnv = {GODEBUG:'x509usefallbackroots=1'};
    const proxy = fixture.proxyUrl;
    const networkEnvironment = base => ({...base, HTTP_PROXY:proxy, http_proxy:proxy, HTTPS_PROXY:proxy, https_proxy:proxy, ALL_PROXY:proxy, all_proxy:proxy,
        NO_PROXY:'localhost,127.0.0.1,::1,[::1]', no_proxy:'localhost,127.0.0.1,::1,[::1]'});
    const budget = new NativeBudget(join(root,'ledger.sqlite'),
        {scopeId:'OFFLINE_TRANSLATED_EXECUTOR',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,
         warningMicros:40000000,maxInFlight:1,maxRepairs:2},undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
    const session = await openOwnedMagpieControl({root, binary:{path:IMAGE,sha256:IMAGE_SHA}, budget, timeoutMs:30000,
        bootstrapAccounts:[{provider, authRef:'AUTH_TRANSLATED', accountRef:'ACCOUNT_TRANSLATED', key:accountKey, capabilities}], networkEnvironment},
        (file, args, options) => own(file, args, {...options, env:{...options.env, ...spawnEnv}}));
    const route = {runtime, provider, protocol:'chat-completions', model, authentication:'api_key',
        authRef:'AUTH_TRANSLATED', accountRef:'ACCOUNT_TRANSLATED', upstreamAccountRef: provider+'/'+sha(accountKey).slice(0,10)};

    if (session.observation.accounts[0].upstreamAccountRef !== route.upstreamAccountRef) throw new Error('child and controller disagree on the account');
    const price = {provider,model,currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+300000).toISOString(),
        maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000};
    const identity = {projectId:'offline_project',runId:'offline_run',configurationHash:'a'.repeat(64),
        planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',generation:'offline_owner',role:'executor',roleId:'executor'};
    const channel = new MagpieDshRequestTransport({session, budget, route, role:'executor', assertCurrent:() => {},
        bindRequest: payload => ({schema:'dream-maker.native-request-binding.v1',...identity,engineeringMode:'custom',
            work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},routeHash:payload.routeHash,bodyHash:payload.bodyHash})});
    // The gateway serves the CLI's own ingress wire; the transport owns the upstream dialect.
    const gateway = new DeepSeekGateway(budget, () => price, '', 512, 16, () => { throw new Error('no direct fetch'); },
        runtime === 'codex' ? 'responses' : 'anthropic-messages', false, undefined, undefined, undefined, channel, undefined, model);
    const address = await gateway.start();
    return {root, workspace, fixture, session, route, budget, gateway, channel, address};
}

async function closeRig(x) {
    try { await x.gateway.close(); } catch {}
    try { await x.session.close(); } catch {}
    try { await x.fixture.close(); } catch {}
    x.budget.close?.();
    try { rmSync(x.root, {recursive:true, force:true}); } catch {}
}

const evidence = {schema:'dream-maker.cli-executor-translated-acceptance.v1',
    gate:'providers/cli-executor|claude-executor -> DeepSeekGateway -> MagpieDshRequestTransport -> flow/cli-executor-wire -> Go Magpie -> loopback TLS chat upstream',
    candidate:{path:CANDIDATE,sha256:CANDIDATE_SHA}, image:{path:IMAGE,sha256:IMAGE_SHA}, paidCalls:0, network:'127.0.0.1 only (CONNECT proxy + loopback TLS)', cases:[]};

const wanted = ['claude','opencode','codex'].filter(runtime => opt(runtime) !== undefined);
for (const runtime of (wanted.length ? wanted : ['claude','opencode','codex'])) {
    const command = resolveCli(runtime, runtime);
    if (!command) { evidence.cases.push({runtime, pass:false, skipped:'no installed ' + runtime + ' command found'}); console.log(runtime.toUpperCase() + ' skipped: no command'); continue; }
    const commandSha = sha(readFileSync(command));
    const outcome = {runtime, command:{path:command,sha256:commandSha}, imageSHA256:IMAGE_SHA};
    let x;
    try { x = await rig(runtime, runtime); }
    catch (error) {
        Object.assign(outcome, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,300),
            station:String(error?.stack ?? '').split('\n').slice(1,4).join(' | '),
            imageHashNow:sha(readFileSync(IMAGE))});
        evidence.cases.push(outcome); console.log(runtime.toUpperCase() + ' ' + JSON.stringify(outcome));
        continue;
    }
    try {
        const observation = runtime === 'claude'
            ? await runClaudeExecutorTurn({commandRef:{path:command,sha256:commandSha}, controllerRoot:x.root, workspace:x.workspace,
                gatewayUrl:x.address.url, gatewayToken:x.address.token, model, prompt:PROMPT,
                signal:AbortSignal.timeout(240000), timeoutMs:180000, maxOutputTokens:512, assertCurrent:() => {}})
            : await runCliExecutorTurn({runtime, commandRef:{path:command,sha256:commandSha}, controllerRoot:x.root, workspace:x.workspace,
                gatewayUrl:x.address.url, gatewayToken:x.address.token, model, prompt:PROMPT,
                signal:AbortSignal.timeout(240000), timeoutMs:180000, maxOutputTokens:512, assertCurrent:() => {}});
        const receipts = x.gateway.receipts(), rows = x.budget.requests(), bodies = x.fixture.state.bodies;
        const first = bodies[0]?.body ?? {};
        const declared = Array.isArray(first.tools) ? first.tools.map(tool => tool.function?.name ?? tool.name) : [];
        const checks = {
            // The upstream saw a CHAT body this product built, not the CLI's own wire.
            chatUpstreamBody: first.messages !== undefined && first.tool_calls === undefined && Array.isArray(first.messages),
            // The turn spent one request per tool round and every one of them is a complete row.
            twoRequests: observation.modelResponses === 2 && receipts.length === 2 && rows.length === 2,
            allComplete: receipts.every(row => row.outcome === 'COMPLETE') && rows.every(row => row.outcome === 'COMPLETE'),
            eachReserved: rows.every(row => Number.isSafeInteger(row.reservedMicros) && row.reservedMicros > 0),
            // The tools the CLI declared survived the translation.
            toolsVisible: declared.length > 0,
            // The call and its output came back through the product's own replay.
            callReplayed: bodies.length === 2 && JSON.stringify(bodies[1].body).includes('call_translated_1'),
            exitCodeZero: observation.exitCode === 0,
            textAnswer: observation.text.trim() === ANSWER,
            loopbackOnly: x.fixture.state.tlsFailures === 0 && x.fixture.state.error === null,
        };
        const verdict = Object.values(checks).every(value => value === true);
        Object.assign(outcome, {pass:verdict, checks, sessionId:observation.sessionId, text:observation.text,
            modelResponses:observation.modelResponses, toolUses:observation.toolUses, toolResults:observation.toolResults,
            deniedToolResults:observation.deniedToolResults, declaredTools:declared,
            fileChanges:observation.fileChanges, commandLine:observation.commandLine, cwd:observation.cwd,
            ledger:rows.map(row => ({outcome:row.outcome, reservedMicros:row.reservedMicros, chargedMicros:row.chargedMicros, usageStatus:row.usageStatus})),
            receipts:receipts.map(row => ({outcome:row.outcome, observedModel:row.observedModel, finishReason:row.finishReason,
                upstreamHttpStatus:row.upstreamHttpStatus, upstreamBodyCode:row.upstreamBodyCode, protocolFailureStage:row.protocolFailureStage})),
            physical:{connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures},
            upstreamFirstRequestKeys:Object.keys(first).sort()});
    } catch (error) {
        Object.assign(outcome, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,400),
            gatewayErrors:[...gatewayErrors], refusedBodies:[...refusedBodies],
            ledger:x.budget.requests().map(row => ({outcome:row.outcome, usageStatus:row.usageStatus})),
            receipts:x.gateway.receipts().map(row => ({outcome:row.outcome, upstreamHttpStatus:row.upstreamHttpStatus,
                upstreamBodyCode:row.upstreamBodyCode, protocolFailureStage:row.protocolFailureStage})),
            physical:{connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures},
            upstreamBodies:x.fixture.state.bodies.map(entry => ({url:entry.url, keys:Object.keys(entry.body).sort()}))});
    } finally { await closeRig(x); }
    evidence.cases.push(outcome);
    console.log(runtime.toUpperCase() + ' ' + JSON.stringify(outcome));
}

evidence.pass = evidence.cases.filter(item => !item.skipped).every(item => item.pass === true);
evidence.harnessSHA256 = sha(readFileSync(new URL(import.meta.url)));
mkdirSync(resolve(OUT, '..'), {recursive:true});
writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
console.log('EVIDENCE ' + OUT + ' sha256=' + sha(readFileSync(OUT)));
if (!evidence.pass) process.exitCode = 1;
