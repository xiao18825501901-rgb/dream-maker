import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, PROTOCOL_VERSION, STORAGE_NAME } from '../dist/server/kimi-bridge-frames.js';
import { createKimiBridgeController } from '../dist/server/kimi-bridge-controller.js';
import { createKimiCredentialAuthority } from '../dist/server/kimi-credential-authority.js';
import { kimiBridgeLaunch } from '../dist/server/kimi-bridge-launcher.js';
import { createBridgeFrameLedger } from '../dist/server/kimi-bridge-ledger.js';

// C03/C04: the full controller assembly, driven by a recording child. No process is started, no WSL
// is involved, no DPAPI: the point is that launcher + session + authority compose correctly and that
// the ACK rule still holds at this level.

const token = (n = 1) => ({ accessToken: 'acc_' + n, refreshToken: 'ref_' + n, expiresAt: 1_700_000_000_000, expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer' });

function store(record = null, opts = {}) {
    let value = record;
    return {
        writes: [],
        async save(_n, v) { if (opts.failWrite) throw new Error('disk'); this.writes.push(1); value = structuredClone(v); },
        async load() { return value ?? undefined; },
        async loadRecord() { return value == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(value) }; },
        async remove() { value = null; },
        async list() { return value ? ['kimi-code'] : []; }
    };
}

function fakeSpawn() {
    const calls = [];
    const listeners = {};
    const child = {
        stdout: { on: (ev, cb) => { listeners.stdout = cb; } },
        stderr: { on: (ev, cb) => { listeners.stderr = cb; } },
        stdin: { writes: [], write(b) { this.writes.push(b); }, end() { this.ended = true; } },
        on: (ev, cb) => { listeners[ev] = cb; },
        kill() { this.killed = true; },
        stdoutFrame: obj => listeners.stdout(encodeFrame(obj)),
        emit: (ev, arg) => listeners[ev]?.(arg)
    };
    return { calls, child, spawn: (command, args, options) => { calls.push({ command, args, options }); return child; } };
}
const frame = over => ({ protocolVersion: PROTOCOL_VERSION, instanceId: 'ctl1', storageName: STORAGE_NAME, type: 'ROTATE', generation: 1, messageId: 'm1', accountRef: 'kimi:u1', token: token(1), ...over });

async function rig(overrides = {}) {
    const s = overrides.store ?? store();
    const authority = createKimiCredentialAuthority({ store: s, clock: () => 1_700_000_000_000 });
    await authority.restore();
    if (overrides.seed) await authority.commit({ token: overrides.seed, generation: 1, messageId: 'seed' });
    const spawn = fakeSpawn();
    const frames = [];
    const exits = [];
    const controller = createKimiBridgeController({
        launch: kimiBridgeLaunch({ distro: 'DreamMaker-Acceptance-20261011', script: '/opt/dm/bridge.py', home: '/opt/dm/home' }),
        spawn: spawn.spawn,
        authority,
        instanceId: 'ctl1',
        accountRef: 'kimi:u1',
        onFrame: f => frames.push(f),
        onExit: e => exits.push(e)
    });
    return { controller, spawn, authority, store: s, frames, exits, sentFrames: () => spawn.child.stdin.writes.map(b => JSON.parse(b.subarray(4).toString('utf8'))) };
}

test('C04-C1 start launches the pinned wsl shape and emits HELLO + RESTORE', async () => {
    const ctx = await rig({ seed: token(1) });
    await ctx.controller.start();
    assert.equal(ctx.spawn.calls[0].command, 'wsl.exe');
    assert.deepEqual(ctx.spawn.calls[0].args.slice(0, 3), ['-d', 'DreamMaker-Acceptance-20261011', '--']);
    const sent = ctx.sentFrames();
    assert.deepEqual(sent.map(f => f.type), ['HELLO', 'RESTORE']);
    assert.equal(sent[1].token.accessToken, 'acc_1');
    assert.equal(ctx.controller.running(), true);
});

test('C04-C2 a ROTATE from the bridge is committed and ACKed through the process pipe', async () => {
    const ctx = await rig();
    await ctx.controller.start();
    ctx.spawn.child.stdoutFrame(frame());
    await new Promise(r => setTimeout(r, 10));
    const ack = ctx.sentFrames().find(f => f.type === 'COMMIT_ACK');
    assert.deepEqual({ generation: ack.generation, messageId: ack.messageId }, { generation: 1, messageId: 'm1' });
    assert.equal(ctx.store.writes.length, 1);
    assert.ok(ctx.frames.some(f => f.type === 'HELLO'));
});

test('C04-C3 a failed persist produces ERROR and no ACK, end to end', async () => {
    const ctx = await rig({ store: store(null, { failWrite: true }) });
    await ctx.controller.start();
    ctx.spawn.child.stdoutFrame(frame());
    await new Promise(r => setTimeout(r, 10));
    const sent = ctx.sentFrames();
    assert.equal(sent.some(f => f.type === 'COMMIT_ACK'), false);
    assert.equal(sent.find(f => f.type === 'ERROR').code, 'KIMI_TOKEN_PERSIST_FAILED');
});

test('C04-C4 a second start is refused and stop closes the child', async () => {
    const ctx = await rig();
    await ctx.controller.start();
    await assert.rejects(ctx.controller.start(), { code: 'KIMI_BRIDGE_ALREADY_STARTED' });
    ctx.controller.stop();
    assert.equal(ctx.spawn.child.killed, true);
});

test('C04-C5 an un-restored authority blocks the whole assembly', async () => {
    const authority = createKimiCredentialAuthority({ store: store() });
    const spawn = fakeSpawn();
    const controller = createKimiBridgeController({
        launch: kimiBridgeLaunch({ distro: 'DreamMaker-Acceptance-20261011', script: '/opt/dm/bridge.py', home: '/opt/dm/home' }),
        spawn: spawn.spawn, authority, instanceId: 'ctl1', accountRef: 'kimi:u1'
    });
    await assert.rejects(controller.start(), { code: 'KIMI_RESTORE_NOT_READY' });
    assert.equal(spawn.calls.length, 0, 'no process is spawned before the credential state is known');
});

test('C04-C6 the child exit is surfaced to the caller', async () => {
    const ctx = await rig();
    await ctx.controller.start();
    ctx.spawn.child.emit('exit', { code: 0, signal: null });
    assert.deepEqual(ctx.exits[0], { code: 0, signal: null });
    assert.equal(ctx.controller.running(), false);
    assert.deepEqual(ctx.controller.exit(), { code: 0, signal: null });
});
// C04-L: the frame ledger is what makes "the rotation was acknowledged" observable from the product
// instead of only from a script's stdout. It must see BOTH directions, exactly once, and never carry
// credential material.
test('C04-L1 the controller reports both directions once, and the ledger tracks the ACK', async () => {
    const ctx = await rig();
    const ledger = createBridgeFrameLedger();
    // Re-create a controller that feeds the ledger, reusing the same rig pieces.
    const authority = ctx.authority;
    const controller = createKimiBridgeController({
        launch: kimiBridgeLaunch({ distro: 'DreamMaker-Acceptance-20261011', script: '/opt/dm/bridge.py', home: '/opt/dm/home' }),
        spawn: ctx.spawn.spawn,
        authority,
        instanceId: 'ctl1',
        accountRef: 'kimi:u1',
        onFrame: (f, d) => ledger.record(f, d)
    });
    await controller.start();
    let snap = ledger.snapshot();
    assert.deepEqual(snap.counts, { HELLO: 1, RESTORE: 1 }, 'start emits exactly one HELLO and one RESTORE');
    assert.equal(snap.lastAckGeneration, null, 'nothing is acknowledged before a rotation');
    ctx.spawn.child.stdoutFrame(frame());
    await new Promise(r => setTimeout(r, 10));
    snap = ledger.snapshot();
    assert.deepEqual(snap.counts, { HELLO: 1, RESTORE: 1, ROTATE: 1, COMMIT_ACK: 1 });
    assert.equal(snap.lastRotateGeneration, 1);
    assert.equal(snap.lastAckGeneration, 1, 'the ACK is recorded only because the durable commit happened');
    assert.equal(snap.closed, false);
    // Direction is part of the evidence now: '>' is ours, '<' came back from the peer.
    assert.deepEqual(snap.recent, ['>HELLO', '>RESTORE', '<ROTATE#1', '>COMMIT_ACK#1']);
    assert.equal(snap.established, true, 'the inbound ROTATE is what proves the peer is there');
    assert.deepEqual(snap.inbound, { ROTATE: 1 });
});

test('C04-L2 a failed persist shows up as an error code and no ACK generation', async () => {
    const ctx = await rig({ store: store(null, { failWrite: true }) });
    const ledger = createBridgeFrameLedger();
    const controller = createKimiBridgeController({
        launch: kimiBridgeLaunch({ distro: 'DreamMaker-Acceptance-20261011', script: '/opt/dm/bridge.py', home: '/opt/dm/home' }),
        spawn: ctx.spawn.spawn, authority: ctx.authority, instanceId: 'ctl1', accountRef: 'kimi:u1',
        onFrame: (f, d) => ledger.record(f, d)
    });
    await controller.start();
    ctx.spawn.child.stdoutFrame(frame());
    await new Promise(r => setTimeout(r, 10));
    const snap = ledger.snapshot();
    assert.equal(snap.lastAckGeneration, null);
    assert.equal(snap.lastRotateGeneration, 1);
    assert.equal(snap.lastErrorCode, 'KIMI_TOKEN_PERSIST_FAILED');
    assert.equal(snap.closed, true);
});

test('C04-L3 the ledger cannot leak a credential, whatever the frame carries', () => {
    const ledger = createBridgeFrameLedger();
    ledger.record({ type: 'ROTATE', protocolVersion: PROTOCOL_VERSION, instanceId: 'ctl1', storageName: STORAGE_NAME, generation: 1, messageId: 'm1', accountRef: 'kimi:u1', token: token(1) });
    ledger.record({ type: 'COMMIT_ACK', protocolVersion: PROTOCOL_VERSION, instanceId: 'ctl1', storageName: STORAGE_NAME, generation: 1, messageId: 'm1' });
    const text = JSON.stringify(ledger.snapshot());
    for (const secret of ['acc_1', 'ref_1', 'm1', 'kimi:u1'])
        assert.equal(text.includes(secret), false, 'snapshot must not contain ' + secret);
});

test('C04-L4 the recent tail is bounded so a long-lived channel cannot grow', () => {
    const ledger = createBridgeFrameLedger(3);
    for (let i = 0; i < 10; i++) ledger.record({ type: 'HELLO', protocolVersion: PROTOCOL_VERSION, instanceId: 'ctl1', storageName: STORAGE_NAME });
    const snap = ledger.snapshot();
    assert.equal(snap.frames, 10);
    assert.equal(snap.counts.HELLO, 10);
    assert.equal(snap.recent.length, 3);
});
// C04-U: a write that landed but cannot be verified is an UNKNOWN durable outcome. It must be named
// as such, and it must still produce no ACK — the peer may not believe the token was saved.
test('C04-U1 an unverifiable write is reported as AUTH_COMMIT_UNCERTAIN and never ACKed', async () => {
    // The store accepts the first (seed) write and silently ignores the next one.
    let writes = 0, record = null;
    const silent = {
        async save(_n, v) { writes += 1; if (writes === 1) record = structuredClone(v); },
        async load() { return record ?? undefined; },
        async loadRecord() { return record == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(record) }; },
        async remove() { record = null; },
        async list() { return record ? ['kimi-code'] : []; }
    };
    const ctx = await rig({ store: silent, seed: token(1) });
    await ctx.controller.start();
    ctx.spawn.child.stdoutFrame(frame({ generation: 2, messageId: 'm2', token: token(2) }));
    await new Promise(r => setTimeout(r, 10));
    const sent = ctx.sentFrames();
    assert.equal(sent.some(f => f.type === 'COMMIT_ACK'), false, 'no ACK for an unverified write');
    assert.equal(sent.find(f => f.type === 'ERROR').code, 'KIMI_AUTH_COMMIT_UNCERTAIN');
});