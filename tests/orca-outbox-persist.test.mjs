import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistentOperationOutbox } from '../dist/server/orca/outbox-persist.js';

// C07: an outbox that forgets on restart cannot prevent a duplicate launch. The "disk" here is a
// string, so a restart is simply a second factory call over the same store.

function disk(initial) {
    let value = initial;
    return {
        read: () => value,
        write: s => { value = s; },
        peek: () => value
    };
}

test('C07-1 records survive a restart and the file is the source of truth', () => {
    const d = disk(undefined);
    const first = createPersistentOperationOutbox(d);
    first.begin('op1', 'br1');
    first.recordDispatched('op1', 'disp_1');
    assert.equal(d.peek().includes('disp_1'), true);

    const second = createPersistentOperationOutbox(d);
    const restored = second.get('op1');
    assert.equal(restored.state, 'DISPATCHED');
    assert.equal(restored.dispatchId, 'disp_1');
    assert.equal(restored.budgetReservationId, 'br1');
});

test('C07-2 a restart cannot re-launch an operation that is already recorded', () => {
    const d = disk(undefined);
    const first = createPersistentOperationOutbox(d);
    first.begin('op1', 'br1');
    const second = createPersistentOperationOutbox(d);
    assert.throws(() => second.begin('op1', 'br1'), { code: 'ORCA_OPERATION_DUPLICATE' });
});

test('C07-3 an unknown outcome stays fenced and keeps its reservation across a restart', () => {
    const d = disk(undefined);
    const first = createPersistentOperationOutbox(d);
    first.begin('op2', 'br2');
    first.markOutcomeUnknown('op2', 'response lost');
    const second = createPersistentOperationOutbox(d);
    const record = second.get('op2');
    assert.equal(record.state, 'OUTCOME_UNKNOWN');
    assert.equal(record.budgetReservationId, 'br2');
    assert.throws(() => second.recordDispatched('op2', 'disp_late'), { code: 'ORCA_OPERATION_OUTCOME_UNKNOWN' });
    assert.throws(() => second.complete('op2'), { code: 'ORCA_OPERATION_OUTCOME_UNKNOWN' });
});

test('C07-4 a corrupt outbox is a hard error, not an empty outbox', () => {
    for (const bad of ['not json', '{"records":{}}', '{"records":[{"operationId":1}]}']) {
        assert.throws(() => createPersistentOperationOutbox(disk(bad)), { code: 'ORCA_OUTBOX_CORRUPT' });
    }
});

test('C07-5 terminal states round-trip (COMPLETED and FENCED)', () => {
    const d = disk(undefined);
    const first = createPersistentOperationOutbox(d);
    first.begin('op3', 'br3');
    first.recordDispatched('op3', 'disp_3');
    first.complete('op3');
    first.begin('op4', 'br4');
    first.fence('op4');
    const second = createPersistentOperationOutbox(d);
    assert.equal(second.get('op3').state, 'COMPLETED');
    assert.equal(second.get('op4').state, 'FENCED');
    assert.throws(() => second.recordDispatched('op3', 'disp_3'), { code: 'ORCA_OPERATION_TERMINAL' });
});
