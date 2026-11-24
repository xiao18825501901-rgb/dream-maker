// Offline Pi contract tests. The optional installed-CLI test uses only loopback fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { PiRunner } from '../../dist/server/providers/pi.js';

const cli = mode => `import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const session = argv[argv.indexOf('--session-id') + 1];
const mode = ${JSON.stringify(mode)};
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
writeFileSync(process.cwd() + '/pi-argv.json', JSON.stringify(argv));
const { providers } = JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', 'utf8'));
writeFileSync(process.cwd() + '/pi-provider.json', JSON.stringify(providers.dm));
emit({ type: 'session', version: 3, id: session, cwd: process.cwd() });
if (mode === 'unexpected-tool') emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'desk_run', args: {} });
if (mode === 'empty') { emit({ type: 'agent_settled' }); process.exit(0); }
if (mode === 'aborted') { emit({ type: 'agent_settled', aborted: true }); process.exit(0); }
if (mode === 'provider-error') {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error', error: { status: 502, code: 'upstream_error' } } });
    emit({ type: 'agent_settled', aborted: false });
    process.exit(0);
}
if (mode === 'tool-only') {
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'desk_run', arguments: {} }], stopReason: 'toolUse' } });
    emit({ type: 'agent_settled', aborted: false });
    process.exit(0);
}
if (mode === 'stray') { process.stdout.write('not json\\n'); emit({ type: 'agent_settled' }); process.exit(0); }
emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PI_OFFLINE_OK' }], stopReason: mode === 'assistant-aborted' ? 'aborted' : ['error', 'length', 'toolUse'].includes(mode) ? mode : 'stop', ...(mode === 'error' ? { errorMessage: 'private fixture detail' } : {}) } });
if (mode !== 'no-settle') emit({ type: 'agent_settled' });
`;

function rig(t, { mode = 'ok', tools = ['desk_read'], withCli = true, protocol, model = 'deepseek-flash', provider = 'deepseek-official' } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'dm-pi-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, `fake-pi-${mode}.mjs`);
    writeFileSync(path, cli(mode));
    let closed = 0;
    const runner = new PiRunner(
        () => ({ pi: { cliPath: withCli ? path : '', timeoutMs: 60000 } }),
        root,
        async () => ({ url: 'http://127.0.0.1:9/v1', token: 'g'.repeat(64), close: async () => { closed++; }, receipts: () => [{ id: 'receipt_one', outcome: 'COMPLETE', completionObserved: true, observedModel: model }] }),
        { role: 'executor', roleId: 'executor-one', model, provider, protocol, maxOutputTokens: 8192, tools, assertCurrent: () => {} });
    const input = {
        role: 'executor', workspace: root, prompt: 'do the task', model, specHash: 'a'.repeat(64), runId: 'run_offline',
        executorRoleId: 'executor-one', signal: new AbortController().signal,
        laya: { role: 'executor', mode: 'off', adoption: 'off', label: null, reason: 'OFFLINE', latencyMs: 0, inputHash: 'b'.repeat(64), modelRevision: null, confidence: null, cached: false }
    };
    return { runner, input, root, closed: () => closed };
}

test('the Pi child is bound to the controller session id and reports a verified identity', async t => {
    const x = rig(t);
    const out = await x.runner.run(x.input, () => {});
    assert.equal(out.text, 'PI_OFFLINE_OK');
    assert.match(out.sessionId, /^pi_session_[0-9a-f]+$/);
    assert.equal(out.model, 'deepseek-flash');
    assert.equal(out.identity.runner, 'PI_CLI');
    assert.equal(out.identity.authentication, 'API_KEY');
    assert.equal(out.usage.requestId, 'receipt_one');
    assert.equal(JSON.parse(readFileSync(join(x.root, 'pi-provider.json'))).compat.requiresAssistantAfterToolResult, true);
    assert.ok(x.closed() >= 1);
});

test('Pi uses the frozen native codec and its SDK base URL', async t => {
    for (const [protocol, baseUrl] of [['openai-responses', 'http://127.0.0.1:9/v1'], ['anthropic-messages', 'http://127.0.0.1:9']]) {
        const x = rig(t, { protocol });
        await x.runner.run(x.input, () => {});
        const provider = JSON.parse(readFileSync(join(x.root, 'pi-provider.json')));
        assert.equal(provider.api, protocol);
        assert.equal(provider.baseUrl, baseUrl);
        assert.equal(provider.compat, undefined);
    }
    assert.throws(() => rig(t, { protocol: 'unknown' }), { code: 'PI_ROLE_BINDING_INVALID' });
});

test('Pi preserves a controller-selected model and rejects a changed input before opening the gateway', async t => {
    const x = rig(t, { model: 'example/model-v2', provider: 'example' });
    await assert.rejects(x.runner.run({ ...x.input, model: 'deepseek-flash' }, () => {}), { code: 'PI_ROLE_BINDING_CHANGED' });
    assert.equal(x.closed(), 0);
    const out = await x.runner.run(x.input, () => {});
    assert.equal(out.model, 'example/model-v2');
    assert.equal(out.identity.provider, 'example');
    const argv = JSON.parse(readFileSync(join(x.root, 'pi-argv.json')));
    assert.equal(argv[argv.indexOf('--model') + 1], 'example/model-v2');
});

// Set this to an installed Pi CLI bundle to exercise its actual JSONL and OpenAI codecs.
// Both the broker and the provider below are synthetic, loopback-only HTTP endpoints.
test('installed Pi closes a tool-only turn through the Custom chat protocol', { skip: !process.env.DM_TEST_PI_CLI }, async t => {
    const { root, input } = rig(t);
    const history = [], calls = [], receipts = [];
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        if (req.url === '/tools') {
            calls.push(body);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ value: 'offline result' }));
        }
        if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
        history.push(body.messages);
        // Magpie rejects null history content before issuing an upstream reservation.
        if (body.messages.some(message => message.content === null) || history.length > 4) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'MAGPIE_PAYLOAD_INVALID' } }));
        }
        const n = history.length;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
            id: 'completion_' + n, object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
            choices: [{ index: 0, delta, finish_reason }]
        }) + '\n\n');
        send({ role: 'assistant' });
        if (n <= 3) {
            if (n < 3) send({ content: 'Inspecting.' });
            send({ tool_calls: [{ index: 0, id: 'call_' + n, type: 'function', function: {
                name: 'desk_read', arguments: JSON.stringify({ path: 'step' + n })
            } }] });
        } else send({ content: 'PI_OFFLINE_FINAL' });
        send({}, n <= 3 ? 'tool_calls' : 'stop');
        receipts.push({ id: 'receipt_' + n, observedModel: 'deepseek-flash', outcome: 'COMPLETE', completionObserved: true });
        res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = 'http://127.0.0.1:' + server.address().port;
    const runner = new PiRunner(() => ({ pi: { cliPath: process.env.DM_TEST_PI_CLI, timeoutMs: 30000 } }), root,
        async () => ({ url: url + '/v1', token: 'offline-model', close: async () => {}, receipts: () => receipts }),
        { role: 'executor', roleId: 'executor-one', model: 'deepseek-flash', maxOutputTokens: 8192, tools: ['desk_read'], assertCurrent() {} },
        async () => ({ url: url + '/tools', token: 'offline-tool', close: async () => {} }));
    const out = await runner.run(input, () => {});
    assert.equal(out.text, 'PI_OFFLINE_FINAL');
    assert.equal(out.usage.requestId, 'receipt_4');
    assert.deepEqual(calls, [1, 2, 3].map(n => ({ name: 'desk_read', args: { path: 'step' + n } })));
    assert.equal(history.length, 4);
    const toolOnly = history[3].find(message => message.tool_calls?.[0]?.id === 'call_3');
    assert.equal(toolOnly.content, '');
    assert.equal(history[3].at(-1).tool_call_id, 'call_3');
});

test('a tool outside the frozen permission set fails the turn instead of being executed', async t => {
    const x = rig(t, { mode: 'unexpected-tool' });
    await assert.rejects(() => x.runner.run(x.input, () => {}), { code: 'PI_UNEXPECTED_TOOL' });
});

test('an unterminated, empty or unparseable Pi turn is refused', async t => {
    const unsettled = rig(t, { mode: 'no-settle' });
    await assert.rejects(() => unsettled.runner.run(unsettled.input, () => {}), { code: 'PI_TURN_INCOMPLETE' });
    const empty = rig(t, { mode: 'empty' });
    await assert.rejects(() => empty.runner.run(empty.input, () => {}), { code: 'PI_OUTPUT_SCHEMA' });
    const stray = rig(t, { mode: 'stray' });
    await assert.rejects(() => stray.runner.run(stray.input, () => {}), { code: 'PI_OUTPUT_SCHEMA' });
});

test('an aborted or upstream-errored Pi turn is classified precisely and keeps safe diagnostics', async t => {
    const aborted = rig(t, { mode: 'aborted' });
    await assert.rejects(() => aborted.runner.run(aborted.input, () => {}), { code: 'PI_TURN_ABORTED' });
    const provider = rig(t, { mode: 'provider-error' });
    const events = [];
    await assert.rejects(() => provider.runner.run(provider.input, event => events.push(event)), { code: 'PI_PROVIDER_ERROR' });
    const diagnostic = events.find(event => event && event.method === 'dm/piDiagnostics');
    assert.ok(diagnostic, 'a safe diagnostic event must be emitted');
    assert.equal(diagnostic.params.providerError.status, 502);
    assert.equal(diagnostic.params.settled.aborted, false);
    const toolOnly = rig(t, { mode: 'tool-only' });
    const events2 = [];
    await assert.rejects(() => toolOnly.runner.run(toolOnly.input, event => events2.push(event)), { code: 'PI_OUTPUT_SCHEMA' });
    const diagnostic2 = events2.find(event => event && event.method === 'dm/piDiagnostics');
    assert.ok(diagnostic2, 'a tool-only final message must expose its stop reason');
    assert.equal(diagnostic2.params.lastStopReason, 'toolUse');
});

test('partial assistant text cannot close an error, truncated or tool-use turn', async t => {
    for (const [mode, code] of [['error', 'PI_PROVIDER_ERROR'], ['length', 'PI_OUTPUT_SCHEMA'], ['toolUse', 'PI_OUTPUT_SCHEMA'], ['assistant-aborted', 'PI_TURN_ABORTED']]) {
        const x = rig(t, { mode });
        const events = [];
        await assert.rejects(x.runner.run(x.input, event => events.push(event)), { code });
        const diagnostic = events.find(event => event.method === 'dm/piDiagnostics');
        assert.equal(diagnostic.params.lastStopReason, mode === 'assistant-aborted' ? 'aborted' : mode);
        assert.doesNotMatch(JSON.stringify(diagnostic), /private fixture detail|PI_OFFLINE_OK/);
    }
});

test('a missing CLI or an unusable prompt fails before any child is spawned', async t => {
    const missing = rig(t, { withCli: false });
    await assert.rejects(() => missing.runner.run(missing.input, () => {}), { code: 'PI_CLI_MISSING' });
    const oversized = rig(t);
    await assert.rejects(() => oversized.runner.run({ ...oversized.input, prompt: 'x'.repeat(400001) }, () => {}), { code: 'PI_ROLE_PROMPT_TOO_LARGE' });
});

test('a prompt too large for the command line is handed over as an owned @file message', async t => {
    const x = rig(t);
    const out = await x.runner.run({ ...x.input, prompt: 'y'.repeat(25000) }, () => {});
    assert.equal(out.text, 'PI_OFFLINE_OK');
    const argv = JSON.parse(readFileSync(join(x.root, 'pi-argv.json'), 'utf8'));
    const last = argv[argv.length - 1];
    assert.ok(last.startsWith('@'), 'prompt must be passed as @file');
    assert.ok(last.endsWith('role-prompt.md'));
    assert.equal(argv.includes('y'.repeat(25000)), false);
});

test('a misbound role, a widened read-only tool set or an unsupported model is refused at construction', () => {
    const root = mkdtempSync(join(tmpdir(), 'dm-pi-'));
    try {
        // A read role is its own role id; an executor's id in a read binding is another role.
        assert.throws(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}), { role: 'reviewer', roleId: 'r', model: 'deepseek-flash', maxOutputTokens: 8192, tools: [], assertCurrent: () => {} }), { code: 'PI_ROLE_BINDING_INVALID' });
        // The same reviewer with its own role id and the frozen read pair is a valid binding.
        assert.doesNotThrow(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}), { role: 'reviewer', roleId: 'reviewer', model: 'deepseek-flash', maxOutputTokens: 8192, tools: ['desk_read', 'desk_search'], assertCurrent: () => {} }));
        // A read role may not hold a write tool; the executor keeps it when it is granted.
        assert.throws(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}), { role: 'reviewer', roleId: 'reviewer', model: 'deepseek-flash', maxOutputTokens: 8192, tools: ['desk_read', 'desk_run'], assertCurrent: () => {} }), { code: 'PI_TOOL_UNSUPPORTED' });
        assert.throws(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}), { role: 'executor', roleId: 'e', model: 'deepseek-v4-pro', maxOutputTokens: 8192, tools: [], assertCurrent: () => {} }), { code: 'PI_ROLE_BINDING_INVALID' });
        assert.throws(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}), { role: 'executor', roleId: 'e', model: 'deepseek-flash', maxOutputTokens: 8192, tools: ['desk_shell'], assertCurrent: () => {} }), { code: 'PI_TOOL_UNSUPPORTED' });
    } finally { rmSync(root, { recursive: true, force: true }); }
});
