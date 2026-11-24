import test from 'node:test';
import assert from 'node:assert/strict';
import { startKimiBridgeIfConfigured } from '../dist/server/kimi-bridge-startup.js';
import { createKimiCredentialAuthority } from '../dist/server/kimi-credential-authority.js';

// C03: start/stop lifecycle without an app, a server or a real process.

const token = n => ({ accessToken: 'acc_' + n, refreshToken: 'ref_' + n, expiresAt: 1_700_000_000_000, expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer' });
function store(record = null) {
    let value = record;
    return {
        async save(_n, v) { value = structuredClone(v); },
        async load() { return value ?? undefined; },
        async loadRecord() { return value == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(value) }; },
        async remove() { value = null; },
        async list() { return value ? ['kimi-code'] : []; }
    };
}
function fakeSpawn() {
    const calls = [];
    const child = {
        stdout: { on: () => {} }, stderr: { on: () => {} },
        stdin: { writes: [], write(b) { this.writes.push(b); }, end() {} },
        on: () => {}, kill() { this.killed = true; }
    };
    return { calls, child, spawn: (command, args, options) => { calls.push({ command, args, options }); return child; } };
}
const env = over => ({ DM_KIMI_BRIDGE: '1', DM_KIMI_BRIDGE_DISTRO: 'DreamMaker-Acceptance-20261011', DM_KIMI_BRIDGE_SCRIPT: '/opt/dm/bridge.py', DM_KIMI_BRIDGE_HOME: '/opt/dm/home', ...over });
async function authority(seed) {
    const a = createKimiCredentialAuthority({ store: store(), clock: () => 1_700_000_000_000 });
    await a.restore();
    if (seed) await a.commit({ token: token(1), generation: 1, messageId: 'seed' });
    return a;
}

test('C03-Y1 no flag means no process, and the decision says why', async () => {
    const fake = fakeSpawn();
    const result = await startKimiBridgeIfConfigured({ env: env({ DM_KIMI_BRIDGE: undefined }), kimiRunnerConfigured: true, authority: await authority(true), spawn: fake.spawn });
    assert.equal(result.runtime, null);
    assert.equal(result.decision.reason, 'BRIDGE_FLAG_OFF');
    assert.equal(fake.calls.length, 0);
});

test('C03-Y2 a configured bridge starts, writes HELLO+RESTORE, and stops on request', async () => {
    const fake = fakeSpawn();
    const result = await startKimiBridgeIfConfigured({ env: env(), kimiRunnerConfigured: true, authority: await authority(true), spawn: fake.spawn });
    assert.equal(result.decision.reason, 'START');
    assert.ok(result.runtime);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].args.slice(0, 3), ['-d', 'DreamMaker-Acceptance-20261011', '--']);
    const frames = fake.child.stdin.writes.map(b => JSON.parse(b.subarray(4).toString('utf8')).type);
    assert.deepEqual(frames, ['HELLO', 'RESTORE']);
    result.runtime.stop();
    assert.equal(fake.child.killed, true);
});

test('C03-Y3 without a credential authority nothing is spawned', async () => {
    const fake = fakeSpawn();
    const result = await startKimiBridgeIfConfigured({ env: env(), kimiRunnerConfigured: true, spawn: fake.spawn });
    assert.equal(result.runtime, null);
    assert.equal(result.decision.reason, 'NO_CREDENTIAL_AUTHORITY');
    assert.equal(fake.calls.length, 0);
});

test('C03-Y4 without a configured kimi runner nothing is spawned', async () => {
    const fake = fakeSpawn();
    const result = await startKimiBridgeIfConfigured({ env: env(), kimiRunnerConfigured: false, authority: await authority(true), spawn: fake.spawn });
    assert.equal(result.runtime, null);
    assert.equal(result.decision.reason, 'NO_KIMI_RUNNER');
    assert.equal(fake.calls.length, 0);
});

test('C03-Y5 an authority that has not finished RESTORE refuses before spawning', async () => {
    const fake = fakeSpawn();
    const fresh = createKimiCredentialAuthority({ store: store() });
    await assert.rejects(startKimiBridgeIfConfigured({ env: env(), kimiRunnerConfigured: true, authority: fresh, spawn: fake.spawn }), { code: 'KIMI_RESTORE_NOT_READY' });
    assert.equal(fake.calls.length, 0);
});
test('C03-Y6 a socket in the environment makes the lifecycle start the CONNECTOR, not the bridge', async () => {
    const fake = fakeSpawn();
    const result = await startKimiBridgeIfConfigured({
        env: env({ DM_KIMI_BRIDGE_SOCKET: '/tmp/dm/ctl.sock', DM_KIMI_BRIDGE_CONNECTOR: '/tmp/dm/connect.py' }),
        kimiRunnerConfigured: true,
        authority: await authority(true),
        spawn: fake.spawn
    });
    assert.equal(result.decision.reason, 'START');
    assert.ok(result.runtime);
    // The connector argv: wsl -d <distro> -u root -- python connector socket
    const argv = fake.calls[0].args;
    assert.deepEqual(argv.slice(0, 5), ['-d', 'DreamMaker-Acceptance-20261011', '-u', 'root', '--']);
    assert.ok(argv.includes('/tmp/dm/connect.py'), 'connector script is in the argv');
    assert.ok(argv.includes('/tmp/dm/ctl.sock'), 'socket path is in the argv');
    assert.equal(argv.includes('/opt/dm/bridge.py'), false, 'connector mode must not start the bridge itself');
    // HELLO + RESTORE are written into the connector stream, exactly like the spawn topology.
    const frames = fake.child.stdin.writes.map(b => JSON.parse(b.subarray(4).toString('utf8')).type);
    assert.deepEqual(frames, ['HELLO', 'RESTORE']);
    result.runtime.stop();
});
