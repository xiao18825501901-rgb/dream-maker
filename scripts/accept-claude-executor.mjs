#!/usr/bin/env node
// PRODUCT-LEVEL physical acceptance for the Claude Code executor leg.
//
//   node scripts/accept-claude-executor.mjs --claude <claude.exe> --magpie <candidate.exe> --mirror <private-root.exe> [--out <json>]
//
// What this proves, and with what:
//   - the real installed claude.exe runs ONE executor turn through the real product path:
//     providers/claude-executor.ts -> DeepSeekGateway (purpose admission, many requests) ->
//     MagpieDshRequestTransport (digest gate, per-request binding, reservation) -> the real
//     Go Magpie child -> a loopback TLS upstream fixture;
//   - the turn spends TWO model requests (one per tool round), each with its own ledger row and
//     its own reserve/settle pair;
//   - the CLI's own tools are visible in the request body;
//   - a write one level above the workspace and a git push are both refused;
//   - the exit code is the CLI's real exit code.
//
// Zero paid calls: the upstream is a loopback TLS stub reached through the CONNECT proxy the Go
// child requires, with a synthetic account key. Nothing outside 127.0.0.1 is dialled.
//
// The successful turn runs on the private-root IMAGE of the same Go source (it is the only image
// that trusts the fixture's test root); the production candidate is exercised separately and must
// be admitted by the Go control plane and then fail TLS, which is what proves the lane row exists
// without letting the candidate talk to a fixture. The digests are read from the bytes on disk.
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createServer as https} from 'node:https';
import {createServer as http} from 'node:http';
import {spawn} from 'node:child_process';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {registerHooks} from 'node:module';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf('--' + name); return i === -1 ? undefined : argv[i + 1]; };
// THE COMMAND BINDING. The product verifies an executor command with
// verifiedClaudeCommand(), which requires an ABSOLUTE path ending in ".exe" whose bytes hash to
// the declared sha256 (providers/claude-supervisor.ts). A PATH shim such as npm's "claude.cmd"
// fails that check on the extension alone and the lane answers CUSTOM_CLAUDE_COMMAND_UNVERIFIED
// with zero requests — the shim is not the command the product runs. Resolve it here instead of
// making the caller remember:
//   --claude <path>     used as given (a real .exe, or the target the shim points at),
//   CUSTOM_CLAUDE_COMMAND  the operator's own binding, the same variable the product's
//                       native-owner config names for the Claude command,
//   no flag at all      the .cmd/.ps1 shim on PATH is read and its quoted target .exe taken.
// See docs/CLI_EXECUTOR_FEASIBILITY.md, "Binding the CLI command".
const CLAUDE_HINT = opt('claude') ?? process.env.CUSTOM_CLAUDE_COMMAND;
function commandTarget(command) {
    // An .exe is the command itself. A shim is text that names one; take the first absolute or
    // drive-relative token that ends in .exe and exists.
    if (command.toLowerCase().endsWith('.exe')) return existsSync(command) ? command : undefined;
    if (!existsSync(command)) return undefined;
    const directory = dirname(resolve(command));
    // A .cmd names its target through its own batch variables (%dp0%, %~dp0): expand those
    // against the shim's directory, then resolve the spelling from the same place.
    const DP0 = /^~?%dp0%\\?/i;
    for (const match of readFileSync(command, 'utf8').matchAll(/"?([^"\r\n]*?\.exe)"?/gi)) {
        const spelled = match[1].replace(DP0, '');
        if (!spelled) continue;
        const candidate = isAbsolute(spelled) ? spelled : join(directory, spelled);
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}
function resolveClaudeCommand() {
    if (CLAUDE_HINT && existsSync(CLAUDE_HINT)) {
        const target = commandTarget(CLAUDE_HINT);
        if (!target) { console.error('the command binding ' + CLAUDE_HINT + ' names no .exe'); process.exit(2); }
        return target;
    }
    for (const directory of (process.env.PATH ?? '').split(';').filter(Boolean))
        for (const name of ['claude.cmd', 'claude.ps1', 'claude.exe']) {
            const shim = join(directory, name);
            if (!existsSync(shim)) continue;
            const target = commandTarget(shim);
            if (target) return target;
        }
    return undefined;
}
for (const required of ['magpie','mirror']) if (!opt(required) || !existsSync(opt(required))) {
    console.error('usage: node scripts/accept-claude-executor.mjs [--claude <claude.exe>] --magpie <candidate.exe> --mirror <private-root.exe> [--out <json>]');
    process.exit(2);
}
const CLAUDE_RESOLVED = opt('claude') && opt('claude').toLowerCase().endsWith('.exe') ? opt('claude') : resolveClaudeCommand();
if (!CLAUDE_RESOLVED) {
    console.error('no Claude Code command found: pass --claude <claude.exe> or set CUSTOM_CLAUDE_COMMAND');
    process.exit(2);
}
const CLAUDE = resolve(CLAUDE_RESOLVED), CANDIDATE = resolve(opt('magpie')), MIRROR = resolve(opt('mirror'));
// Recorded in the evidence: which spelling the caller gave and which bytes the product actually ran.
const CLAUDE_BINDING = {requested: opt('claude') ?? process.env.CUSTOM_CLAUDE_COMMAND ?? '(PATH shim)', resolved: CLAUDE};
const OUT = opt('out') ?? resolve('.runtime/accept-claude-executor.json');
const GO_ROOT = opt('go-root') ?? 'F:/DreamMakerSuite/runtime/go1.26.8-windows-amd64/go';

const sha = value => createHash('sha256').update(value).digest('hex');
const CLAUDE_SHA = sha(readFileSync(CLAUDE)), CANDIDATE_SHA = sha(readFileSync(CANDIDATE)), MIRROR_SHA = sha(readFileSync(MIRROR));

// The lane's digest set is still empty in the product source; registration happens only after this
// evidence exists. The injection is confined to this process's module graph and is visible here.
const routeUrl = new URL('../dist/server/magpie-route.js', import.meta.url).href;
const hook = registerHooks({load(url, context, next) {
    const result = next(url, context);
    if (url !== routeUrl) return result;
    let patched = Buffer.from(result.source).toString();
    const inject = 'if(binaryHash===' + JSON.stringify(MIRROR_SHA) + '||binaryHash===' + JSON.stringify(CANDIDATE_SHA) + ')return true;';
    // Claude's lane is registered in the source after its own physical turn; the other three are
    // still closed, so the harness injects the same two images into whichever lane it exercises.
    // Cline's translated outlet is exercised on the same image and keeps its own set, so the
    // harness opens both of that leg's sets for these two images and no others.
    for (const name of ['supportsClaudeExecutorBuild','supportsOpencodeExecutorBuild','supportsClineExecutorBuild','supportsCodexExecutorBuild',
        'supportsClaudeExecutorTranslatedBuild','supportsOpencodeExecutorTranslatedBuild','supportsClineExecutorTranslatedBuild','supportsCodexExecutorTranslatedBuild']) {
        const start = 'export function ' + name + '(binaryHash) {';
        if (patched.includes(start)) patched = patched.replace(start, start + inject);
    }
    return {...result, source: patched};
}});
const {DeepSeekGateway} = await import('../dist/server/deepseek-gateway.js');
const {MagpieDshRequestTransport} = await import('../dist/server/magpie-model-transport.js');
const {openOwnedMagpieControl} = await import('../dist/server/magpie-owned.js');
const {NativeBudget} = await import('../dist/server/native-budget.js');
const {hash} = await import('../dist/server/security.js');
const {own} = await import('../dist/server/process.js');
const {runClaudeExecutorTurn} = await import('../dist/server/providers/claude-executor.js');
const {offlineCustomBudget,offlineCustomQualification} = await import('../tests/fixtures/custom-budget.mjs');
hook.deregister();
// Every refusal the gateway writes is evidence: without it a denied route looks like a hang.
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
const PROMPT = 'DreamFlow frozen executor packet: write the file, then report.';
const ANSWER = 'EXECUTOR_TURN_COMPLETE';
const INSIDE = 'written-by-executor.txt', OUTSIDE = 'escape-outside.txt';

const frames = events => events.map(e => 'event: '+e.type+'\n' + 'data: '+JSON.stringify(e)+'\n\n').join('');
const toolUseReply = (served, calls) => frames([
    {type:'message_start',message:{id:'msg_exec_1',type:'message',role:'assistant',model:served,content:[],stop_reason:null,stop_sequence:null,
        usage:{input_tokens:9,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0}}},
    ...calls.flatMap((call, index) => [
        {type:'content_block_start',index,content_block:{type:'tool_use',id:call.id,name:call.name,input:{}}},
        {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(call.input)}},
        {type:'content_block_stop',index},
    ]),
    {type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:12}},
    {type:'message_stop'},
]);
const textReply = (served, text) => frames([
    {type:'message_start',message:{id:'msg_exec_2',type:'message',role:'assistant',model:served,content:[],stop_reason:null,stop_sequence:null,
        usage:{input_tokens:21,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}},
    {type:'message_stop'},
]);

/** Loopback TLS upstream plus the CONNECT proxy the owned child dials. */
async function upstream(workspace, keyValue, onReply) {
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

/** A Responses SSE answer for the codex exec lane: completed item plus the turn's usage. */
function responsesReply(served, text) {
    return [
        {type:'response.created', seq:0, response:{id:'resp_exec_1', object:'response', status:'in_progress', model:served, output:[], usage:null}},
        {type:'response.output_item.added', seq:1, output_index:0, item:{id:'msg_exec_1', type:'message', role:'assistant', status:'in_progress', content:[]}},
        {type:'response.output_text.delta', seq:2, item_id:'msg_exec_1', output_index:0, content_index:0, delta:text},
        {type:'response.output_item.done', seq:3, output_index:0, item:{id:'msg_exec_1', type:'message', role:'assistant', status:'completed',
            content:[{type:'output_text', text, annotations:[]}]}},
        {type:'response.completed', seq:4, response:{id:'resp_exec_1', object:'response', status:'completed', model:served,
            output:[{id:'msg_exec_1', type:'message', role:'assistant', status:'completed', content:[{type:'output_text', text, annotations:[]}]}],
            usage:{input_tokens:5, input_tokens_details:{cached_tokens:0}, output_tokens:3, output_tokens_details:{reasoning_tokens:0}, total_tokens:8}}},
    ].map(event => 'event: ' + event.type + '\n' + 'data: ' + JSON.stringify(event) + '\n\n').join('');
}

function firstFrame(stream) {
    return new Promise((done, fail) => {
        let buffer = '';
        const onData = chunk => {
            buffer += chunk.toString('utf8');
            const end = buffer.indexOf('\n');
            if (end < 0) return;
            stream.off('data', onData);
            try { done(JSON.parse(buffer.slice(0, end))); } catch (error) { fail(error); }
        };
        stream.on('data', onData);
    });
}

async function rig(tag, {image, imageSHA, runtime='claude', reply, maxOutputTokens = 512}) {
    if (sha(readFileSync(image)) !== imageSHA) throw new Error(image + ' bytes changed');
    const base = resolve('.runtime/test-temp');
    mkdirSync(base, {recursive:true});
    const root = mkdtempSync(join(base, 'claude-executor-'+tag+'-'));
    const workspace = join(root,'workspace'), profile = join(root,'profile'), dataDir = join(root,'data');
    for (const dir of [workspace, profile, dataDir, join(profile,'AppData/Roaming'), join(profile,'AppData/Local'), join(dataDir,'cache'), join(dataDir,'state')]) mkdirSync(dir,{recursive:true});
    writeFileSync(join(workspace,'seed.txt'), 'seed\n');
    // The owned process owner compiles its Windows Job helper from inside the controller root.
    mkdirSync(join(root,'scripts','isolation'),{recursive:true});
    copyFileSync(resolve('scripts/isolation/windows-owned-job.cs'), join(root,'scripts','isolation','windows-owned-job.cs'));
    const staged = join(root,'dream-maker-magpie.exe');
    try { linkSync(image, staged); } catch { copyFileSync(image, staged); }
    if (sha(readFileSync(staged)) !== imageSHA) throw new Error('staged image bytes');
    const accountKey = 'DM_SYNTHETIC_' + randomBytes(20).toString('hex');
    const capabilities = runtime === 'codex'
        ? [{model, protocol:'openai-responses', endpoint:'https://'+host+'/v1/responses'}]
        : [{model, protocol:'anthropic-messages', endpoint:'https://'+host+'/v1/messages'}];
    const fixture = await upstream(workspace, accountKey, (body, turn) => {
        if (reply) return reply(model, turn, {workspace, root, INSIDE, OUTSIDE});
        if (turn === 1) return toolUseReply(model, [
            {id:'toolu_write_inside', name:'Write', input:{file_path: join(workspace, INSIDE), content:'written by the executor turn\n'}},
            {id:'toolu_write_outside', name:'Write', input:{file_path: join(root, OUTSIDE), content:'must not exist\n'}},
            {id:'toolu_push', name:'Bash', input:{command:'git push origin main', description:'push'}},
        ]);
        return textReply(model, ANSWER);
    });
    const spawnEnv = {GODEBUG:'x509usefallbackroots=1'};
    const proxy = fixture.proxyUrl;
    const networkEnvironment = base => ({...base, HTTP_PROXY:proxy, http_proxy:proxy, HTTPS_PROXY:proxy, https_proxy:proxy, ALL_PROXY:proxy, all_proxy:proxy,
        NO_PROXY:'localhost,127.0.0.1,::1,[::1]', no_proxy:'localhost,127.0.0.1,::1,[::1]'});
    const budget = new NativeBudget(join(root,'ledger.sqlite'),
        {scopeId:'OFFLINE_CLAUDE_EXECUTOR',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,
         warningMicros:40000000,maxInFlight:1,maxRepairs:2},undefined,undefined,'FULL_DM',offlineCustomBudget,offlineCustomQualification);
    const session = await openOwnedMagpieControl({root, binary:{path:image,sha256:imageSHA}, budget, timeoutMs:30000,
        bootstrapAccounts:[{provider, authRef:'AUTH_CLAUDE', accountRef:'ACCOUNT_CLAUDE', key:accountKey, capabilities}], networkEnvironment},
        (file, args, options) => own(file, args, {...options, env:{...options.env, ...spawnEnv}}));
    const route = {runtime, provider, protocol: runtime === 'codex' ? 'openai-responses' : 'anthropic-messages', model, authentication:'api_key',
        authRef:'AUTH_CLAUDE', accountRef:'ACCOUNT_CLAUDE', upstreamAccountRef: provider+'/'+sha(accountKey).slice(0,10)};
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
    const gateway = new DeepSeekGateway(budget, () => price, '', maxOutputTokens, 16, () => { throw new Error('no direct fetch'); },
        runtime === 'codex' ? 'responses' : 'anthropic-messages', false, undefined, undefined, undefined, channel, undefined, model);
    const address = await gateway.start();
    return {root, workspace, fixture, session, route, budget, counters, gateway, channel, address, image, imageSHA};
}

// Diagnostic mode: feed a captured request body straight to the owned session's body validator,
// which is the exact gate the Gateway uses. Used to explain a MAGPIE_PAYLOAD_INVALID refusal.
if (opt('explain')) {
    const body = readFileSync(opt('explain'), 'utf8');
    const x = await rig('explain', {image:MIRROR, imageSHA:MIRROR_SHA});
    try {
        const payload = x.session.prepareModelPayload(x.route, body, undefined, 'executor', undefined);
        console.log('EXPLAIN OK keys=' + JSON.stringify(Object.keys(JSON.parse(payload.body)).sort()) + ' bytes=' + Buffer.byteLength(payload.body));
    } catch (error) {
        console.log('EXPLAIN ' + String(error?.code ?? error) + ' ' + String(error?.message ?? '').slice(0,200));
    } finally { await closeRig(x); }
    process.exit(0);
}

// Diagnostic mode: one prepared payload straight through the real transport into the real Go
// child, so a refusal is reported with the child's own status code and body.
if (opt('probe')) {
    const body = readFileSync(opt('probe'), 'utf8');
    const x = await rig('probe', {image:MIRROR, imageSHA:MIRROR_SHA, runtime: opt('runtime') ?? 'claude'});
    try {
        const prepared = x.channel.prepare(body);
        const reservation = x.budget.reserve('executor',
            {provider,model,currency:'CNY',source:'OFFLINE_PRICE',expiresAt:new Date(Date.now()+300000).toISOString(),
             maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000},
            512, undefined, prepared.binding);
        const response = await x.channel.send(prepared, reservation.id, AbortSignal.timeout(60000));
        const text = await response.text();
        console.log('PROBE status=' + response.status + ' body=' + text.slice(0,400));
        console.log('PROBE physical=' + JSON.stringify(x.fixture.state));
        x.budget.settle(reservation.id, null, 'PROBE');
    } catch (error) {
        console.log('PROBE ' + String(error?.code ?? error) + ' ' + String(error?.message ?? '').slice(0,300));
    } finally { await closeRig(x); }
    process.exit(0);
}

// Cline: the same product path as the other legs, with the two things this leg has instead of a
// per-command deny list. Cline always offers its 25 built-in tools and cannot deny one command, so
// the product watches the CLI's own --json stream while the turn runs (an installer stops the turn)
// and compares the workspace's git refs afterwards (a moved ref refuses the turn). All three cases
// are measured here against the real cline.exe, on a loopback fixture, with zero paid calls.
if (opt('cline')) {
    const CLINE = resolve(opt('cline'));
    const CLINE_SHA = sha(readFileSync(CLINE));
    const {runCliExecutorTurn} = await import('../dist/server/providers/cli-executor.js');
    const ANSWER_TEXT = 'CLINE_TURN_COMPLETE';
    // Cline 3.0.74 refuses a prompt argument with no space in it ("Unknown command or unquoted
    // prompt"), measured on the installed binary, so every prompt here is a sentence.
    const PROMPT = 'Write the file, then answer CLINE_TURN_COMPLETE.';
    const INSIDE = 'written-by-cline.txt';
    const commandReply = (served, command) => toolUseReply(served, [{id:'toolu_cline_1', name:'run_commands', input:{command}}]);
    // Measured on 3.0.74: the CLI sends max_tokens:4096 of its own and ignores the provider
    // setting, so a Cline turn needs a run ceiling at least that wide. Both sides state the same
    // number here rather than letting the gateway deny the turn's own request.
    const CLINE_MAX_TOKENS = 4096;
    const turnArgs = x => ({runtime:'cline', commandRef:{path:CLINE, sha256:CLINE_SHA}, controllerRoot:x.root, workspace:x.workspace,
        gatewayUrl:x.address.url, gatewayToken:x.address.token, model, prompt:PROMPT,
        signal:AbortSignal.timeout(180000), timeoutMs:120000, maxOutputTokens:CLINE_MAX_TOKENS, assertCurrent:() => {}});
    const evidence = {schema:'dream-maker.cline-executor-acceptance.v1', paidCalls:0, network:'127.0.0.1 only (CONNECT proxy + loopback TLS)',
        cli:{path:CLINE, sha256:CLINE_SHA}, candidate:{path:CANDIDATE, sha256:CANDIDATE_SHA}, mirror:{path:MIRROR, sha256:MIRROR_SHA}, cases:[]};
    let observedBody;

    // 1) The turn: one tool round that writes a file in the workspace, then a text answer.
    {
        const x = await rig('cline-turn', {image:MIRROR, imageSHA:MIRROR_SHA, runtime:'cline', maxOutputTokens:CLINE_MAX_TOKENS,
            reply:(served, turn) => turn === 1 ? commandReply(served, 'echo written-by-cline > ' + INSIDE) : textReply(served, ANSWER_TEXT)});
        const outcome = {case:'turn'};
        gatewayErrors.length = 0;
        try {
            const observation = await runCliExecutorTurn(turnArgs(x));
            const receipts = x.gateway.receipts(), rows = x.budget.requests();
            const audit = observation.audit;
            observedBody = x.fixture.state.bodies[0]?.body;
            const insidePath = join(x.workspace, INSIDE);
            const insideBytes = existsSync(insidePath) ? readFileSync(insidePath) : Buffer.alloc(0);
            const checks = {
                // the record is the process record and says so inside itself
                auditSchema:audit.schema === 'dream-maker.cli-executor-audit.v1',
                noPerCallApproval:audit.perCallApproval === false,
                auditKeys:Object.keys(audit).sort().join(',') === ['commandLine','cwd','diffSummary','exitCode','fileChanges','git','modelResponses','perCallApproval','runtime','schema','toolCalls'].join(','),
                argvAndCwd:audit.commandLine[0] === CLINE && audit.commandLine.includes('--json') && audit.cwd === resolve(x.workspace),
                exitCodeZero:audit.exitCode === 0 && observation.exitCode === 0,
                // the CLI's own tool counts: names and integers, nothing per call
                toolCounted:audit.toolCalls.total >= 1 && Number.isSafeInteger(audit.toolCalls.byTool.run_commands) && audit.toolCalls.byTool.run_commands >= 1,
                // the workspace diff, and its summary, are the only account of which files changed
                fileListed:audit.fileChanges.some(row => row.path === INSIDE && /^[a-f0-9]{64}$/.test(row.sha256)),
                diffSummarised:audit.diffSummary.added >= 1 && audit.diffSummary.deleted === 0,
                // Windows PowerShell 5.1 writes redirection output as UTF-16LE, so the bytes are
                // decoded by their own shape rather than assumed to be UTF-8.
                insideWritten:existsSync(insidePath) && [insideBytes.toString('utf8'), insideBytes.toString('utf16le')].some(text => text.includes('written-by-cline')),
                // nothing moved in git, and the record says it looked
                gitQuiet:audit.git.changed.length === 0,
                twoRequestsTwoRows:observation.modelResponses === 2 && receipts.length === 2 && rows.length === 2 && rows.every(row => row.outcome === 'COMPLETE'),
                textAnswer:observation.text.trim() === ANSWER_TEXT,
                loopbackOnly:x.fixture.state.tlsFailures === 0 && x.fixture.state.error === null,
            };
            const verdict = Object.values(checks).every(Boolean);
            Object.assign(outcome, {pass:verdict, checks, audit, sessionId:observation.sessionId, text:observation.text,
                requestToolNames:(observedBody?.tools ?? []).map(tool => tool.name), requestToolCount:(observedBody?.tools ?? []).length,
                ledger:rows.map(row => ({outcome:row.outcome, reservedMicros:row.reservedMicros, chargedMicros:row.chargedMicros})),
                physical:{connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures}});
        } catch (error) {
            Object.assign(outcome, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,400), gatewayErrors:[...gatewayErrors]});
        } finally { await closeRig(x); }
        evidence.cases.push(outcome);
        console.log('CASE ' + JSON.stringify({case:outcome.case, pass:outcome.pass, error:outcome.error, checks:outcome.checks}));
    }

    // 2) The installer negative: the model asks for npm install, and the turn must be refused
    //    before that child could run, with the command named in the refusal.
    {
        const x = await rig('cline-install', {image:MIRROR, imageSHA:MIRROR_SHA, runtime:'cline', maxOutputTokens:CLINE_MAX_TOKENS,
            reply:(served, turn) => turn === 1 ? commandReply(served, 'npm install left-pad') : textReply(served, ANSWER_TEXT)});
        const outcome = {case:'install-refused'};
        try {
            const observation = await runCliExecutorTurn(turnArgs(x));
            Object.assign(outcome, {pass:false, unexpected:'the turn completed', text:observation.text});
        } catch (error) {
            const code = String(error?.code ?? error), message = String(error?.message ?? '');
            Object.assign(outcome, {error:code, message:message.slice(0,300), exitCode:error?.exitCode ?? null,
                pass: code === 'CLI_EXECUTOR_INSTALL_REFUSED' && message.includes('npm install left-pad'),
                upstreamRequests:x.fixture.state.requests});
        } finally { await closeRig(x); }
        evidence.cases.push(outcome);
        console.log('CASE ' + JSON.stringify({case:outcome.case, pass:outcome.pass, error:outcome.error}));
    }

    // 3) The production candidate admits the lane and then refuses TLS: the body a real cline turn
    //    sent is replayed byte for byte, so what is being admitted is the shape this leg produces.
    {
        const x = await rig('cline-candidate', {image:CANDIDATE, imageSHA:CANDIDATE_SHA, runtime:'cline'});
        const outcome = {case:'production-candidate'};
        try {
            const reply = await fetch(x.address.url + '/messages?beta=true', {method:'POST',
                headers:{'x-api-key':x.address.token, 'content-type':'application/json', 'anthropic-version':'2023-06-01'},
                body:JSON.stringify(observedBody)});
            const text = await reply.text();
            const rows = x.budget.requests(), receipts = x.gateway.receipts();
            Object.assign(outcome, {status:reply.status, body:text.slice(0,200), connects:x.fixture.state.connects,
                tlsFailures:x.fixture.state.tlsFailures, upstreamRequests:x.fixture.state.requests,
                ledger:rows.map(row => ({outcome:row.outcome, usageStatus:row.usageStatus, transportErrorCode:row.transportErrorCode})),
                receipts:receipts.map(row => ({outcome:row.outcome, transportErrorCode:row.transportErrorCode})),
                pass: reply.status === 502 && x.fixture.state.connects >= 1 && x.fixture.state.tlsFailures >= 1 && x.fixture.state.requests === 0});
        } catch (error) {
            Object.assign(outcome, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,400)});
        } finally { await closeRig(x); }
        evidence.cases.push(outcome);
        console.log('CASE ' + JSON.stringify({case:outcome.case, pass:outcome.pass, status:outcome.status, error:outcome.error}));
    }

    evidence.pass = evidence.cases.every(item => item.pass === true);
    evidence.harnessSHA256 = sha(readFileSync(new URL(import.meta.url)));
    mkdirSync(resolve(OUT, '..'), {recursive:true});
    writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
    console.log('EVIDENCE ' + OUT + ' sha256=' + sha(readFileSync(OUT)));
    process.exit(evidence.pass ? 0 : 1);
}

// A minimal product-level round trip for one of the other CLI executor legs: their digest sets are
// still closed, so this is evidence for the lane, not a registration.
if (opt('opencode') || opt('codex')) {
    const CLI_RUNTIME = opt('codex') ? 'codex' : 'opencode';
    const OPENCODE = resolve(opt(CLI_RUNTIME));
    const OPENCODE_SHA = sha(readFileSync(OPENCODE));
    const {runCliExecutorTurn} = await import('../dist/server/providers/cli-executor.js');
    const {DeepSeekGateway : Gateway} = await import('../dist/server/deepseek-gateway.js');
    const ANSWER_TEXT = 'OPENCODE_TURN_COMPLETE';
    // The refusal's own bytes: which request the Go child answered and with what body.
    const attempts = [];
    const originalError = Gateway.prototype.error;
    Gateway.prototype.error = function (res, status, code, ...rest) {
        const attempt = attempts[attempts.length - 1];
        if (attempt && attempt.status === undefined) attempt.status = status, attempt.code = code;
        return originalError.call(this, res, status, code, ...rest);
    };
    // Both legs run on the Messages wire here; a codex turn needs the Responses fixture below.
    if (CLI_RUNTIME === 'codex') {
        const gate = await import(routeUrl);
        console.log('GATE codex=' + gate.supportsCodexExecutorBuild(MIRROR_SHA) + ' opencode=' + gate.supportsOpencodeExecutorBuild(MIRROR_SHA) + ' claude=' + gate.supportsClaudeExecutorBuild(MIRROR_SHA));
    }
    // A single text round proves the wire; --tool-round exercises the round trip the executor leg
    // exists for: the model asks for one of the CLI's own tools, the CLI runs it, and the replayed
    // call with its output is answered with the text that closes the turn.
    const twoRounds = opt('tool-round') !== undefined;
    if (twoRounds && CLI_RUNTIME === 'codex') {
        console.error('codex two-round acceptance lives in scripts/accept-codex-executor.mjs --codex <exe> --mirror <private-root.exe>');
        process.exit(2);
    }
    const x = await rig(CLI_RUNTIME, {image:MIRROR, imageSHA:MIRROR_SHA, runtime:CLI_RUNTIME,
        reply:(served, turn, ctx) => {
            const text = () => CLI_RUNTIME === 'codex' ? responsesReply(served, ANSWER_TEXT) : textReply(served, ANSWER_TEXT);
            if (!twoRounds || turn > 1) return text();
            const written = join(ctx.workspace, 'native-written.txt');
            return toolUseReply(served, [CLI_RUNTIME === 'opencode'
                ? {id:'toolu_native_1', name:'write', input:{filePath:written, content:'written by the native turn\n'}}
                : {id:'toolu_native_1', name:'Write', input:{file_path:written, content:'written by the native turn\n'}}]);
        }});
    const out = {runtime:CLI_RUNTIME, image:x.image, imageSHA256:x.imageSHA, cli:{path:OPENCODE,sha256:OPENCODE_SHA}};
    try {
        let attempt = 0;
        // A refusal can happen in prepare() before any send, so record the outbound body there too.
        const originalPrepare = x.channel.prepare.bind(x.channel);
        x.channel.prepare = (raw) => {
            try { return originalPrepare(raw); }
            catch (error) { attempts.push({attempt: attempts.length + 1, body: raw, status: 'PREPARE', code: String(error?.code ?? error)}); throw error; }
        };
        const original = x.channel.send.bind(x.channel);
        // Record the exact outbound body of each attempt (secret-free: the model, the tools and the
        // client metadata are what the Go row judges) before handing it to the child.
        x.channel.send = async (prepared, reservationId, signal) => {
            attempts.push({attempt: ++attempt, bodyHash: prepared.binding.bodyHash, body: prepared.body, status: undefined, code: undefined});
            return original(prepared, reservationId, signal);
        };
        const observation = await runCliExecutorTurn({runtime:CLI_RUNTIME, commandRef:{path:OPENCODE,sha256:OPENCODE_SHA},
            controllerRoot:x.root, workspace:x.workspace, gatewayUrl:x.address.url, gatewayToken:x.address.token, model,
            prompt:'Answer with OPENCODE_TURN_COMPLETE and nothing else.', signal:AbortSignal.timeout(180000), timeoutMs:120000,
            maxOutputTokens:512, assertCurrent:() => {}});
        const receipts = x.gateway.receipts(), rows = x.budget.requests();
        const bodies = x.fixture.state.bodies;
        Object.assign(out, {text:observation.text, modelResponses:observation.modelResponses, exitCode:observation.exitCode,
            requests:receipts.length, ledger:rows.map(row => ({outcome:row.outcome, reservedMicros:row.reservedMicros, chargedMicros:row.chargedMicros})),
            upstreamRequests:x.fixture.state.requests, offeredTools: bodies.length ? (bodies[0].body.tools ?? []).map(tool => tool.name) : [],
            toolUses:observation.toolUses, fileChanges:observation.fileChanges, commandLine:observation.commandLine, cwd:observation.cwd,
            pass: twoRounds
                ? observation.modelResponses === 2 && receipts.length === 2 && rows.length === 2 &&
                  receipts.every(row => row.outcome === 'COMPLETE') && rows.every(row => row.outcome === 'COMPLETE') &&
                  rows.every(row => Number.isSafeInteger(row.reservedMicros) && row.reservedMicros > 0) &&
                  observation.exitCode === 0 && observation.text.trim() === ANSWER_TEXT && x.fixture.state.requests === 2 &&
                  observation.toolUses >= 1 && observation.toolResults >= 1 &&
                  bodies.length === 2 && JSON.stringify(bodies[1].body).includes('toolu_native_1')
                : observation.modelResponses === 1 && receipts.length === 1 && rows.length === 1 && receipts[0].outcome === 'COMPLETE' &&
                  observation.exitCode === 0 && observation.text.trim() === ANSWER_TEXT && x.fixture.state.requests === 1});
    } catch (error) {
        Object.assign(out, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,300),
            gatewayErrors:[...gatewayErrors], ledger:x.budget.requests().map(row => ({outcome:row.outcome})),
            // The last attempt is the one that was refused; its body is the evidence the Go owner needs.
            refusedBody: attempts.at(-1)?.body ?? null, refusedBodyKeys: attempts.at(-1) ? Object.keys(JSON.parse(attempts.at(-1).body)) : [],
            refusedStatus: attempts.at(-1)?.status ?? null, refusedCode: attempts.at(-1)?.code ?? null,
            childAnswers: attempts.map(item => ({attempt:item.attempt, bodyHash:item.bodyHash, status:item.status ?? null, code:item.code ?? null,
                upstreamHttpStatus:x.gateway.receipts()[item.attempt-1]?.upstreamHttpStatus ?? null,
                upstreamBodyCode:x.gateway.receipts()[item.attempt-1]?.upstreamBodyCode ?? null}))});
    } finally { await closeRig(x); }
    console.log(CLI_RUNTIME.toUpperCase() + ' ' + JSON.stringify(out));
    writeFileSync(OUT, JSON.stringify({schema:'dream-maker.cli-executor-acceptance.v1', paidCalls:0, network:'127.0.0.1 only', [CLI_RUNTIME]:out}, null, 2) + '\n');
    process.exit(out.pass ? 0 : 1);
}

const evidence = {schema:'dream-maker.claude-executor-acceptance.v1', gate:'providers/claude-executor.ts -> DeepSeekGateway -> MagpieDshRequestTransport -> Go Magpie',
    claude:{path:CLAUDE,sha256:CLAUDE_SHA}, commandBinding:CLAUDE_BINDING,
    candidate:{path:CANDIDATE,sha256:CANDIDATE_SHA}, mirror:{path:MIRROR,sha256:MIRROR_SHA},
    paidCalls:0, network:'127.0.0.1 only (CONNECT proxy + loopback TLS)', cases:[]};

async function closeRig(x) {
    try { await x.gateway.close(); } catch {}
    try { await x.session.close(); } catch {}
    try { await x.fixture.close(); } catch {}
    x.budget.close?.();
    try { rmSync(x.root, {recursive:true, force:true}); } catch {}
}

/** The full turn: the real CLI, two model requests, its own tools, its own refusals. */
{
    const x = await rig('mirror', {image:MIRROR, imageSHA:MIRROR_SHA});
    const outcome = {mode:'private-root', image:x.image, imageSHA256:x.imageSHA};
    gatewayErrors.length = 0;
    try {
        const observation = await runClaudeExecutorTurn({commandRef:{path:CLAUDE,sha256:CLAUDE_SHA}, controllerRoot:x.root, workspace:x.workspace,
            gatewayUrl:x.address.url, gatewayToken:x.address.token, model, prompt:PROMPT, signal:AbortSignal.timeout(240000), timeoutMs:180000,
            maxOutputTokens:512, assertCurrent:() => {}});
        const receipts = x.gateway.receipts(), rows = x.budget.requests();
        const bodies = x.fixture.state.bodies;
        const tools = bodies[0].body.tools.map(tool => tool.name).sort();
        const secondHistory = JSON.stringify(bodies[1].body.messages ?? []);
        const outside = existsSync(join(x.root, OUTSIDE));
        const insidePath = join(x.workspace, INSIDE);
        const checks = {
            // two model requests, one per tool round, each with its own ledger row and settlement
            modelResponses: observation.modelResponses,
            assistantFrames: observation.assistantTurns,
            twoRequests: observation.modelResponses === 2 && receipts.length === 2 && rows.length === 2,
            allComplete: receipts.every(row => row.outcome === 'COMPLETE') && rows.every(row => row.outcome === 'COMPLETE'),
            reserveSettlePerRequest: x.counters.reserve === 2 && x.counters.settle === 2,
            eachReserved: rows.every(row => Number.isSafeInteger(row.reservedMicros) && row.reservedMicros > 0),
            eachCharged: rows.every(row => Number.isSafeInteger(row.chargedMicros) && row.chargedMicros > 0),
            // the CLI's own tools are visible in the request the Go child forwards upstream
            toolsVisible: tools.join(',') === 'Bash,Edit,Read,Write',
            toolHistoryOnSecondRequest: secondHistory.includes('tool_result') && secondHistory.includes('toolu_write_inside'),
            // the workspace fence held: inside written, outside refused, push refused
            insideWritten: existsSync(insidePath) && readFileSync(insidePath,'utf8').includes('written by the executor turn'),
            outsideRefused: !outside,
            pushRefused: observation.deniedToolResults >= 2,
            fileChangesRecorded: observation.fileChanges.some(row => row.path === INSIDE && /^[a-f0-9]{64}$/.test(row.sha256)),
            // the exit code is the CLI's own
            exitCodeZero: observation.exitCode === 0,
            textAnswer: observation.text.trim() === ANSWER,
            upstreamRequests: x.fixture.state.requests === 2,
            loopbackOnly: x.fixture.state.tlsFailures === 0 && x.fixture.state.error === null,
        };
        // Only the boolean checks decide the verdict; the numeric ones are recorded for the record.
        const verdict = Object.entries(checks).filter(([,value]) => typeof value === 'boolean').every(([,value]) => value === true);
        Object.assign(outcome, {pass: verdict,
            checks, sessionId: observation.sessionId, text: observation.text, toolUses: observation.toolUses, toolResults: observation.toolResults,
            deniedToolResults: observation.deniedToolResults, requestTools: tools, fileChanges: observation.fileChanges,
            ledger: rows.map(row => ({outcome:row.outcome, reservedMicros:row.reservedMicros, chargedMicros:row.chargedMicros, usageStatus:row.usageStatus})),
            receipts: receipts.map(row => ({outcome:row.outcome, observedModel:row.observedModel, finishReason:row.finishReason, id:row.id,
                upstreamHttpStatus:row.upstreamHttpStatus, upstreamBodyCode:row.upstreamBodyCode, upstreamBodyShape:row.upstreamBodyShape, protocolFailureStage:row.protocolFailureStage})),
            physical: {connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures},
            commandLine: observation.commandLine, cwd: observation.cwd});
    } catch (error) {
        const usageLog = join(x.session.observation.runtimeDirectory,'data','usage.jsonl');
        const goRows = existsSync(usageLog) ? readFileSync(usageLog,'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-4) : [];
        Object.assign(outcome, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,400), gatewayErrors:[...gatewayErrors],
            goUsageLog: goRows, receiptKeys: Object.keys(x.gateway.receipts()[0] ?? {}), firstReceipt: x.gateway.receipts()[0] ?? null,
            ledger:x.budget.requests().map(row => ({outcome:row.outcome, usageStatus:row.usageStatus})),
            receipts:x.gateway.receipts().map(row => ({outcome:row.outcome, protocolFailureStage:row.protocolFailureStage, transportErrorCode:row.transportErrorCode})),
            physical:{connects:x.fixture.state.connects, requests:x.fixture.state.requests, tlsFailures:x.fixture.state.tlsFailures}});
    } finally { await closeRig(x); }
    evidence.cases.push(outcome);
    console.log('CASE ' + JSON.stringify(outcome));
}

/** The production candidate: admitted by the Go row, then refused TLS, so no upstream byte. */
{
    const x = await rig('candidate', {image:CANDIDATE, imageSHA:CANDIDATE_SHA});
    const outcome = {mode:'production-candidate', image:x.image, imageSHA256:x.imageSHA};
    try {
        const reply = await fetch(x.address.url + '/messages?beta=true', {method:'POST',
            headers:{'x-api-key':x.address.token,'content-type':'application/json','anthropic-version':'2023-06-01'},
            body:JSON.stringify({model, max_tokens:512, stream:true,
                tools:[{name:'Write',description:'write a file',input_schema:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}}}}],
                messages:[{role:'user',content:[{type:'text',text:PROMPT}]}]})});
        const text = await reply.text();
        const rows = x.budget.requests(), receipts = x.gateway.receipts();
        Object.assign(outcome, {status:reply.status, body:text.slice(0,200),
            admitted:x.fixture.state.connects >= 1, connects:x.fixture.state.connects, tlsFailures:x.fixture.state.tlsFailures,
            upstreamRequests:x.fixture.state.requests,
            ledger:rows.map(row => ({outcome:row.outcome, usageStatus:row.usageStatus, transportErrorCode:row.transportErrorCode})),
            receipts:receipts.map(row => ({outcome:row.outcome, transportErrorCode:row.transportErrorCode})),
            pass: reply.status === 502 && x.fixture.state.connects >= 1 && x.fixture.state.tlsFailures >= 1 && x.fixture.state.requests === 0 &&
                rows.length === 1 && rows[0].outcome !== 'COMPLETE'});
    } catch (error) {
        Object.assign(outcome, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,400)});
    } finally { await closeRig(x); }
    evidence.cases.push(outcome);
    console.log('CASE ' + JSON.stringify(outcome));
}

evidence.pass = evidence.cases.every(item => item.pass === true);
evidence.harnessSHA256 = sha(readFileSync(new URL(import.meta.url)));
mkdirSync(resolve(OUT, '..'), {recursive:true});
writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
console.log('EVIDENCE ' + OUT + ' sha256=' + sha(readFileSync(OUT)));
if (!evidence.pass) process.exitCode = 1;
