import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAtomicCommitAllowed, assertRunDeliveryAllowed } from '../dist/server/commit-guard.js';

const receipt = () => ({ turnId: 'turn_synthetic_1', reason: 'completed', answerChars: 12, answerHash: 'a'.repeat(64) });
const base = () => ({ receipt: receipt(), expectedVersion: 3, currentVersion: 3, expectedOwner: 'run-1', currentOwner: 'run-1', cancelledAfterAnswer: false });

test('K05-C1 a fully consistent precondition passes', () => {
    assert.doesNotThrow(() => assertAtomicCommitAllowed(base()));
});

test('K05-C2 missing or non-completed receipt never commits', () => {
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), receipt: null }), { code: 'KIMI_TURN_INCOMPLETE' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), receipt: { ...receipt(), reason: 'cancelled' } }), { code: 'KIMI_TURN_NOT_COMPLETED' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), receipt: { ...receipt(), reason: 'failed' } }), { code: 'KIMI_TURN_NOT_COMPLETED' });
});

test('K05-C3 a forged or malformed receipt is refused', () => {
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), receipt: { ...receipt(), turnId: '' } }), { code: 'KIMI_TURN_ID_MISSING' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), receipt: { ...receipt(), turnId: 'bad turn id' } }), { code: 'KIMI_TURN_ID_MISSING' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), receipt: { ...receipt(), answerHash: 'not-a-hash' } }), { code: 'KIMI_ANSWER_HASH_INVALID' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), receipt: { ...receipt(), answerChars: -1 } }), { code: 'KIMI_ANSWER_SHAPE_INVALID' });
});

test('K05-C4 a stale version, a lost lease or a late cancel each block the write', () => {
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), currentVersion: 4 }), { code: 'COMMIT_VERSION_STALE' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), currentOwner: 'other-run' }), { code: 'COMMIT_LEASE_LOST' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), currentOwner: '' }), { code: 'COMMIT_LEASE_LOST' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), cancelledAfterAnswer: true }), { code: 'COMMIT_CANCELLED' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base(), expectedOwner: '' }), { code: 'COMMIT_LEASE_REQUIRED' });
});
test('K05-C5 the lease half is opt-out only when a caller states it holds no lease', () => {
    // Interviews never holds a workspace lease; Engine does. The default must stay strict.
    const base2 = { receipt: { turnId: 'turn_synthetic_1', reason: 'completed', answerChars: 5, answerHash: 'b'.repeat(64) }, expectedVersion: 1, currentVersion: 1, expectedOwner: '', currentOwner: '', cancelledAfterAnswer: false };
    assert.throws(() => assertAtomicCommitAllowed(base2), { code: 'COMMIT_LEASE_REQUIRED' });
    assert.doesNotThrow(() => assertAtomicCommitAllowed(base2, { leaseRequired: false }));
    assert.throws(() => assertAtomicCommitAllowed({ ...base2, cancelledAfterAnswer: true }, { leaseRequired: false }), { code: 'COMMIT_CANCELLED' });
    assert.throws(() => assertAtomicCommitAllowed({ ...base2, currentVersion: 2 }, { leaseRequired: false }), { code: 'COMMIT_VERSION_STALE' });
});
test('K05-C6 run delivery is refused when cancelled, lease-less or the tree moved', () => {
    const ok = { leaseHeld: true, cancelled: false, treeHashStable: true };
    assert.doesNotThrow(() => assertRunDeliveryAllowed(ok));
    assert.throws(() => assertRunDeliveryAllowed({ ...ok, cancelled: true }), { code: 'COMMIT_CANCELLED' });
    assert.throws(() => assertRunDeliveryAllowed({ ...ok, leaseHeld: false }), { code: 'COMMIT_LEASE_LOST' });
    assert.throws(() => assertRunDeliveryAllowed({ ...ok, treeHashStable: false }), { code: 'COMMIT_TREE_CHANGED' });
});
