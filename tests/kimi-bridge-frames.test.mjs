import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROTOCOL_VERSION, FRAME_LIMIT, STORAGE_NAME, createFrameDecoder, createGenerationGate, encodeFrame
} from '../dist/server/kimi-bridge-frames.js';

// A02 synthetic channel tests. Everything here is synthetic: fake tokens, fake instance ids, no
// Kimi process, no network, no DPAPI. These cover the properties the plan calls out (碎帧/并帧/
// 过大/错namespace/倒退代数/并发save/ACK丢失), not the real Windows round trip.

const token = (n = 1) => ({ accessToken: 'acc_synthetic_' + n, refreshToken: 'ref_synthetic_' + n, expiresAt: 1_700_000_000_000 });
const rotate = (over = {}) => ({
    type: 'ROTATE', protocolVersion: PROTOCOL_VERSION, instanceId: 'inst_1', storageName: STORAGE_NAME,
    generation: 1, messageId: 'msg_1', accountRef: 'kimi:user_synthetic', token: token(1), ...over
});

test('A02-1 a frame round-trips and keeps the storage namespace', () => {
    const dec = createFrameDecoder();
    const frames = dec.push(encodeFrame(rotate()));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].storageName, 'kimi-code');
    assert.equal(frames[0].generation, 1);
    assert.equal(frames[0].token.accessToken, 'acc_synthetic_1');
    dec.finish();
});

test('A02-2 one frame split across many reads is reassembled', () => {
    const bytes = encodeFrame(rotate());
    const dec = createFrameDecoder();
    const seen = [];
    for (const chunk of bytes) seen.push(...dec.push(Buffer.from([chunk])));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].messageId, 'msg_1');
    dec.finish();
});

test('A02-3 several frames in one read are all returned in order', () => {
    const dec = createFrameDecoder();
    const frames = dec.push(Buffer.concat([encodeFrame(rotate({ messageId: 'm1' })), encodeFrame(rotate({ messageId: 'm2', generation: 2, token: token(2) }))]));
    assert.deepEqual(frames.map(f => f.messageId), ['m1', 'm2']);
    dec.finish();
});

test('A02-4 a token containing newlines and quotes survives the length prefix', () => {
    const messy = { accessToken: 'a"b\nc\\d', refreshToken: 'r\n"2', expiresAt: 1 };
    const dec = createFrameDecoder();
    const frames = dec.push(encodeFrame(rotate({ token: messy })));
    assert.deepEqual(frames[0].token, messy);
});

test('A02-5 an oversized frame is refused on encode and on decode', () => {
    const big = { type: 'ROTATE', protocolVersion: 1, instanceId: 'i', storageName: STORAGE_NAME, generation: 1, messageId: 'm', accountRef: 'kimi:u', token: { accessToken: 'x'.repeat(FRAME_LIMIT), refreshToken: 'y', expiresAt: 1 } };
    assert.throws(() => encodeFrame(big), { code: 'KIMI_FRAME_TOO_LARGE' });
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(FRAME_LIMIT + 1, 0);
    assert.throws(() => createFrameDecoder().push(oversized), { code: 'KIMI_FRAME_TOO_LARGE' });
});

test('A02-6 a truncated stream is a hard error, not a short token', () => {
    const bytes = encodeFrame(rotate());
    const dec = createFrameDecoder();
    dec.push(bytes.subarray(0, bytes.length - 5));
    assert.throws(() => dec.finish(), { code: 'KIMI_FRAME_TRUNCATED' });
});

test('A02-7 non-JSON body poisons the stream instead of being skipped', () => {
    const body = Buffer.from('not json', 'utf8');
    const frame = Buffer.concat([Buffer.from([0, 0, 0, body.length]), body]);
    assert.throws(() => createFrameDecoder().push(frame), { code: 'KIMI_FRAME_NOT_JSON' });
});

test('A02-8 a frame for another storage namespace is refused', () => {
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ storageName: 'managed:kimi-code' }))), { code: 'KIMI_FRAME_NAMESPACE_MISMATCH' });
});

test('A02-9 a wrong protocol version and an unknown type are refused', () => {
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ protocolVersion: 2 }))), { code: 'KIMI_FRAME_PROTOCOL_MISMATCH' });
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ type: 'PUSH' }))), { code: 'KIMI_FRAME_TYPE_UNKNOWN' });
});

test('A02-10 ROTATE without identity, generation, messageId or token is refused', () => {
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ instanceId: '' }))), { code: 'KIMI_FRAME_IDENTITY_MISSING' });
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ generation: 0 }))), { code: 'KIMI_FRAME_GENERATION_INVALID' });
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ messageId: '' }))), { code: 'KIMI_FRAME_MESSAGE_ID_MISSING' });
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ accountRef: '' }))), { code: 'KIMI_FRAME_ACCOUNT_MISSING' });
    assert.throws(() => createFrameDecoder().push(encodeFrame(rotate({ token: null }))), { code: 'KIMI_FRAME_TOKEN_INVALID' });
});

test('A02-11 a replayed ROTATE is idempotent; the same messageId with other content is not', () => {
    const gate = createGenerationGate();
    assert.equal(gate.accept(rotate()), 'COMMITTED');
    assert.equal(gate.accept(rotate()), 'IDEMPOTENT_REPLAY');
    assert.throws(() => gate.accept(rotate({ token: token(9) })), { code: 'KIMI_ROTATE_REPLAY_MISMATCH' });
    assert.deepEqual(gate.committed(), { ...gate.committed(), generation: 1, messageId: 'msg_1' });
});

test('A02-12 a stale generation cannot overwrite a newer token', () => {
    const gate = createGenerationGate();
    gate.accept(rotate({ generation: 2, messageId: 'm2', token: token(2) }));
    assert.throws(() => gate.accept(rotate({ generation: 1, messageId: 'm1' })), { code: 'KIMI_ROTATE_GENERATION_STALE' });
    assert.throws(() => gate.accept(rotate({ generation: 2, messageId: 'm3', token: token(3) })), { code: 'KIMI_ROTATE_GENERATION_STALE' });
});

test('A02-13 a skipped generation stops and asks for reconciliation', () => {
    const gate = createGenerationGate();
    gate.accept(rotate({ generation: 1, messageId: 'm1' }));
    assert.throws(() => gate.accept(rotate({ generation: 3, messageId: 'm3', token: token(3) })), { code: 'KIMI_ROTATE_GENERATION_SKIPPED' });
});

test('A02-14 a rotate without both token halves is refused (a tampered frame cannot half-commit)', () => {
    const gate = createGenerationGate();
    assert.throws(() => gate.accept(rotate({ token: { accessToken: 'only-access' } })), { code: 'KIMI_ROTATE_TOKEN_INCOMPLETE' });
    assert.equal(gate.committed(), undefined);
});

test('A02-15 serial commits advance generation and the gate reports the last one', () => {
    const gate = createGenerationGate();
    for (let n = 1; n <= 3; n++) assert.equal(gate.accept(rotate({ generation: n, messageId: 'm' + n, token: token(n) })), 'COMMITTED');
    assert.equal(gate.committed().generation, 3);
    assert.equal(gate.committed().messageId, 'm3');
});
