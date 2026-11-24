// The read-only Pi lane: planner2 and reviewer on Pi's native Responses wire.
//
// What this file locks, in order: the protocol matrix (which role resolves which wire, and that
// the two Pi selectors are role-disjoint), the fail-closed build gate (an empty piReadOnlyBuilds
// closes the lane instead of falling back), the frozen read-only tool set (desk_read/desk_search
// and never desk_write/desk_edit/desk_run, at the runner and at the wire), and role isolation (a
// read role cannot borrow an executor's role id, and every turn owns its own Pi session).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    additionalMagpieRoute, piExecutorNativeProtocol, piReadOnlyProtocol, registeredPiReadOnlyDigests,
    supportsPiExecutorNativeBuild, supportsPiReadOnlyBuild
} from '../../dist/server/magpie-route.js';
import { customMagpieProtocol, piExecutorToolProtocol, piReadOnlyToolProtocol } from '../../dist/shared/custom-magpie-protocol.js';
import { PI_READ_ONLY_TOOLS, piNativeRequestBody, piReadOnlyToolsOnly } from '../../dist/server/flow/pi-native-wire.js';
import { PiNativeSession } from '../../dist/server/flow/pi-native-session.js';
import { PiRunner } from '../../dist/server/providers/pi.js';
import { customMagpieApiRuntime } from '../../dist/server/flow/custom-role-identity.js';
import { resolveCustomMagpieRoute } from '../../dist/server/flow/custom-magpie-catalog.js';

// The product image every other lane here is registered against. It is evidence for the Pi
// executor's tool turn only; the read-only lane is asserted through its own registry below.
// Read from the registry, never pinned: a rebuild replaces the registered image, and the lane must
// be asserted against the build in hand (the same rule the DSH/CLI lanes already follow).
const PRODUCT = registeredPiReadOnlyDigests()[0] ?? 'fbb6b03885826ebb8600eb16afb0f008ec97c342e6e356a3d009fbca76317012';
const account = { provider: 'deepseek-official', authentication: 'api_key', authRef: 'AUTH', accountRef: 'acct' };
const budget = { currency: 'USD', maxMicros: 100 };
const readActor = role => ({ id: role, ...account, runtime: 'pi', model: { kind: 'model', id: 'deepseek-flash' },
    permissions: ['source_read'], budget, nativeException: false, transport: 'magpie' });
const declared = { ...account, upstreamAccountRef: 'deepseek-official/abcdef0123', model: 'deepseek-flash',
    capabilities: [{ model: 'deepseek-flash', protocol: 'openai-responses' }, { model: 'deepseek-flash', protocol: 'chat-completions' }] };
const observation = { scope: 'LOCAL_CONTROL_PROCESS_ONLY', accountCount: 1, accounts: [declared], binaryHash: PRODUCT };

const fakeCli = () => `import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const session = argv[argv.indexOf('--session-id') + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
readFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', 'utf8');
emit({ type: 'session', version: 3, id: session, cwd: process.cwd() });
emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PI_READONLY_OK' }], stopReason: 'stop' } });
emit({ type: 'agent_settled', aborted: false });
`;

/** One offline turn of the real PiRunner against a synthetic gateway receipt list. */
function rig(t, role, tools) {
    const root = mkdtempSync(join(tmpdir(), 'dm-pi-readonly-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cli = join(root, 'fake-pi.mjs');
    writeFileSync(cli, fakeCli());
    const runner = new PiRunner(
        () => ({ pi: { cliPath: cli, timeoutMs: 60000 } }), root,
        async () => ({ url: 'http://127.0.0.1:9/v1', token: 'g'.repeat(64), close: async () => {},
            receipts: () => [{ id: 'receipt_' + role, outcome: 'COMPLETE', completionObserved: true, observedModel: 'deepseek-flash' }] }),
        { role, roleId: role, model: 'deepseek-flash', provider: 'deepseek-official', protocol: 'openai-responses',
            maxOutputTokens: 8192, tools, assertCurrent: () => {} });
    const input = { role, workspace: root, prompt: 'produce the read-only answer', model: 'deepseek-flash',
        specHash: 'a'.repeat(64), runId: 'run_readonly', signal: new AbortController().signal,
        laya: { role, mode: 'off', adoption: 'off', label: null, reason: 'OFFLINE', latencyMs: 0, inputHash: 'b'.repeat(64),
            modelRevision: null, confidence: null, cached: false } };
    return { runner, input, root };
}

test('the two Pi selectors are role-disjoint and the read role keeps Responses only', () => {
    const both = ['openai-responses', 'anthropic-messages'];
    for (const role of ['planner2', 'reviewer']) {
        assert.equal(piReadOnlyToolProtocol(role, 'pi', both), 'openai-responses');
        // Pi's read-only leg has no second wire, and the executor leg never answers for it.
        assert.equal(piReadOnlyToolProtocol(role, 'pi', ['anthropic-messages']), undefined);
        assert.equal(piReadOnlyToolProtocol(role, 'pi', ['chat-completions']), undefined);
        assert.equal(piExecutorToolProtocol(role, 'pi', both), undefined);
        // The resolved ladder stays out of it on purpose: the route, not the ladder, gates the lane.
        assert.equal(customMagpieProtocol(role, 'pi', both), undefined);
    }
    assert.equal(piExecutorToolProtocol('executor', 'pi', both), 'openai-responses');
    assert.equal(piExecutorToolProtocol('executor', 'pi', ['anthropic-messages']), 'anthropic-messages');
    assert.equal(piReadOnlyToolProtocol('executor', 'pi', both), undefined);
    for (const runtime of ['dsh', 'claude', 'codex', 'opencode', 'cline', 'independent'])
        assert.equal(piReadOnlyToolProtocol('planner2', runtime, both), undefined);
    // A declared per-model capability is the only wire evidence the route selector accepts.
    const selection = { runtime: 'pi', authentication: 'api_key', model: 'deepseek-flash', protocol: 'openai-responses' };
    assert.equal(piReadOnlyProtocol('planner2', { ...selection, authentication: 'oauth' }, declared.capabilities), undefined);
    assert.equal(piReadOnlyProtocol('planner2', { ...selection, model: 'other-model' }, declared.capabilities), undefined);
    assert.equal(piReadOnlyProtocol('planner2', selection, undefined), undefined);
    for (const role of ['planner2', 'reviewer']) {
        assert.equal(piReadOnlyProtocol(role, selection, declared.capabilities), 'openai-responses');
        assert.equal(piExecutorNativeProtocol(role, selection, declared.capabilities), undefined);
    }
});

test('an empty read-only build set closes the lane instead of falling back', () => {
    // The mechanism, independent of what the registry currently holds.
    assert.equal(supportsPiReadOnlyBuild('0'.repeat(64)), false);
    for (const role of ['planner2', 'reviewer']) {
        const extra = additionalMagpieRoute(role, { runtime: 'pi', authentication: 'api_key', model: 'deepseek-flash', protocol: 'openai-responses' }, declared.capabilities);
        assert.equal(extra.protocol, 'openai-responses', 'the outlet is still named for the caller');
        assert.equal(extra.supportsBuild('0'.repeat(64)), false, 'and an unregistered build fails its own gate');
    }
    const registered = registeredPiReadOnlyDigests();
    if (registered.length === 0) {
        assert.deepEqual(registered, [], 'the read-only set stays empty until the physical turns are recorded');
        for (const role of ['planner2', 'reviewer'])
            assert.equal(additionalMagpieRoute(role, { runtime: 'pi', authentication: 'api_key', model: 'deepseek-flash', protocol: 'openai-responses' }, declared.capabilities).supportsBuild(PRODUCT), false);
        // The registry therefore refuses the route before any control process is opened.
        for (const role of ['planner2', 'reviewer'])
            assert.throws(() => resolveCustomMagpieRoute(observation, role, readActor(role)), { code: 'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED' });
    } else {
        for (const digest of registered) assert.equal(supportsPiReadOnlyBuild(digest), true);
        const admitted = { ...observation, binaryHash: registered[0] };
        for (const role of ['planner2', 'reviewer'])
            assert.deepEqual(resolveCustomMagpieRoute(admitted, role, readActor(role)), { ...account, runtime: 'pi', protocol: 'openai-responses', model: 'deepseek-flash', upstreamAccountRef: declared.upstreamAccountRef });
        // And a build that carries no read-only digest still fails this lane's own gate.
        assert.throws(() => resolveCustomMagpieRoute({ ...observation, binaryHash: 'a'.repeat(64) }, 'planner2', readActor('planner2')), { code: 'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED' });
    }
    // Pi's executor evidence never opens this lane by itself.
    assert.equal(supportsPiExecutorNativeBuild(PRODUCT), true);
});

test('the read-only tool set is desk_read and desk_search and never the write three', () => {
    assert.deepEqual([...PI_READ_ONLY_TOOLS], ['desk_read', 'desk_search']);
    assert.equal(piReadOnlyToolsOnly(['desk_read', 'desk_search']), true);
    assert.equal(piReadOnlyToolsOnly(['desk_read']), true);
    const root = mkdtempSync(join(tmpdir(), 'dm-pi-tools-'));
    try {
        for (const write of ['desk_write', 'desk_edit', 'desk_run']) {
            assert.equal(piReadOnlyToolsOnly(['desk_read', write]), false);
            for (const role of ['planner2', 'reviewer'])
                assert.throws(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}),
                    { role, roleId: role, model: 'deepseek-flash', maxOutputTokens: 8192, tools: ['desk_read', write], assertCurrent: () => {} }),
                    { code: 'PI_TOOL_UNSUPPORTED' }, role + ' must not hold ' + write);
        }
        // The executor shape keeps the write tools it is granted; the read pair is not executor-only.
        assert.doesNotThrow(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}),
            { role: 'executor', roleId: 'executor-one', model: 'deepseek-flash', maxOutputTokens: 8192,
                tools: ['desk_read', 'desk_search', 'desk_write', 'desk_edit', 'desk_run'], assertCurrent: () => {} }));
        assert.doesNotThrow(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}),
            { role: 'planner2', roleId: 'planner2', model: 'deepseek-flash', maxOutputTokens: 8192,
                tools: ['desk_read', 'desk_search'], assertCurrent: () => {} }));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the wire admits the read pair and refuses a body that declares a write tool', () => {
    const limitsReadOnly = { protocol: 'openai-responses', model: 'deepseek-flash', maxInputTokens: 1000, maxOutputTokens: 512,
        tools: ['desk_read', 'desk_search'], prompt: 'produce the read-only answer' };
    const declaration = (name, required) => ({ type: 'function', name, description: name + ' (Dream Maker controlled project tool)',
        parameters: { type: 'object', required, properties: Object.fromEntries(required.map(k => [k, { type: 'string' }])) } });
    const envelope = tools => ({ model: 'deepseek-flash', stream: true, store: false, max_output_tokens: 512, tools,
        input: [{ role: 'system', content: 'controller system block' }, { role: 'user', content: [{ type: 'input_text', text: 'produce the read-only answer' }] }] });
    const admitted = piNativeRequestBody(envelope([declaration('desk_read', ['path']), declaration('desk_search', ['text'])]), limitsReadOnly);
    assert.deepEqual(admitted.tools.map(t => t.name), ['desk_read', 'desk_search']);
    // A write tool in the body is a different tool set than the session froze, so the wire refuses
    // it before any byte reaches the upstream: desk_write is a legal desk tool, not this role's.
    assert.throws(() => piNativeRequestBody(envelope([declaration('desk_read', ['path']), declaration('desk_write', ['path', 'content'])]), limitsReadOnly),
        { code: 'PI_NATIVE_WIRE_INVALID' });
    // And the session refuses to settle a call outside its frozen list, then settles a read call.
    const refused = new PiNativeSession(limitsReadOnly);
    refused.begin();
    assert.throws(() => refused.settle({ callId: 'call_one', name: 'desk_write', arguments: JSON.stringify({ path: 'a', content: 'b' }) }), { code: 'PI_UNEXPECTED_TOOL' });
    const accepted = new PiNativeSession(limitsReadOnly);
    accepted.begin();
    accepted.settle({ callId: 'call_two', name: 'desk_read', arguments: JSON.stringify({ path: 'a' }) });
    assert.equal(accepted.history().length, 0, 'a call is history only after its broker result');
});

test('a read role cannot borrow the executor role id, and every turn owns its session', async t => {
    const root = mkdtempSync(join(tmpdir(), 'dm-pi-isolation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const role of ['planner2', 'reviewer']) {
        // The read role IS its role id: an executor id in a read binding is a different role.
        assert.throws(() => new PiRunner(() => ({ pi: { cliPath: 'x' } }), root, async () => ({}),
            { role, roleId: 'executor-one', model: 'deepseek-flash', maxOutputTokens: 8192, tools: ['desk_read'], assertCurrent: () => {} }),
            { code: 'PI_ROLE_BINDING_INVALID' });
        const x = rig(t, role, ['desk_read', 'desk_search']);
        const out = await x.runner.run(x.input, () => {});
        assert.equal(out.text, 'PI_READONLY_OK');
        assert.equal(out.usage.role, role, 'the ledger row names the role that spent it');
        assert.match(out.sessionId, /^pi_session_[0-9a-f]+$/);
        // An executor turn may not ride a read binding: the frozen turn role decides the lane.
        const other = role === 'planner2' ? 'executor' : 'planner2';
        await assert.rejects(x.runner.run({ ...x.input, role: other, executorRoleId: 'executor-one' }, () => {}), { code: 'PI_ROLE_BINDING_CHANGED' });
        // Nor may a read turn present a different model.
        await assert.rejects(x.runner.run({ ...x.input, model: 'deepseek-v4-pro' }, () => {}), { code: 'PI_ROLE_BINDING_CHANGED' });
    }
    const planner = rig(t, 'planner2', ['desk_read', 'desk_search']);
    const executor = rig(t, 'executor', ['desk_read', 'desk_search', 'desk_write']);
    const first = await planner.runner.run(planner.input, () => {});
    const second = await executor.runner.run(executor.input, () => {});
    assert.notEqual(first.sessionId, second.sessionId, 'the read session is never the executor session');
    assert.deepEqual([first.usage.role, second.usage.role], ['planner2', 'executor']);
});

test('pi is a configured read-only harness and its read routes stay fail-closed', () => {
    for (const role of ['planner2', 'executor', 'reviewer']) assert.equal(customMagpieApiRuntime(role, 'pi'), true);
    // A read actor that names another role, or that carries source_write, is still refused.
    assert.throws(() => resolveCustomMagpieRoute(observation, 'planner2', { ...readActor('planner2'), id: 'executor-one' }), { code: 'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED' });
    assert.throws(() => resolveCustomMagpieRoute(observation, 'planner2', { ...readActor('planner2'), permissions: ['source_read', 'source_write'] }), { code: 'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED' });
});
