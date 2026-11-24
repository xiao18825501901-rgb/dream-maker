// Physical acceptance for the read-only Pi lane: real Pi CLI x real Go admission x loopback TLS.
//
//   node scripts/accept-pi-readonly.mjs --magpie <candidate.exe> --mirror <private-root.exe> \
//        --pi <pi/dist/bundle/cli.js> [--out <json>]
//
// The lane's digest sets are empty in the product source and registration happens only after this
// evidence exists, so the harness injects the two images into supportsPiReadOnlyBuild for the
// lifetime of this process's module graph, exactly as scripts/accept-claude-executor.mjs does.
// Everything else is the product path: NativeBudget ledger, openOwnedMagpieControl, the owned
// MagpieDshRequestTransport with a PiNativeSession, DeepSeekGateway, the DM tool broker and the
// real PiRunner. Zero paid calls: the upstream is a loopback TLS fixture with a zero price.
import {createHash, randomBytes} from 'node:crypto';
import {copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer as https} from 'node:https';
import {createServer as http} from 'node:http';
import {registerHooks} from 'node:module';
import {join, resolve} from 'node:path';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf('--' + name); return i === -1 ? undefined : argv[i + 1]; };
const CANDIDATE = resolve(opt('magpie') ?? '');
const MIRROR = resolve(opt('mirror') ?? '');
const PI = resolve(opt('pi') ?? '');
const OUT = resolve(opt('out') ?? '.runtime/accept-pi-readonly.json');
const GO_ROOT = opt('go-root') ?? 'F:/DreamMakerSuite/runtime/go1.26.8-windows-amd64/go';
for (const [flag, value] of [['--magpie', CANDIDATE], ['--mirror', MIRROR], ['--pi', PI]])
    if (!existsSync(value)) { console.error('missing ' + flag + ' ' + value); process.exit(2); }

const sha = value => createHash('sha256').update(value).digest('hex');
const CANDIDATE_SHA = sha(readFileSync(CANDIDATE)), MIRROR_SHA = sha(readFileSync(MIRROR));

// The read-only lane's build set is empty in source. Open exactly this harness, for exactly these
// two images, and only for the read-only selector - the executor set stays as it is.
const routeUrl = new URL('../dist/server/magpie-route.js', import.meta.url).href;
const hook = registerHooks({load(url, context, next) {
    const result = next(url, context);
    if (url !== routeUrl) return result;
    let patched = Buffer.from(result.source).toString();
    const starts = ['export function supportsPiReadOnlyBuild(binaryHash) {', 'export function supportsPiExecutorNativeBuild(binaryHash) {'];
    const inject = 'if(binaryHash===' + JSON.stringify(MIRROR_SHA) + '||binaryHash===' + JSON.stringify(CANDIDATE_SHA) + ')return true;';
    for (const start of starts) {
        if (!patched.includes(start)) throw new Error(start + ' not found in the build');
        patched = patched.replace(start, start + inject);
    }
    return {...result, source: patched};
}});
const {DeepSeekGateway} = await import('../dist/server/deepseek-gateway.js');
const {MagpieDshRequestTransport} = await import('../dist/server/magpie-model-transport.js');
const {openOwnedMagpieControl} = await import('../dist/server/magpie-owned.js');
const {NativeBudget} = await import('../dist/server/native-budget.js');
const {own} = await import('../dist/server/process.js');
const {PiRunner} = await import('../dist/server/providers/pi.js');
const {PiNativeSession} = await import('../dist/server/flow/pi-native-session.js');
const {PI_READ_ONLY_TOOLS} = await import('../dist/server/flow/pi-native-wire.js');
const {readOnlyDeskTools} = await import('../dist/server/flow/dsh-role-tools.js');
const {startToolBroker} = await import('../dist/server/tool-broker.js');
const {offlineCustomBudget, offlineCustomQualification} = await import('../tests/fixtures/custom-budget.mjs');
hook.deregister();

const gatewayErrors = [];
const sendError = DeepSeekGateway.prototype.error;
DeepSeekGateway.prototype.error = function (res, status, code, ...rest) {
    gatewayErrors.push({status, code});
    return sendError.call(this, res, status, code, ...rest);
};

const testcert = readFileSync(join(GO_ROOT, 'src/net/http/internal/testcert/testcert.go'), 'utf8');
const cert = testcert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
const key = testcert.match(/-----BEGIN RSA TESTING KEY-----[\s\S]*?-----END RSA TESTING KEY-----/)[0].replaceAll('TESTING KEY', 'PRIVATE KEY');

const host = 'fixture.example.com', provider = 'fixture', model = 'deepseek-flash', MAX_OUT = 4096;

const frame = (events) => events.map((event, index) => 'event: ' + event.type + '\n' + 'data: ' + JSON.stringify({...event, sequence_number: index}) + '\n\n').join('');
const item = (type, extra) => ({id: 'item_1', type, ...extra});
/** A Responses function_call round asking for one read, in the exact shape the wire validates. */
function readReply(served, tag) {
    // Provider-shaped item ids (fc_*) are what the installed CLI echoes back on the replay; an
    // opaque id makes it drop the field and the controller's exact replay cannot match. The real
    // upstream returns provider ids, so the fixture must too.
    const call = {type: 'function_call', id: 'fc_read_' + tag, call_id: 'call_read_' + tag, name: 'desk_read'};
    const args = JSON.stringify({path: 'SPEC.md'});
    return frame([
        {type: 'response.created', response: {object: 'response', id: 'resp_read_' + tag, model: served, status: 'in_progress', output: [], usage: null}},
        {type: 'response.output_item.added', output_index: 0, item: {...call, status: 'in_progress', arguments: ''}},
        {type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: args},
        {type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: args},
        {type: 'response.output_item.done', output_index: 0, item: {...call, status: 'completed', arguments: args}},
        {type: 'response.completed', response: {object: 'response', id: 'resp_read_' + tag, model: served, status: 'completed',
            output: [{...call, status: 'completed', arguments: args}],
            usage: {input_tokens: 120, output_tokens: 18, total_tokens: 138, input_tokens_details: {cached_tokens: 0}}}},
    ]);
}
/** The final text turn. */
function textReply(served, text, tag) {
    const part = {type: 'output_text', text: '', annotations: []};
    const message = {type: 'message', role: 'assistant', id: 'msg_text_' + tag};
    const done = {...part, text};
    return frame([
        {type: 'response.created', response: {object: 'response', id: 'resp_text_' + tag, model: served, status: 'in_progress', output: [], usage: null}},
        {type: 'response.output_item.added', output_index: 0, item: {...message, status: 'in_progress', content: []}},
        {type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part},
        {type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text},
        {type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text},
        {type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: done},
        {type: 'response.output_item.done', output_index: 0, item: {...message, status: 'completed', content: [done]}},
        {type: 'response.completed', response: {object: 'response', id: 'resp_text_' + tag, model: served, status: 'completed',
            output: [{...message, status: 'completed', content: [done]}],
            usage: {input_tokens: 140, output_tokens: 32, total_tokens: 172, input_tokens_details: {cached_tokens: 0}}}},
    ]);
}

/** Loopback TLS upstream plus the CONNECT proxy the owned Go child dials. */
async function upstream(onReply) {
    const state = {connects: 0, requests: 0, tlsFailures: 0, bodies: [], error: null};
    const tls = https({cert, key}, async (req, res) => {
        try {
            const bytes = [];
            for await (const chunk of req) bytes.push(chunk);
            const raw = Buffer.concat(bytes).toString('utf8');
            const body = JSON.parse(raw);
            state.requests += 1;
            state.bodies.push({raw, body, headers: {...req.headers}, url: req.url});
            res.writeHead(200, {'content-type': 'text/event-stream'});
            res.end(onReply(state.requests));
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
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    return {state, proxyUrl: 'http://127.0.0.1:' + proxy.address().port, close: async () => {
        await new Promise(done => proxy.close(done));
        await new Promise(done => tls.close(done));
    }};
}

/** One owned-Magpie read-only turn for one role. */
async function rig(tag, role, answer) {
    // --role executor runs the same turn as the control case: identical body and read pair, only the
    // admission's role differs. It is what separates "this harness is wrong" from "the child refuses
    // a read role on the Pi lane".
    const turnRole = opt('role') ?? role;
    const base = resolve('.runtime/test-temp');
    mkdirSync(base, {recursive: true});
    const root = mkdtempSync(join(base, 'pi-readonly-' + tag + '-'));
    const workspace = join(root, 'workspace');
    for (const dir of [workspace, join(root, 'data', 'cache'), join(root, 'data', 'state')]) mkdirSync(dir, {recursive: true});
    writeFileSync(join(workspace, 'SPEC.md'), 'The product must sum two integers and print the result' + String.fromCharCode(10));
    mkdirSync(join(root, 'scripts', 'isolation'), {recursive: true});
    copyFileSync(resolve('scripts/isolation/windows-owned-job.cs'), join(root, 'scripts', 'isolation', 'windows-owned-job.cs'));
    const staged = join(root, 'dream-maker-magpie.exe');
    try { linkSync(MIRROR, staged); } catch { copyFileSync(MIRROR, staged); }
    if (sha(readFileSync(staged)) !== MIRROR_SHA) throw new Error('staged mirror bytes changed');
    const accountKey = 'DM_SYNTHETIC_' + randomBytes(20).toString('hex');
    const capabilities = [{model, protocol: 'openai-responses', endpoint: 'https://' + host + '/v1/responses'}];
    const fixture = await upstream(turn => turn === 1 ? readReply(model, tag) : textReply(model, answer, tag));
    const spawnEnv = {GODEBUG: 'x509usefallbackroots=1'};
    const proxy = fixture.proxyUrl;
    const networkEnvironment = base => ({...base, HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy,
        ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1,::1,[::1]', no_proxy: 'localhost,127.0.0.1,::1,[::1]'});
    const budget = new NativeBudget(join(root, 'ledger.sqlite'),
        {scopeId: 'OFFLINE_PI_READONLY', authorizationHash: 'OFFLINE_AUTH', totalMicros: 50000000, probeMicros: 5000000,
         warningMicros: 40000000, maxInFlight: 1, maxRepairs: 2}, undefined, undefined, 'FULL_DM', offlineCustomBudget, offlineCustomQualification);
    const session = await openOwnedMagpieControl({root, binary: {path: MIRROR, sha256: MIRROR_SHA}, budget, timeoutMs: 30000,
        bootstrapAccounts: [{provider, authRef: 'AUTH_PI', accountRef: 'ACCOUNT_PI', key: accountKey, capabilities}], networkEnvironment},
        (file, args, options) => own(file, args, {...options, env: {...options.env, ...spawnEnv}}));
    const route = {runtime: 'pi', provider, protocol: 'openai-responses', model, authentication: 'api_key',
        authRef: 'AUTH_PI', accountRef: 'ACCOUNT_PI', upstreamAccountRef: provider + '/' + sha(accountKey).slice(0, 10)};
    if (session.observation.accounts[0].upstreamAccountRef !== route.upstreamAccountRef) throw new Error('controller and child disagree on the account');
    // A zero price: the ledger still reserves and settles, and nothing is charged.
    const price = {provider, model, currency: 'CNY', source: 'OFFLINE_PRICE', expiresAt: new Date(Date.now() + 300000).toISOString(),
        maxInputTokens: 1048576, inputMissMicrosPerMillion: 0, inputHitMicrosPerMillion: 0, outputMicrosPerMillion: 0};
    const turnRoleId = turnRole === 'executor' ? 'executor-one' : turnRole;
    const identity = {projectId: 'offline_project', runId: 'offline_run', configurationHash: 'a'.repeat(64),
        planVersionHash: 'b'.repeat(64), specHash: 'c'.repeat(64), dispatchId: 'offline_dispatch', generation: 'offline_owner', role: turnRole, roleId: turnRoleId};
    const counters = {reserve: 0, settle: 0};
    for (const method of ['reserve', 'settle']) {
        const original = budget[method].bind(budget);
        budget[method] = (...args) => { const result = original(...args); counters[method] += 1; return result; };
    }
    const signal = AbortSignal.timeout(180000);
    const dispatches = [];
    // The owned desk_* implementations, in their read half, exactly as the product narrows them.
    const deskBase = {async dispatch(toolRole, name, args) {
        dispatches.push(name);
        const path = join(workspace, String(args?.path ?? ''));
        if (name === 'desk_read') {
            if (!existsSync(path)) return {path: args.path, exists: false, sha256: '', content: ''};
            const bytes = readFileSync(path);
            return {path: args.path, exists: true, sha256: sha(bytes), content: bytes.toString('utf8')};
        }
        if (name === 'desk_search') return {matches: []};
        throw Object.assign(new Error('not a read tool: ' + name), {code: 'CUSTOM_ROLE_PERMISSION_DENIED'});
    }};
    // The read roles go through the product's read-only controller. The executor control case is the
    // same broker without that narrowing, because an executor legitimately holds more tools.
    const controller = turnRole === 'executor'
        ? {dispatch: (toolRole, name, args, inner) => deskBase.dispatch(toolRole, name, args, inner)}
        : readOnlyDeskTools(turnRole, ['source_read'], deskBase, () => {}, signal);
    const prompt = role === 'planner2'
        ? 'Read SPEC.md, then answer with one line starting PLAN:'
        : 'Read SPEC.md, then answer with one line starting REVIEW: verdict=';
    const pi = new PiNativeSession({protocol: 'openai-responses', model, maxInputTokens: price.maxInputTokens,
        maxOutputTokens: MAX_OUT, prompt, tools: [...PI_READ_ONLY_TOOLS]});
    const channel = new MagpieDshRequestTransport({session, budget, route, role: turnRole, pi, assertCurrent: () => {},
        bindRequest: payload => ({schema: 'dream-maker.native-request-binding.v1', ...identity, engineeringMode: 'custom',
            work: turnRole === 'executor' ? {kind: 'TASK', taskIdHash: 'd'.repeat(64), executorSliceId: null} : {kind: 'SUPERVISION'},
            routeHash: payload.routeHash, bodyHash: payload.bodyHash})});
    const gateway = new DeepSeekGateway(budget, () => price, '', MAX_OUT, 4, () => { throw new Error('no direct fetch'); },
        'responses', false, undefined, undefined, undefined, channel, undefined, model);
    const address = await gateway.start();
    const broker = await startToolBroker(pi.toolController(controller));
    const runner = new PiRunner(() => ({pi: {cliPath: PI, timeoutMs: 120000}}), root,
        async () => ({url: address.url, token: address.token, close: () => gateway.close(), receipts: () => gateway.receipts()}),
        {role: turnRole, roleId: turnRoleId, provider, model, protocol: 'openai-responses', maxOutputTokens: MAX_OUT,
            tools: [...PI_READ_ONLY_TOOLS], assertCurrent: () => {}},
        async () => ({url: broker.url, token: broker.token, close: () => broker.close()}));
    const input = {role: turnRole, workspace, model, specHash: 'a'.repeat(64), runId: 'run_pi_readonly', prompt, signal,
        laya: {role: turnRole, mode: 'off', adoption: 'off', label: null, reason: 'OFFLINE_ACCEPTANCE', latencyMs: 0,
            inputHash: 'b'.repeat(64), modelRevision: null, confidence: null, cached: false}};
    return {root, workspace, fixture, session, route, budget, counters, gateway, channel, gatewayErrors, runner, input, dispatches, controller, signal, pi, broker, close: async () => {
        try { pi.close(); } catch {} 
        try { await broker.close(); } catch {}
        try { await gateway.close(); } catch {}
        try { await fixture.close(); } catch {}
        try { await session.close(); } catch {}
    }};
}

async function caseOne(role, answer) {
    const x = await rig(role, role, answer);
    const outcome = {role, pass: false, checks: {}};
    try {
        gatewayErrors.length = 0;
        const out = await x.runner.run(x.input, () => {});
        assertPiOutput(x, out);
        const receipts = x.gateway.receipts(), rows = x.budget.requests();
        const bodies = x.fixture.state.bodies;
        const declared = bodies.map(row => (row.body.tools ?? []).map(tool => tool.name));
        const writeProbes = [];
        for (const name of ['desk_write', 'desk_edit', 'desk_run']) {
            try { await x.controller.dispatch('executor', name, {path: 'SPEC.md', content: 'x', old_text: 'a', new_text: 'b', entry: 'x'}, x.signal); writeProbes.push({name, refused: false}); }
            catch (error) { writeProbes.push({name, refused: String(error?.code ?? error) === 'CUSTOM_ROLE_PERMISSION_DENIED'}); }
        }
        const checks = {
            loopbackOnly: x.fixture.state.tlsFailures === 0 && x.fixture.state.error === null && x.fixture.state.connects >= 1,
            twoUpstreamPosts: bodies.length === 2 && x.fixture.state.requests === 2,
            oneToolRoundThenText: bodies[0].body.stream === true && bodies[1].body.input.some(part => part.type === 'function_call_output'),
            readOnlyToolsDeclared: declared.every(names => names.length === 2 && names.includes('desk_read') && names.includes('desk_search')),
            noWriteToolDeclared: declared.every(names => !names.some(name => ['desk_write', 'desk_edit', 'desk_run'].includes(name))),
            readHappened: x.dispatches.includes('desk_read'),
            writeToolsRefused: writeProbes.every(probe => probe.refused),
            twoLedgerRowsReservedAndSettled: rows.length === 2 && rows.every(row => row.outcome === 'COMPLETE') && x.counters.reserve === 2 && x.counters.settle === 2,
            zeroFee: rows.every(row => (row.chargedMicros ?? 0) === 0),
            receiptsComplete: receipts.length === 2 && receipts.every(row => row.outcome === 'COMPLETE'),
            exitZero: out.text.trim() === answer,
            roleOnLedger: out.usage.role === role,
            sessionShape: /^pi_session_[0-9a-f]+$/.test(out.sessionId),
            noGatewayError: gatewayErrors.length === 0,
        };
        Object.assign(outcome, {
            pass: Object.values(checks).every(Boolean), checks,
            text: out.text, sessionId: out.sessionId, requestId: out.usage.requestId,
            upstreamPosts: bodies.length, toolsPerPost: declared, dispatches: x.dispatches, writeProbes,
            ledger: rows.map(row => ({outcome: row.outcome, reservedMicros: row.reservedMicros ?? null, chargedMicros: row.chargedMicros ?? null})),
            physical: {connects: x.fixture.state.connects, requests: x.fixture.state.requests, tlsFailures: x.fixture.state.tlsFailures},
            gatewayErrors: [...gatewayErrors], observation: {binaryHash: x.session.observation.binaryHash, accounts: x.session.observation.accounts.length,
                scope: x.session.observation.scope, realCredentialsPermitted: x.session.observation.realCredentialsPermitted},
            route: x.route,
        });
    } catch (error) {
        Object.assign(outcome, {error: String(error?.code ?? error), message: String(error?.message ?? '').slice(0, 300),
            stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | '),
            refusal: error?.refusal ?? error?.body ?? null,
            gatewayErrors: [...gatewayErrors], physical: {connects: x.fixture.state.connects, requests: x.fixture.state.requests, tlsFailures: x.fixture.state.tlsFailures},
            bodies: x.fixture.state.bodies.map(row => ({url: row.url, keys: Object.keys(row.body ?? {})}))});
    } finally { await x.close(); }
    return outcome;
}

function assertPiOutput(x, out) {
    if (!out || typeof out.text !== 'string' || !out.text.trim()) throw Object.assign(new Error('no text'), {code: 'ACCEPT_NO_TEXT'});
    if (out.identity?.runner !== 'PI_CLI') throw Object.assign(new Error('identity'), {code: 'ACCEPT_IDENTITY'});
    if (!/^pi_session_[0-9a-f]+$/.test(out.sessionId ?? '')) throw Object.assign(new Error('session'), {code: 'ACCEPT_SESSION'});
}

const cases = [];
cases.push(await caseOne('planner2', 'PLAN: 1) read SPEC.md; 2) sum the two integers; 3) print the result.'));
cases.push(await caseOne('reviewer', 'REVIEW: verdict=pass; SPEC.md asks for one integer sum.'));
const evidence = {schema: 'dream-maker.pi-readonly-acceptance.v1', recordedAt: new Date().toISOString(),
    paidCalls: 0, network: '127.0.0.1 only (CONNECT proxy + loopback TLS)',
    pi: {path: PI}, candidate: {path: CANDIDATE, sha256: CANDIDATE_SHA}, mirror: {path: MIRROR, sha256: MIRROR_SHA},
    readOnlyTools: [...PI_READ_ONLY_TOOLS], requestCeilingPerTurn: 4, cases};
mkdirSync(resolve(OUT, '..'), {recursive: true});
writeFileSync(OUT, JSON.stringify(evidence, null, 1));
for (const one of cases) console.log(JSON.stringify({role: one.role, pass: one.pass, failed: Object.entries(one.checks ?? {}).filter(([, value]) => !value).map(([key]) => key),
    upstreamPosts: one.upstreamPosts, toolsPerPost: one.toolsPerPost, dispatches: one.dispatches, ledger: one.ledger, error: one.error, gatewayErrors: one.gatewayErrors, physical: one.physical}));
console.log('evidence ' + OUT);
process.exit(cases.every(one => one.pass) ? 0 : 1);
