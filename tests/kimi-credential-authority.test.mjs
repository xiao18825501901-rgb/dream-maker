import test from 'node:test';
import assert from 'node:assert/strict';
import { createKimiCredentialAuthority, expiresAtMs } from '../dist/server/kimi-credential-authority.js';

// C03 synthetic tests: durable credentials, RESTORE barrier, ACK semantics, revocation.
// No DPAPI, no WSL, no network, no Kimi process — the store below is an in-memory stand-in that
// behaves like a file (including failure injection), so these cover the state machine, not the OS.

const token = (n = 1) => ({
    accessToken: 'acc_' + n, refreshToken: 'ref_' + n, expiresAt: 1_700_000_000_000 + n,
    expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer'
});

function fakeStore(initial = null, { failWrite = false, corrupt = false, failRead = false } = {}) {
    let record = initial;
    const writes = [];
    return {
        writes,
        async save(_name, value) {
            if (failWrite) throw new Error('disk full');
            writes.push(structuredClone(value));
            record = structuredClone(value);
        },
        async load() { return record ?? undefined; },
        async loadRecord() {
            if (failRead) throw new Error('EIO');
            if (corrupt) return { status: 'CORRUPT', reason: 'DECRYPT_FAILED' };
            if (record == null) return { status: 'MISSING' };
            return { status: 'OK', record: structuredClone(record) };
        },
        async remove() { record = null; },
        async list() { return record ? ['kimi-code'] : []; },
        peek: () => record
    };
}
const authority = (store, clock = () => 1_700_000_000_000) => createKimiCredentialAuthority({ store, clock });

test('C03-1 nothing may read a token before the RESTORE barrier lifts', async () => {
    const store = fakeStore();
    const a = authority(store);
    assert.equal(a.barrier(), 'NOT_STARTED');
    assert.throws(() => a.requireToken(), { code: 'KIMI_RESTORE_NOT_READY' });
    await a.restore();
    assert.equal(a.barrier(), 'READY');
    assert.throws(() => a.requireToken(), { code: 'KIMI_CREDENTIALS_MISSING' });
});

test('C03-2 a corrupt ciphertext is CORRUPT, never "first login"', async () => {
    const a = authority(fakeStore(null, { corrupt: true }));
    const state = await a.restore();
    assert.equal(state.status, 'CORRUPT');
    assert.equal(a.barrier(), 'FAILED');
    assert.throws(() => a.requireToken(), { code: 'KIMI_STORED_STATE_CORRUPT' });
});

test('C03-3 a restore that cannot read at all fails loudly and keeps the state unknown', async () => {
    const a = authority(fakeStore(null, { failRead: true }));
    const state = await a.restore();
    assert.equal(state.status, 'CORRUPT');
    assert.equal(a.barrier(), 'FAILED');
});

test('C03-4 a commit persists the complete TokenInfo and returns an ACK', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    const ack = await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    assert.deepEqual(ack, { ack: true, generation: 1, messageId: 'm1', replay: false });
    const saved = store.peek();
    for (const field of ['accessToken', 'refreshToken', 'expiresAt', 'expiresIn', 'scope', 'tokenType'])
        assert.ok(field in saved, 'persisted record keeps ' + field);
    assert.deepEqual(a.requireToken(), token(1));
});

test('C03-5 an incomplete token is refused (access token alone is not a credential)', async () => {
    const a = authority(fakeStore());
    await a.restore();
    for (const broken of [{ accessToken: 'a' }, { ...token(1), refreshToken: '' }, { ...token(1), expiresAt: 'soon' }, { ...token(1), tokenType: '' }])
        await assert.rejects(a.commit({ token: broken, generation: 1, messageId: 'm1' }), { code: 'KIMI_TOKEN_INCOMPLETE' });
});

test('C03-6 a failed write produces no ACK and does not advance the generation', async () => {
    const store = fakeStore(null, { failWrite: true });
    const a = authority(store);
    await a.restore();
    await assert.rejects(a.commit({ token: token(1), generation: 1, messageId: 'm1' }), { code: 'KIMI_TOKEN_PERSIST_FAILED' });
    assert.equal(a.current().status, 'MISSING');
    assert.equal(store.writes.length, 0);
});

test('C03-7 replaying the same messageId confirms the commit without writing again', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    const replay = await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    assert.equal(replay.replay, true);
    assert.equal(store.writes.length, 1, 'a lost ACK must not trigger a second upstream rotation');
});

test('C03-8 stale, skipped or reused generations are refused', async () => {
    const a = authority(fakeStore());
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    await assert.rejects(a.commit({ token: token(2), generation: 1, messageId: 'm2' }), { code: 'KIMI_ROTATE_GENERATION_STALE' });
    await assert.rejects(a.commit({ token: token(2), generation: 3, messageId: 'm3' }), { code: 'KIMI_ROTATE_GENERATION_SKIPPED' });
    await assert.rejects(a.commit({ token: token(2), generation: 2, messageId: 'm1' }), { code: 'KIMI_ROTATE_REPLAY_MISMATCH' });
});

test('C03-9 a restart restores the committed token without any device flow', async () => {
    const store = fakeStore();
    const first = authority(store);
    await first.restore();
    await first.commit({ token: token(1), generation: 1, messageId: 'm1' });

    // Second process: same store, fresh object, no login.
    const second = authority(store);
    const state = await second.restore();
    assert.equal(state.status, 'OK');
    assert.deepEqual(second.requireToken(), token(1));
    assert.equal(second.barrier(), 'READY');
});

test('C03-10 a revoked tombstone is a legitimate state, not an incomplete token', async () => {
    const a = authority(fakeStore());
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    const ack = await a.revoke({ generation: 2, messageId: 'm2', scope: 'kimi-code' });
    assert.deepEqual(ack, { ack: true, generation: 2, messageId: 'm2', replay: false });
    assert.equal(a.current().status, 'REVOKED');
    assert.throws(() => a.requireToken(), { code: 'KIMI_CREDENTIAL_REVOKED' });
});

test('C03-11 a revoke restores as REVOKED after a restart, and empty tokens are preserved', async () => {
    const store = fakeStore();
    const first = authority(store);
    await first.restore();
    await first.commit({ token: token(1), generation: 1, messageId: 'm1' });
    await first.revoke({ generation: 2, messageId: 'm2' });
    const second = authority(store);
    const state = await second.restore();
    assert.equal(state.status, 'REVOKED');
    assert.equal(state.generation, 2);
    assert.throws(() => second.requireToken(), { code: 'KIMI_CREDENTIAL_REVOKED' });
});

test('C03-12 a late logout cannot delete a newer login generation', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    await a.commit({ token: token(2), generation: 2, messageId: 'm2' });
    const late = await a.logout({ generation: 1 });
    assert.deepEqual(late, { removed: false, ignored: true });
    assert.equal(a.current().status, 'OK');
    assert.deepEqual(a.requireToken(), token(2));
    const fresh = await a.logout({ generation: 2 });
    assert.deepEqual(fresh, { removed: true, ignored: false });
    assert.equal(a.current().status, 'MISSING');
});

test('C03-13 commits are refused until RESTORE has run for this instance', async () => {
    const a = authority(fakeStore());
    await assert.rejects(a.commit({ token: token(1), generation: 1, messageId: 'm1' }), { code: 'KIMI_RESTORE_NOT_READY' });
});
test('C03-14 the upstream expiresAt is in seconds and must not be compared as milliseconds', () => {
    const seconds = { expiresAt: 1_790_520_037 };
    assert.equal(expiresAtMs(seconds), 1_790_520_037_000);
    assert.ok(new Date(expiresAtMs(seconds)).getUTCFullYear() >= 2026, 'a live token must not decode to 1970');
    assert.equal(expiresAtMs({ expiresAt: 1_790_520_037_000 }), 1_790_520_037_000);
    assert.equal(expiresAtMs({ expiresAt: 0 }), 0);
});
// C03 revocation durability. A revoke had a weaker contract than a commit: it ACKed without a
// read-back and without an idempotent replay path, so a dropped ACK could leave the peer believing
// the revocation was rejected while the tombstone was already durable. These pin the parity.
test('C03-15 replaying the same revoke confirms it without writing again', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    const first = await a.revoke({ generation: 2, messageId: 'm2' });
    assert.deepEqual(first, { ack: true, generation: 2, messageId: 'm2', replay: false });
    const writesAfterFirst = store.writes.length;
    const replay = await a.revoke({ generation: 2, messageId: 'm2' });
    assert.deepEqual(replay, { ack: true, generation: 2, messageId: 'm2', replay: true });
    assert.equal(store.writes.length, writesAfterFirst, 'a replay must not rewrite the tombstone');
    assert.equal(a.current().status, 'REVOKED');
});

test('C03-16 a revoke cannot be forged from another generation or from a login id', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    // Same id as the commit: that id belongs to a login, not to a revocation.
    await assert.rejects(a.revoke({ generation: 1, messageId: 'm1' }), { code: 'KIMI_ROTATE_REPLAY_MISMATCH' });
    await a.revoke({ generation: 2, messageId: 'm2' });
    // Same id, different generation: two different facts under one identity.
    await assert.rejects(a.revoke({ generation: 3, messageId: 'm2' }), { code: 'KIMI_ROTATE_REPLAY_MISMATCH' });
    assert.equal(a.current().generation, 2);
});

test('C03-17 a failed revoke write keeps the usable credential and returns no ACK', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    const failing = { ...store, async save() { throw new Error('disk full'); } };
    const b = authority(failing);
    await b.restore();
    await assert.rejects(b.revoke({ generation: 2, messageId: 'm2' }), { code: 'KIMI_TOKEN_PERSIST_FAILED' });
    assert.equal(b.current().status, 'OK', 'a failed revoke must not pretend the credential is gone');
    assert.deepEqual(b.requireToken(), token(1));
});

test('C03-18 a revoke that cannot be read back is unverified, not acknowledged', async () => {
    // A store whose write silently does nothing: the read-back is the only proof, exactly as for commit.
    let record = null;
    const silent = {
        async save(_name, value) { if (record === null) record = structuredClone(value); },
        async load() { return record ?? undefined; },
        async loadRecord() { return record == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(record) }; },
        async remove() { record = null; },
        async list() { return record ? ['kimi-code'] : []; }
    };
    const a = authority(silent);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    await assert.rejects(a.revoke({ generation: 2, messageId: 'm2' }), { code: 'KIMI_TOKEN_PERSIST_UNVERIFIED' });
    assert.equal(a.current().status, 'OK');
});

test('C03-19 a skipped revoke generation asks for reconciliation instead of guessing', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    await assert.rejects(a.revoke({ generation: 3, messageId: 'm3' }), { code: 'KIMI_ROTATE_GENERATION_SKIPPED' });
    assert.equal(a.current().status, 'OK');
});
test('C03-20 a logout before RESTORE cannot delete a credential this process never read', async () => {
    const store = fakeStore();
    const seed = authority(store);
    await seed.restore();
    await seed.commit({ token: token(1), generation: 1, messageId: 'm1' });
    const fresh = authority(store);
    assert.equal(fresh.barrier(), 'NOT_STARTED');
    await assert.rejects(fresh.logout({ generation: 1 }), { code: 'KIMI_RESTORE_NOT_READY' });
    assert.notEqual(store.peek(), null, 'the durable record must survive a pre-restore logout');
    // After the barrier lifts, the same logout is legitimate and does remove it.
    await fresh.restore();
    assert.deepEqual(await fresh.logout({ generation: 1 }), { removed: true, ignored: false });
    assert.equal(store.peek(), null);
});

test('C03-21 a logout with an unusable generation is refused, not guessed', async () => {
    const store = fakeStore();
    const a = authority(store);
    await a.restore();
    await a.commit({ token: token(1), generation: 1, messageId: 'm1' });
    for (const generation of [0, -1, 1.5, Number.NaN]) {
        await assert.rejects(a.logout({ generation }), { code: 'KIMI_GENERATION_INVALID' }, String(generation));
    }
    assert.equal(a.current().status, 'OK');
});
// The record format gained savedAtMs in round 150. A store written before that change must still
// restore as OK (savedAtMs null), otherwise an existing user's credential silently turns CORRUPT.
test('C03-22 a record written before savedAt existed still restores as OK', async () => {
    const legacy = {
        accessToken: 'acc_1', refreshToken: 'ref_1', expiresAt: 1_700_000_000_000,
        expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer',
        __dm: { status: 'OK', generation: 3, messageId: 'm3' }
    };
    const store = fakeStore(structuredClone(legacy));
    const a = authority(store);
    const state = await a.restore();
    assert.equal(state.status, 'OK', 'a missing savedAt must not be read as corruption');
    assert.equal(state.generation, 3);
    assert.equal(state.savedAtMs, null);
    assert.deepEqual(a.requireToken(), { accessToken: 'acc_1', refreshToken: 'ref_1', expiresAt: 1_700_000_000_000, expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer' });
    // A fresh commit writes the timestamp, so the record becomes retirable by a later login.
    await a.commit({ token: token(2), generation: 4, messageId: 'm4' });
    assert.equal(typeof a.current().savedAtMs, 'number');
});
