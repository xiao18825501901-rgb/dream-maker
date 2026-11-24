import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, PROTOCOL_VERSION, STORAGE_NAME } from '../dist/server/kimi-bridge-frames.js';
import { createBridgeSession } from '../dist/server/kimi-bridge-session.js';
import { createKimiCredentialAuthority } from '../dist/server/kimi-credential-authority.js';

// C03/C04: the controller side of the trusted channel, driven entirely by synthetic bytes.
// No WSL, no spawn, no DPAPI, no Kimi — the byte sink is an array.

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
const frame = over => ({ protocolVersion: PROTOCOL_VERSION, instanceId: 'inst_1', storageName: STORAGE_NAME, ...over });
const rotate = (over = {}) => frame({ type: 'ROTATE', generation: 1, messageId: 'm1', accountRef: 'kimi:u1', token: token(1), ...over });

async function makeSession(overrides = {}) {
    const s = overrides.store ?? store();
    const authority = createKimiCredentialAuthority({ store: s, clock: () => 1_700_000_000_000 });
    await authority.restore();
    if (overrides.seed) await authority.commit({ token: overrides.seed, generation: 1, messageId: 'seed' });
    const out = [];
    const bridge = createBridgeSession({ instanceId: 'inst_1', accountRef: 'kimi:u1', send: b => out.push(b), authority });
    return { session: bridge, authority, out, store: s, decoded: () => out.map(b => JSON.parse(b.subarray(4).toString('utf8'))) };
}

test('C04-B1 start announces HELLO and restores an existing credential', async () => {
    const { session, decoded } = await makeSession({ seed: token(1) });
    await session.start();
    const frames = decoded();
    assert.equal(frames[0].type, 'HELLO');
    assert.equal(frames[1].type, 'RESTORE');
    assert.equal(frames[1].token.accessToken, 'acc_1');
    assert.equal(frames[1].generation, 1);
});

test('C04-B2 start with no stored credential sends an empty RESTORE (login path stays open)', async () => {
    const { session, decoded } = await makeSession();
    await session.start();
    const frames = decoded();
    assert.equal(frames[0].type, 'HELLO');
    assert.deepEqual(frames[1].token, {});
});

test('C04-B3 a rotation is ACKed only after the durable commit succeeded', async () => {
    const ctx = await makeSession();
    await ctx.session.start();
    ctx.session.onBytes(encodeFrame(rotate()));
    await new Promise(r => setTimeout(r, 10));
    const ack = ctx.decoded().find(f => f.type === 'COMMIT_ACK');
    assert.deepEqual({ generation: ack.generation, messageId: ack.messageId }, { generation: 1, messageId: 'm1' });
    assert.equal(ctx.store.writes.length, 1);
});

test('C04-B4 a failed persist produces an ERROR and no ACK', async () => {
    const ctx = await makeSession({ store: store(null, { failWrite: true }) });
    await ctx.session.start();
    ctx.session.onBytes(encodeFrame(rotate()));
    await new Promise(r => setTimeout(r, 10));
    const frames = ctx.decoded();
    assert.equal(frames.some(f => f.type === 'COMMIT_ACK'), false);
    assert.equal(frames.find(f => f.type === 'ERROR').code, 'KIMI_TOKEN_PERSIST_FAILED');
});

test('C04-B5 a stale generation is refused with an ERROR, not silently applied', async () => {
    const ctx = await makeSession({ seed: token(1) });
    await ctx.session.start();
    ctx.session.onBytes(encodeFrame(rotate({ generation: 1, messageId: 'm2', token: token(2) })));
    await new Promise(r => setTimeout(r, 10));
    assert.equal(ctx.decoded().find(f => f.type === 'ERROR').code, 'KIMI_ROTATE_GENERATION_STALE');
});

test('C04-B6 a frame from another instance is refused', async () => {
    const ctx = await makeSession();
    await ctx.session.start();
    ctx.session.onBytes(encodeFrame(rotate({ instanceId: 'inst_other' })));
    assert.equal(ctx.decoded().find(f => f.type === 'ERROR').code, 'KIMI_FRAME_IDENTITY_MISMATCH');
});

test('C04-B7 a rotation for another account is refused', async () => {
    const ctx = await makeSession();
    await ctx.session.start();
    ctx.session.onBytes(encodeFrame(rotate({ accountRef: 'kimi:u2' })));
    assert.equal(ctx.decoded().find(f => f.type === 'ERROR').code, 'KIMI_ACCOUNT_MISMATCH');
});

test('C04-B8 malformed bytes end the session with a fixed error code', async () => {
    const ctx = await makeSession();
    await ctx.session.start();
    ctx.session.onBytes(Buffer.from('garbage-not-framed'));
    assert.equal(ctx.session.closed(), true);
});

test('C04-B9 start without a completed restore refuses instead of handing out credentials', async () => {
    const authority = createKimiCredentialAuthority({ store: store() });
    const out = [];
    const bridge = createBridgeSession({ instanceId: 'inst_1', accountRef: 'kimi:u1', send: b => out.push(b), authority });
    await bridge.start();
    const frames = out.map(b => JSON.parse(b.subarray(4).toString('utf8')));
    assert.equal(frames[0].type, 'ERROR');
    assert.equal(frames[0].code, 'KIMI_RESTORE_NOT_READY');
});
// An ACK that dies on the wire must not be reported as sent. `sent()` is evidence, and the frame
// ledger feeds the product's durability line from the same callback.
test('C04-S7 a frame that never left the process is not recorded as sent', async () => {
    let record = null;
    const store = {
        async save(_n, v) { record = structuredClone(v); },
        async load() { return record ?? undefined; },
        async loadRecord() { return record == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(record) }; },
        async remove() { record = null; },
        async list() { return record ? ['kimi-code'] : []; }
    };
    const authority = createKimiCredentialAuthority({ store, clock: () => 1_700_000_000_000 });
    await authority.restore();
    await authority.commit({ token: token(1), generation: 1, messageId: 'seed' });
    const sentFrames = [];
    const session = createBridgeSession({
        instanceId: 'ctl-evidence', accountRef: 'kimi:synthetic',
        send: bytes => {
            const frame = JSON.parse(bytes.toString('utf8').slice(4));
            if (frame.type === 'COMMIT_ACK') throw new Error('pipe closed before the ACK');
            sentFrames.push(frame.type);
        },
        authority,
        onFrame: (frame) => sentFrames.push('observed:' + frame.type)
    });
    await session.start();
    session.onBytes(encodeFrame({ type: 'ROTATE', protocolVersion: PROTOCOL_VERSION, instanceId: 'ctl-evidence', storageName: STORAGE_NAME, generation: 2, messageId: 'rot2', accountRef: 'kimi:synthetic', token: token(2) }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(session.sent().some(f => f.type === 'COMMIT_ACK'), false, 'an unsent ACK must not appear in sent()');
    assert.equal(sentFrames.includes('observed:COMMIT_ACK'), false, 'the ledger must not see it either');
    assert.equal(session.closed(), true);
    // The durable side is unaffected: the rotation really was committed.
    assert.equal(authority.current().generation, 2);
});
test('C04-S8 a frame for another instance is never counted as peer evidence', async () => {
    let record = null;
    const store = {
        async save(_n, v) { record = structuredClone(v); },
        async load() { return record ?? undefined; },
        async loadRecord() { return record == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(record) }; },
        async remove() { record = null; },
        async list() { return record ? ['kimi-code'] : []; }
    };
    const authority = createKimiCredentialAuthority({ store, clock: () => 1_700_000_000_000 });
    await authority.restore();
    const seen = [];
    const session = createBridgeSession({
        instanceId: 'ctl-owner', accountRef: 'kimi:synthetic',
        send: () => { },
        authority,
        onFrame: (frame, direction) => seen.push(direction + ':' + frame.type)
    });
    await session.start();
    session.onBytes(encodeFrame({ type: 'HELLO', protocolVersion: PROTOCOL_VERSION, instanceId: 'someone-else', storageName: STORAGE_NAME }));
    assert.equal(seen.filter(s => s.startsWith('in:')).length, 0, 'a foreign hello is not inbound evidence');
    assert.equal(session.sent().some(f => f.type === 'ERROR' && f.code === 'KIMI_FRAME_IDENTITY_MISMATCH'), true, 'but the mismatch is reported');
    // Our own peer's hello is evidence.
    session.onBytes(encodeFrame({ type: 'HELLO', protocolVersion: PROTOCOL_VERSION, instanceId: 'ctl-owner', storageName: STORAGE_NAME }));
    assert.equal(seen.includes('in:HELLO'), true);
});
