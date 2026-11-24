import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ORCA_PIN, normalizeWorkerState, assertNotAcceptance, assertCursorUsable, assertClaimAllowed,
    assertTicketUsable, projectTaskForShadow, assertProjectionSafe
} from '../dist/server/orca/adapter.js';
import { createOperationOutbox } from '../dist/server/orca/outbox.js';

// A06 offline contract tests. Lives at tests/ top level because scripts/test.mjs only collects
// tests/*.test.mjs — a nested file would silently never run in the standard regression.
// A06 offline contract tests. No Orca process, no CLI, no socket: this is the adapter's own logic.
// Passing here means ADAPTER_IMPLEMENTED_NATIVE_NOT_RUN, never a native integration.

const NOW = Date.parse('2026-10-18T00:00:00.000Z');
const ticket = (over = {}) => ({
    schemaVersion: 1, projectId: 'p1', runId: 'r1', taskId: 't1', attemptId: 'a1', operationId: 'op1', role: 'executor',
    baseTreeHash: 'b', specHash: 's', planHash: 'pl', allowedPathSetHash: 'ap', verifierPlanHash: 'vp',
    runnerConfigHash: 'rc', policyHash: 'po', budgetReservationId: 'br1', leaseGeneration: 1,
    expiresAt: new Date(NOW + 60_000).toISOString(), ...over
});
const ctx = (over = {}) => ({ now: NOW, claimed: new Set(), leaseGeneration: 1, ...over });

test('A06-1 the pin is exact and its signature status is honest', () => {
    assert.equal(ORCA_PIN.version, '1.4.229');
    assert.equal(ORCA_PIN.commit, 'a0cd1644f320f1327f7495650a816111b495f3cd');
    assert.equal(ORCA_PIN.tagObject, 'a3fdce0977b75dc3777439df6d3b928ad4d911cf');
    assert.equal(ORCA_PIN.signature, 'UNSIGNED_TAG');
});

test('A06-2 only worker_done-shaped statuses become a pending report, never an acceptance', () => {
    assert.equal(normalizeWorkerState({ status: 'ready' }), 'READY');
    assert.equal(normalizeWorkerState({ status: 'working' }), 'RUNNING');
    assert.equal(normalizeWorkerState({ status: 'worker_done' }), 'REPORT_PENDING_VERIFICATION');
    assert.equal(normalizeWorkerState({ status: 'failed' }), 'FAILED_CANDIDATE');
    assert.equal(normalizeWorkerState({ status: 'some_new_word' }), 'UNKNOWN');
    assert.equal(normalizeWorkerState({}), 'UNKNOWN');
    assert.throws(() => assertNotAcceptance({ dispatchId: 'd', lifecycle: 'REPORT_PENDING_VERIFICATION', terminalResourceState: 'released' }), { code: 'ORCA_REPORT_IS_NOT_ACCEPTANCE' });
    assert.throws(() => assertNotAcceptance({ dispatchId: 'd', lifecycle: 'READY', terminalResourceState: 'unknown' }), { code: 'ORCA_REPORT_IS_NOT_ACCEPTANCE' });
});

test('A06-3 a stop request is only a request, and exit 0 never proves release', () => {
    assert.equal(normalizeWorkerState({ status: 'working', stopRequested: true }), 'CANCEL_REQUESTED');
    // release exit 0 may still be retained/release_pending: that is a resource fact, not this API.
    const observation = { dispatchId: 'd', lifecycle: normalizeWorkerState({ status: 'worker_done' }), terminalResourceState: 'release_pending' };
    assert.equal(observation.terminalResourceState, 'release_pending');
    assert.throws(() => assertNotAcceptance(observation), { code: 'ORCA_REPORT_IS_NOT_ACCEPTANCE' });
});

test('A06-4 a cursor is refused when the source changed or is empty', () => {
    assert.doesNotThrow(() => assertCursorUsable({ source: 'auto', value: 'c1' }, 'auto'));
    assert.throws(() => assertCursorUsable({ source: 'auto', value: 'c1' }, 'terminal'), { code: 'ORCA_CURSOR_SOURCE_CHANGED' });
    assert.throws(() => assertCursorUsable(undefined, 'auto'), { code: 'ORCA_CURSOR_MISSING' });
    assert.throws(() => assertCursorUsable({ source: 'auto', value: '' }, 'auto'), { code: 'ORCA_CURSOR_INVALID' });
});

test('A06-5 a fenced consumer cannot keep claiming', () => {
    assert.doesNotThrow(() => assertClaimAllowed({ consumerFenced: false }));
    assert.throws(() => assertClaimAllowed({ consumerFenced: true }), { code: 'ORCA_CONSUMER_FENCED' });
});

test('A06-6 a valid ticket is usable exactly once', () => {
    assert.doesNotThrow(() => assertTicketUsable(ticket(), ctx()));
    assert.throws(() => assertTicketUsable(ticket(), ctx({ claimed: new Set(['op1']) })), { code: 'ORCA_TICKET_ALREADY_CLAIMED' });
});

test('A06-7 tickets cannot be widened, expired, stale or re-roled', () => {
    assert.throws(() => assertTicketUsable(ticket({ role: 'planner2' }), ctx()), { code: 'ORCA_TICKET_ROLE' });
    assert.throws(() => assertTicketUsable(ticket({ planHash: '' }), ctx()), { code: 'ORCA_TICKET_INCOMPLETE' });
    assert.throws(() => assertTicketUsable(ticket({ expiresAt: new Date(NOW - 1).toISOString() }), ctx()), { code: 'ORCA_TICKET_EXPIRED' });
    assert.throws(() => assertTicketUsable(ticket({ expiresAt: 'later' }), ctx()), { code: 'ORCA_TICKET_EXPIRY_INVALID' });
    assert.throws(() => assertTicketUsable(ticket({ leaseGeneration: 2 }), ctx()), { code: 'ORCA_TICKET_LEASE_STALE' });
    assert.throws(() => assertTicketUsable(ticket({ schemaVersion: 2 }), ctx()), { code: 'ORCA_TICKET_SCHEMA' });
});

test('A06-8 the SHADOW projection carries shape but no prompt, path, command or token', () => {
    const projection = projectTaskForShadow({
        projectId: 'p1', runId: 'r1', taskId: 't1', phase: 'SPEC_REVIEW', lifecycle: 'RUNNING',
        requiredRequirementIds: ['R1', 'R2'], exclusiveResources: ['package.json'], specHash: 's', planHash: 'pl'
    });
    assert.deepEqual(projection.requiredRequirementIds, ['R1', 'R2']);
    assert.equal(JSON.stringify(projection).includes('prompt'), false);
    assert.throws(() => assertProjectionSafe({ nested: { token: 'x' } }), { code: 'ORCA_PROJECTION_LEAK' });
    assert.throws(() => assertProjectionSafe([{ path: '/secret' }]), { code: 'ORCA_PROJECTION_LEAK' });
});

test('A06-9 the outbox refuses a second launch for the same operation', () => {
    const box = createOperationOutbox();
    box.begin('op1', 'br1');
    assert.throws(() => box.begin('op1', 'br1'), { code: 'ORCA_OPERATION_DUPLICATE' });
    box.recordDispatched('op1', 'disp_1');
    assert.equal(box.get('op1').state, 'DISPATCHED');
});

test('A06-10 an unknown outcome keeps the fence and blocks re-dispatch', () => {
    const box = createOperationOutbox();
    box.begin('op2', 'br2');
    box.markOutcomeUnknown('op2', 'response lost');
    const record = box.get('op2');
    assert.equal(record.state, 'OUTCOME_UNKNOWN');
    assert.equal(record.budgetReservationId, 'br2', 'worst-case reservation is retained');
    assert.throws(() => box.recordDispatched('op2', 'disp_late'), { code: 'ORCA_OPERATION_OUTCOME_UNKNOWN' });
    assert.throws(() => box.complete('op2'), { code: 'ORCA_OPERATION_OUTCOME_UNKNOWN' });
});

test('A06-11 a changed dispatch id or a terminal record cannot be reused', () => {
    const box = createOperationOutbox();
    box.begin('op3', 'br3');
    box.recordDispatched('op3', 'disp_a');
    assert.throws(() => box.recordDispatched('op3', 'disp_b'), { code: 'ORCA_DISPATCH_ID_CHANGED' });
    box.complete('op3');
    assert.throws(() => box.recordDispatched('op3', 'disp_a'), { code: 'ORCA_OPERATION_TERMINAL' });
    assert.throws(() => box.markOutcomeUnknown('op3', 'late'), { code: 'ORCA_OPERATION_TERMINAL' });
});

test('A06-12 fencing is a state, and an unknown operation is not silently created', () => {
    const box = createOperationOutbox();
    box.begin('op4', 'br4');
    assert.equal(box.fence('op4').state, 'FENCED');
    assert.throws(() => box.recordDispatched('op4', 'disp'), { code: 'ORCA_OPERATION_TERMINAL' });
    assert.throws(() => box.get('nope').state, TypeError);
    assert.throws(() => box.complete('nope'), { code: 'ORCA_OPERATION_UNKNOWN' });
});