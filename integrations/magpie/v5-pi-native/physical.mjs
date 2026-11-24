import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
const input = resolve(process.argv[2]);
const build = JSON.parse(await readFile(input));
const goRoot = build.goRoot, source = build.source;
const work = await mkdtemp(join(dirname(input), 'physical-'));
const sha = v => createHash('sha256').update(v).digest('hex');
assert.equal(sha(await readFile(build.binary)), build.binarySHA256);
const overlay = JSON.parse(await readFile(build.overlay));
const testcert = await readFile(join(goRoot, 'src/net/http/internal/testcert/testcert.go'), 'utf8');
const cert = testcert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
const key = testcert.match(/-----BEGIN RSA TESTING KEY-----[\s\S]*?-----END RSA TESTING KEY-----/)[0].replaceAll('TESTING KEY', 'PRIVATE KEY');
const rootFile = join(work, 'fixture_roots.go');
await writeFile(rootFile, 'package main\nimport "crypto/x509"\nfunc init() { roots := x509.NewCertPool(); if !roots.AppendCertsFromPEM([]byte(' + JSON.stringify(cert + '\n') + ')) { panic("invalid fixture root") }; x509.SetFallbackRoots(roots) }\n');
overlay.Replace[join(source, 'cmd/dream-maker-magpie/fixture_roots.go')] = rootFile;
const fixtureOverlay = join(work, 'overlay.json');
await writeFile(fixtureOverlay, JSON.stringify(overlay));
const mirror = join(work, 'exectest.exe');
execFileSync(join(goRoot, 'bin/go.exe'), ['build', '-overlay', fixtureOverlay, '-buildvcs=false', '-trimpath', '-o', mirror, './cmd/dream-maker-magpie'], { cwd: source, stdio: 'inherit', env: { ...process.env, ...build.env } });
const model = 'Org/Mixed-Name', fn = 'desk_read', id = 'call_fixture', args = { path: 'allowed.txt' }, final = '验证通过 héllo 世界';
const host = 'fixture.example.com', provider = 'fixture', epoch = 'fixture_epoch';
const cases = [];
const pkg = resolve(process.argv[3]), cli = join(pkg, 'dist/bundle/cli.js');
const fixtureText = 'only this synthetic line', toolResult = { path: args.path, content: fixtureText, sha256: sha(fixtureText) };
const guard = join(work, 'network.cjs');
await writeFile(guard, "const net=require('node:net');const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){let p=a[0];if(Array.isArray(p))p=p[0];if((typeof p==='object'?p.host:a[1])!=='127.0.0.1')throw Error('loopback only');return connect.apply(this,a)};");
const golden = await readFile(overlay.Replace[join(source, 'internal/gateway/dm_explicit_test.go')], 'utf8');
const textEvents = golden.match(/const dmNativeFixture = \x60([\s\S]*?)\x60/)[1].trim().split('\n\n').map(x => JSON.parse(x.split('\ndata: ')[1]));
const responsesUsage = { input_tokens: 9, input_tokens_details: { cached_tokens: 2 }, output_tokens: 4, total_tokens: 13 };
function responses(turn) {
    const item = { type: 'function_call', id: 'fc_fixture', call_id: id, name: fn, arguments: JSON.stringify(args), status: 'completed' };
    const envelope = { object: 'response', id: 'resp_' + turn, model, status: 'completed', output: [item], usage: responsesUsage };
    if (turn === 1)
        return [{ type: 'response.created', response: { ...envelope, status: 'in_progress', output: [], usage: undefined } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } }, { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments }, { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: envelope }];
    return JSON.parse(JSON.stringify(textEvents).replaceAll('resp_test', 'resp_2').replaceAll('native-only', model).replaceAll('héllo ', '验证通过 héllo '));
}
function messages(turn) {
    const tool = turn === 1;
    return [{ type: 'message_start', message: { id: 'msg_' + turn, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id, name: fn, input: {} } : { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: final } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' }];
}
const format = ev => ev.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
async function exercise(mode, binarySource, api) {
    const path = api === 'openai-responses' ? '/v1/responses' : '/v1/messages', endpoint = 'https://' + host + '/owned' + path;
    const cwd = join(work, mode + '-' + api), profile = join(cwd, 'profile');
    await mkdir(profile, { recursive: true });
    await mkdir(join(cwd, 'data'));
    const binary = join(cwd, 'dream-maker-magpie.exe');
    await copyFile(binarySource, binary);
    const row = (i) => ({ provider, authentication: 'api_key', authRef: 'auth_' + i, accountRef: 'account_' + i, key: 'FIXTURE_' + randomBytes(20).toString('hex') });
    const accounts = [{ ...row(0), capabilities: [{ model, protocol: api, endpoint }] }, { ...row(1), capabilities: [{ model, protocol: 'chat-completions', endpoint: 'https://chat.example.com/v1/chat/completions' }] }, { ...row(2), model, chat: 'https://old.example.com/v1', responses: 'https://old.example.com/v1', anthropic: '' }];
    let connects = 0, requests = 0, tlsFailures = 0, reply = '', expectedBody, fixtureError;
    const tls = https({ cert, key }, async (req, res) => { try {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/owned' + path);
        assert.equal(req.socket.servername, host);
        assert.equal(req.headers.host, host);
        assert.ok(api === 'openai-responses' ? req.headers.authorization === 'Bearer ' + accounts[0].key : req.headers['x-api-key'] === accounts[0].key);
        const bytes = [];
        for await (const chunk of req)
            bytes.push(chunk);
        assert.deepEqual(JSON.parse(Buffer.concat(bytes)), { ...expectedBody, model });
        requests++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(reply);
    }
    catch (e) {
        fixtureError = e;
        res.writeHead(500);
        res.end();
    } });
    tls.on('tlsClientError', () => tlsFailures++);
    const proxy = http();
    proxy.on('connect', (req, socket, head) => {
        connects++;
        if (req.url !== host + ':443') {
            socket.destroy();
            return;
        }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length)
            socket.unshift(head);
        tls.emit('connection', socket);
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    const env = { SystemRoot: process.env.SystemRoot, Path: join(process.env.SystemRoot, 'System32'), HOME: profile, USERPROFILE: profile, LOCALAPPDATA: profile, APPDATA: profile, XDG_CONFIG_HOME: join(cwd, 'data'), TMP: profile, TEMP: profile, MAGPIE_NO_ACCOUNTS: '1', HTTPS_PROXY: 'http://127.0.0.1:' + proxy.address().port, GODEBUG: 'x509usefallbackroots=1' };
    const child = spawn(binary, [], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const closed = once(child, 'close');
    const timer = setTimeout(() => child.kill(), 120000);
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    async function frame(obj) { const raw = JSON.stringify(obj); child.stdin.write(raw + '\n'); const line = await lines.next(); assert.equal(line.done, false, 'control closed'); const ack = JSON.parse(line.value); if (obj.type)
        assert.equal(ack.controlHash, sha(raw)); return ack; }
    try {
        const ready = await frame({ schema: 'dream-maker.magpie-control.v5', epoch, accounts });
        assert.equal(ready.qualification, 'NOT_VERIFIED');
        assert.match(ready.address, /^127\.0\.0\.1:[0-9]+$/);
        assert.deepEqual(ready.accounts[0].capabilities, accounts[0].capabilities);
        let seq = 0;
        const resp = api === 'openai-responses';
        const toolSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
        const declaration = { name: fn, description: 'read fixture' };
        const initial = resp ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'read' }] }], tools: [{ ...declaration, type: 'function', parameters: toolSchema }], stream: true, store: false, max_output_tokens: 512 } : { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }], system: [{ type: 'text', text: 'fixture' }], tools: [{ ...declaration, input_schema: toolSchema }], stream: true, max_tokens: 512 };
        async function attempt(name, body, { status = 200, account = 0, mutate = {}, grantChange = {}, wire, sent, events, turn = 1 } = {}) {
            const row = accounts[account];
            const ref = ready.accounts[account].upstreamAccountRef;
            const raw = JSON.stringify({ ...body, model: provider + '/' + model });
            const start = connects, up = requests;
            const a = { provider, model, runtime: 'pi', protocol: api, role: 'executor', roleId: 'worker-pi', accountRef: row.accountRef, authRef: row.authRef, authentication: 'api_key', upstreamAccountRef: ref, epoch, id: 'grant_' + (++seq), token: randomBytes(32).toString('hex'), projectId: 'project', flowId: 'flow', reservationId: 'reservation_' + seq, configurationHash: sha('config'), bindingHash: sha('binding'), method: 'POST', path, bodyHash: sha(raw), expiresAtMs: Date.now() + 55000, maxInputTokens: 1048576, maxOutputTokens: 512, ...mutate };
            a.routeHash = sha(JSON.stringify({ accountRef: a.accountRef, authRef: a.authRef, authentication: a.authentication, model: a.model, protocol: a.protocol, provider: a.provider, runtime: a.runtime, upstreamAccountHash: sha(a.upstreamAccountRef) }));
            const issue = await frame({ type: 'issue', request: a });
            let text = '', record;
            if (status === 'issue-denied') {
                assert.equal(issue.accepted, false, name);
            }
            else {
                assert.equal(issue.accepted, true, name);
                const grant = await frame({ type: 'grant', admission: { ...a, upstreamKey: issue.upstreamKey, upstreamKeyId: issue.upstreamKeyId, ...grantChange } });
                if (status === 'grant-denied') {
                    assert.equal(grant.accepted, false, name);
                }
                else {
                    assert.equal(grant.accepted, true, name);
                    expectedBody = JSON.parse(raw);
                    reply = wire ?? format(events ?? (resp ? responses(turn) : messages(turn)));
                    const post = () => fetch('http://' + ready.address + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.token }, body: sent ?? raw, redirect: 'error', signal: AbortSignal.timeout(10000) });
                    const res = await post();
                    text = await res.text();
                    if (fixtureError)
                        throw fixtureError;
                    assert.equal(res.status, status, name);
                    if (status === 200) {
                        const expect = JSON.parse(JSON.stringify(events ?? (resp ? responses(turn) : messages(turn))));
                        assert.deepEqual(text.trim().split('\n\n').map(b => JSON.parse(b.split('\ndata: ')[1])), expect, name);
                    }
                    else
                        assert.ok(!text.includes('event:'), name);
                    const replay = await post();
                    await replay.text();
                    assert.equal(replay.status, 403, name);
                    const ledger = (await readFile(join(cwd, 'data/usage.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT')
                        return ''; throw e; })).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
                    const rows = ledger.filter(x => x.callerKeyId === issue.upstreamKeyId);
                    assert.equal(rows.length, status === 403 ? 0 : 1, name);
                    if (rows.length) {
                        const e = rows[0];
                        assert.equal(e.status, status, name);
                        assert.equal(e.req, provider + '/' + model);
                        assert.equal(e.ep, path);
                        if (status === 200) {
                            assert.equal(e.served, model);
                            assert.equal(e.providerKeyId, ref.split('/')[1]);
                            assert.deepEqual([e.in, e.cache_read, e.cache_write, e.out], [7, 2, 0, 4]);
                            record = { input: e.in, cacheRead: e.cache_read, cacheWrite: e.cache_write, output: e.out };
                        }
                    }
                }
            }
            const physical = status === 200 || status === 502;
            assert.equal(connects - start, physical ? 1 : 0, name);
            assert.equal(requests - up, physical && mode === 'fixture' ? 1 : 0, name);
            cases.push({ mode, api, name, status, reservation: a.reservationId, bodySHA256: sha(raw), routeHash: a.routeHash, physical: requests - up, usage: record });
            return text;
        }
        if (mode === 'baseline') {
            await attempt('frozen denies native Pi', initial, { status: 'issue-denied' });
        }
        else if (mode === 'production') {
            await attempt('production rejects fixture TLS root', initial, { status: 502 });
            assert.ok(tlsFailures > 0);
        }
        else {
            for (const [name, options] of Object.entries({ supervisor: { mutate: { role: 'reviewer', roleId: 'reviewer' } }, 'supervisor role id': { mutate: { roleId: 'planner2' } }, 'wrong protocol account': { account: 1 }, 'legacy account': { account: 2 }, 'wrong auth ref': { mutate: { authRef: 'auth_1' } }, 'wrong model': { mutate: { model: 'other' } }, 'wrong budget': { mutate: { maxOutputTokens: 0 } } }))
                await attempt(name, initial, { status: 'issue-denied', ...options });
            await attempt('reservation substitution', initial, { status: 'grant-denied', grantChange: { reservationId: 'other' } });
            for (const [name, over] of Object.entries({ 'undeclared tool': { tools: [{ ...initial.tools[0], name: 'other' }] }, 'extra authority': { tool_choice: 'auto' }, overspend: resp ? { max_output_tokens: 513 } : { max_tokens: 513 }, 'dangling result': resp ? { input: [...initial.input, { type: 'function_call_output', call_id: id, output: 'orphan' }] } : { messages: [...initial.messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'orphan' }] }] } }))
                await attempt(name, { ...initial, ...over }, { status: 403 });
            await attempt('changed body', initial, { status: 403, sent: '{}' });
            for (const [field, value] of Object.entries({ roleId: 'other-worker', accountRef: accounts[1].accountRef, model: 'Org/mixed-Name' })) {
                await attempt('issued ' + field + ' substitution', initial, { status: 'grant-denied', grantChange: { [field]: value } });
            }
            const history = resp ? { input: [...initial.input, { type: 'function_call', id: 'fc_fixture', call_id: id, name: fn, arguments: JSON.stringify(args) }, { type: 'function_call_output', call_id: id, output: JSON.stringify(toolResult) }] } : { messages: [...initial.messages, { role: 'assistant', content: [{ type: 'tool_use', id, name: fn, input: args }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(toolResult) }] }] };
            await attempt('reused historical tool ID', { ...initial, ...history }, { status: 502 });
            const good = format(resp ? responses(1) : messages(1));
            for (const [name, wire] of Object.entries({ 'unannounced tool': good.replaceAll('desk_read', 'desk_edit'), 'served model': good.replace(model, 'other'), 'truncated': good.slice(0, good.lastIndexOf('event:')), 'duplicate parameter': good.replaceAll('\\"path\\":', '\\"path\\":\\"one\\",\\"path\\":'), 'invalid usage': resp ? good.replace('"total_tokens":13', '"total_tokens":12') : good.replace('"cache_creation_input_tokens":0', '"cache_creation_input_tokens":1') }))
                await attempt(name, initial, { status: 502, wire });
            const w = cwd, workspace = join(cwd, 'workspace'), agent = join(cwd, 'agent');
            await mkdir(workspace);
            await mkdir(agent);
            await writeFile(join(workspace, args.path), fixtureText);
            const modelToken = randomBytes(24).toString('hex'), brokerToken = randomBytes(24).toString('hex');
            let turns = 0, tools = 0, firstError;
            const server = http(async (req, res) => { try {
                const parts = [];
                for await (const part of req)
                    parts.push(part);
                const body = JSON.parse(Buffer.concat(parts));
                assert.equal(req.method, 'POST');
                if (req.url === '/tools') {
                    assert.ok(req.headers.authorization === 'Bearer ' + brokerToken);
                    assert.deepEqual(body, { name: fn, args });
                    assert.equal(++tools, 1);
                    assert.equal(await readFile(join(workspace, args.path), 'utf8'), fixtureText);
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify(toolResult));
                    return;
                }
                ;
                assert.equal(req.url, resp ? path : path + '?beta=true');
                assert.ok(resp ? req.headers.authorization === 'Bearer ' + modelToken : req.headers['x-api-key'] === modelToken);
                assert.equal(body.model, model);
                assert.equal(body.tools.length, 1);
                assert.equal(body.tools[0].name, fn);
                const turn = ++turns;
                assert.ok(turn <= 2);
                if (turn === 2) {
                    assert.equal(tools, 1);
                    if (resp) {
                        const [call, out] = body.input.slice(-2);
                        assert.equal(call.call_id, id);
                        assert.equal(out.call_id, id);
                        assert.deepEqual(JSON.parse(call.arguments), args);
                        assert.deepEqual(JSON.parse(out.output), toolResult);
                    }
                    else {
                        const [c, r] = body.messages.slice(-2);
                        assert.equal(c.content[0].id, id);
                        assert.equal(r.content[0].tool_use_id, id);
                        assert.deepEqual(c.content[0].input, args);
                        assert.deepEqual(JSON.parse(r.content[0].content), toolResult);
                    }
                }
                const wire = await attempt('installed Pi turn ' + turn, body, { turn });
                res.setHeader('content-type', 'text/event-stream');
                res.end(wire);
            }
            catch (e) {
                firstError ??= e;
                res.writeHead(400);
                res.end();
            } });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            const origin = 'http://127.0.0.1:' + server.address().port, ext = join(agent, 'dm-tool.mjs');
            await writeFile(ext, 'import {Type} from "typebox";export default function(pi){pi.registerTool({name:"desk_read",label:"desk_read",description:"Read one approved fixture",parameters:Type.Object({path:Type.String()}),async execute(_id,args,signal){const r=await fetch(process.env.DM_PI_TOOL_URL,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.DM_PI_TOOL_TOKEN},body:JSON.stringify({name:"desk_read",args}),signal});if(!r.ok)throw Error("tool failed");const value=await r.json();return {content:[{type:"text",text:JSON.stringify(value)}],details:value};}})}');
            await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { dm: { api, baseUrl: origin + (api === 'openai-responses' ? '/v1' : ''), apiKey: '$DM_PI_MODEL_TOKEN', models: [{ id: model, name: model, maxTokens: 512, reasoning: false }] } } }));
            await writeFile(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, telemetry: false, retry: { enabled: false, provider: { maxRetries: 0 } } }));
            const env = { SystemRoot: process.env.SystemRoot, PATH: dirname(process.execPath), TEMP: w, TMP: w, TMPDIR: w, HOME: w, USERPROFILE: w, APPDATA: w, LOCALAPPDATA: w, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agent, DM_PI_MODEL_TOKEN: modelToken, DM_PI_TOOL_URL: origin + '/tools', DM_PI_TOOL_TOKEN: brokerToken };
            const child = spawn(process.execPath, ['--require', guard, cli, '--mode', 'json', '--print', '--no-session', '--no-extensions', '-e', ext, '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-builtin-tools', '--no-mcp', '--thinking', 'off', '--provider', 'dm', '--model', model, '--session-id', 'pi_fixture_session', 'Read the fixture file allowed.txt once and report the result.'], { env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', x => stdout += x);
            child.stderr.on('data', x => stderr += x);
            const timeout = setTimeout(() => child.kill(), 60000);
            const [exit] = await once(child, 'close');
            clearTimeout(timeout);
            await new Promise(r => server.close(r));
            if (firstError)
                throw firstError;
            assert.equal(exit, 0, stderr.slice(-200));
            assert.equal(turns, 2);
            assert.equal(tools, 1);
            const event = stdout.trim().split('\n').map(x => JSON.parse(x)).findLast(x => x.type === 'agent_end');
            const results = event.messages.filter(x => x.role === 'assistant');
            assert.deepEqual(results.map(x => x.stopReason), ['toolUse', 'stop']);
            assert.equal(results[1].content[0].text, final);
            for (const r of results)
                assert.deepEqual([r.usage.input, r.usage.cacheRead, r.usage.cacheWrite, r.usage.output], [7, 2, 0, 4]);
            cases.push({ mode, api, name: 'installed Pi CLI', cliSHA256: sha(await readFile(cli)), turns, tools, final, qualified: false });
        }
        child.stdin.end();
        assert.equal((await closed)[0], 0);
    }
    finally {
        clearTimeout(timer);
        child.stdin.end();
        if (child.exitCode === null)
            child.kill();
        await closed;
        await new Promise(r => proxy.close(r));
    }
}
for (const api of ['openai-responses', 'anthropic-messages'])
    for (const [mode, exe] of [['baseline', build.original], ['production', build.binary], ['fixture', mirror]])
        await exercise(mode, exe, api);
await writeFile(join(work, 'results.json'), JSON.stringify({ binarySHA256: build.binarySHA256, mirrorSHA256: sha(await readFile(mirror)), qualification: 'NOT_VERIFIED', paidCalls: 0, cases }, null, 2));
console.log(work, cases.length);
