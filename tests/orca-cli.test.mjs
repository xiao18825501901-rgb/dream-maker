import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertAbsoluteBinary, orcaArgv, parseJsonAnswer, runOrca, parseWorkerRows, parseWorkerRead, ORCA_COMMANDS, MAX_OUTPUT_BYTES
} from '../dist/server/orca/cli.js';

// A06: the Orca CLI contract, entirely offline. The executor below is a recorder — no process runs,
// and no real Orca is installed. What is being pinned is the refusal surface.

const binary = 'C:\\Tools\\orca\\orca.exe';
const ok = payload => async ({ argv }) => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', argv });

test('A06-C1 only an absolute, whitespace-free binary is accepted', () => {
    assert.equal(assertAbsoluteBinary(binary), binary);
    assert.equal(assertAbsoluteBinary('/opt/orca/bin/orca'), '/opt/orca/bin/orca');
    assert.throws(() => assertAbsoluteBinary('orca'), { code: 'ORCA_BINARY_NOT_ABSOLUTE' });
    assert.throws(() => assertAbsoluteBinary(''), { code: 'ORCA_BINARY_NOT_ABSOLUTE' });
    assert.throws(() => assertAbsoluteBinary('C:\\Program Files\\orca.exe'), { code: 'ORCA_BINARY_INVALID' });
});

test('A06-C2 argv is literal tokens plus --json, and shell metacharacters are refused', () => {
    assert.deepEqual(orcaArgv(ORCA_COMMANDS.workerList, { '--run': 'run_1' }), ['orchestration', 'worker-list', '--run', 'run_1', '--json']);
    assert.deepEqual(orcaArgv(ORCA_COMMANDS.status), ['status', '--json']);
    assert.throws(() => orcaArgv(['status;rm']), { code: 'ORCA_ARGUMENT_INVALID' });
    assert.throws(() => orcaArgv(ORCA_COMMANDS.workerShow, { '--dispatch': 'a b' }), { code: 'ORCA_ID_INVALID' });
    assert.throws(() => orcaArgv(ORCA_COMMANDS.workerShow, { 'dispatch': 'x' }), { code: 'ORCA_FLAG_INVALID' });
    assert.throws(() => orcaArgv([]), { code: 'ORCA_SUBCOMMAND_REQUIRED' });
});

test('A06-C3 a non-zero exit, a timeout, an empty or non-JSON answer are all errors', () => {
    assert.throws(() => parseJsonAnswer({ code: 1, stdout: '{"ok":true}' }), { code: 'ORCA_CLI_FAILED' });
    assert.throws(() => parseJsonAnswer({ code: null, stdout: '', timedOut: true }), { code: 'ORCA_CLI_TIMEOUT' });
    assert.throws(() => parseJsonAnswer({ code: 0, stdout: '   ' }), { code: 'ORCA_OUTPUT_EMPTY' });
    assert.throws(() => parseJsonAnswer({ code: 0, stdout: 'not json' }), { code: 'ORCA_OUTPUT_NOT_JSON' });
    assert.deepEqual(parseJsonAnswer({ code: 0, stdout: '{"a":1}' }), { a: 1 });
});

test('A06-C4 an oversized answer is refused instead of being parsed as truncated JSON', () => {
    const huge = 'x'.repeat(MAX_OUTPUT_BYTES + 10);
    assert.throws(() => parseJsonAnswer({ code: 0, stdout: huge }), { code: 'ORCA_OUTPUT_TOO_LARGE' });
});

test('A06-C5 runOrca passes the pinned argv and never invents a --terminal process id', async () => {
    const calls = [];
    const result = await runOrca({
        binary, subcommand: ORCA_COMMANDS.workerShow, ids: { '--dispatch': 'disp_1' },
        exec: async input => { calls.push(input); return { code: 0, stdout: '{"dispatch":{"dispatchId":"disp_1"}}' }; }
    });
    assert.deepEqual(result, { dispatch: { dispatchId: 'disp_1' } });
    assert.deepEqual(calls[0].argv, [binary, 'orchestration', 'worker-show', '--dispatch', 'disp_1', '--json']);
    assert.equal(calls[0].argv.some(a => a === '--terminal'), false);
    assert.ok(calls[0].timeoutMs > 0 && calls[0].maxBytes > 0, 'bounded by default');
});

test('A06-C6 worker rows map documented states and never upgrade an unknown word', () => {
    const rows = parseWorkerRows({ workers: [
        { dispatchId: 'd1', status: 'working' },
        { dispatchId: 'd2', status: 'worker_done' },
        { dispatchId: 'd3', status: 'brand_new_word' },
        { dispatch_id: 'd4', status: 'failed' }
    ] });
    assert.deepEqual(rows.map(r => r.lifecycle), ['RUNNING', 'REPORT_PENDING_VERIFICATION', 'UNKNOWN', 'FAILED_CANDIDATE']);
    assert.equal(rows[1].lifecycle === 'REPORT_PENDING_VERIFICATION', true);
    assert.throws(() => parseWorkerRows({ workers: [{ status: 'working' }] }), { code: 'ORCA_WORKER_LIST_INVALID' });
    assert.throws(() => parseWorkerRows({ workers: 'nope' }), { code: 'ORCA_WORKER_LIST_INVALID' });
});

test('A06-C7 worker-read keeps the source binding next to the cursor', () => {
    const read = parseWorkerRead({ source: 'auto', cursor: 'c1', entries: [{ seq: 1 }] });
    assert.deepEqual(read.cursor, { source: 'auto', value: 'c1' });
    assert.equal(read.entries.length, 1);
    assert.throws(() => parseWorkerRead({ cursor: 'c1', entries: [] }), { code: 'ORCA_WORKER_READ_INVALID' });
    assert.throws(() => parseWorkerRead({ source: 'auto', entries: [] }), { code: 'ORCA_WORKER_READ_INVALID' });
    assert.throws(() => parseWorkerRead({ source: 'auto', cursor: 'c1' }), { code: 'ORCA_WORKER_READ_INVALID' });
});
// ---- A09: one bounded observation pass (reader only, no dispatch) ----
import { createOrcaWorkerObserver } from '../dist/server/orca/observe.js';

const binaryPath = 'C:\\Tools\\orca\\orca.exe';
function fakeOrca(script) {
    const calls = [];
    const exec = async ({ argv }) => {
        calls.push(argv.slice(1).join(' '));
        const answer = script(argv);
        if (answer === undefined) return { code: 1, stdout: '' };
        return { code: 0, stdout: JSON.stringify(answer) };
    };
    return { calls, exec };
}

test('A09-O1 a pass lists workers and keeps worker_done as a pending report', async () => {
    const fake = fakeOrca(argv => argv.includes('worker-list')
        ? { workers: [{ dispatchId: 'd1', status: 'working' }, { dispatchId: 'd2', status: 'worker_done' }] }
        : { source: 'auto', cursor: 'c1', entries: [] });
    const pass = await createOrcaWorkerObserver({ exec: fake.exec, binary: binaryPath, runId: 'run_1' }).poll();
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.workers.map(w => w.lifecycle), ['RUNNING', 'REPORT_PENDING_VERIFICATION']);
    assert.equal(pass.workers[1].lifecycle === 'REPORT_PENDING_VERIFICATION', true);
    assert.equal(pass.pagesRead, 2);
    assert.equal(fake.calls.every(c => c.endsWith('--json')), true);
});

test('A09-O2 the pass is bounded: it stops at the page limit instead of draining forever', async () => {
    const fake = fakeOrca(argv => argv.includes('worker-list')
        ? { workers: Array.from({ length: 10 }, (_, i) => ({ dispatchId: 'd' + i, status: 'working' })) }
        : { source: 'auto', cursor: 'c', entries: [] });
    const pass = await createOrcaWorkerObserver({ exec: fake.exec, binary: binaryPath, runId: 'run_1', maxPages: 3 }).poll();
    assert.equal(pass.pagesRead, 3);
    assert.equal(pass.stopped, 'PAGE_LIMIT');
});

test('A09-O3 a changed log source stops the pass rather than splicing two streams', async () => {
    let n = 0;
    const fake = fakeOrca(argv => {
        if (argv.includes('worker-list')) return { workers: [{ dispatchId: 'd1', status: 'working' }, { dispatchId: 'd2', status: 'working' }] };
        n += 1;
        return { source: n === 1 ? 'auto' : 'terminal', cursor: 'c' + n, entries: [] };
    });
    const pass = await createOrcaWorkerObserver({ exec: fake.exec, binary: binaryPath, runId: 'run_1' }).poll();
    assert.equal(pass.ok, true);
    assert.equal(pass.stopped, 'CURSOR_SOURCE_CHANGED');
    assert.equal(pass.pagesRead, 1);
});

test('A09-O4 an unknown worker status stays UNKNOWN through the whole pass', async () => {
    const fake = fakeOrca(argv => argv.includes('worker-list') ? { workers: [{ dispatchId: 'd1', status: 'mystery_state' }] } : { source: 'auto', cursor: 'c', entries: [] });
    const pass = await createOrcaWorkerObserver({ exec: fake.exec, binary: binaryPath, runId: 'run_1' }).poll();
    assert.equal(pass.workers[0].lifecycle, 'UNKNOWN');
    assert.equal(pass.workers[0].rawStatus, 'mystery_state');
});

test('A09-O5 a CLI failure is reported as a code, never thrown at the caller', async () => {
    const fake = fakeOrca(() => undefined); // every call exits non-zero
    const pass = await createOrcaWorkerObserver({ exec: fake.exec, binary: binaryPath, runId: 'run_1' }).poll();
    assert.equal(pass.ok, false);
    assert.equal(pass.errorCode, 'ORCA_CLI_FAILED');
    assert.deepEqual(pass.workers, []);
});

test('A09-O6 an absurd page limit is refused when the observer is built', () => {
    assert.throws(() => createOrcaWorkerObserver({ exec: async () => ({ code: 0, stdout: '{}' }), binary: binaryPath, runId: 'r', maxPages: 0 }), { code: 'ORCA_PAGE_LIMIT_INVALID' });
    assert.throws(() => createOrcaWorkerObserver({ exec: async () => ({ code: 0, stdout: '{}' }), binary: binaryPath, runId: 'r', maxPages: 99 }), { code: 'ORCA_PAGE_LIMIT_INVALID' });
});
// ---- A10: the dm-orca-worker proxy claims tickets, never commands ----
import { createWorkerProxy, assertTicketBelongsTo } from '../dist/server/orca/worker-proxy.js';

const T = Date.parse('2026-10-18T00:00:00.000Z');
const ticket = (over = {}) => ({
    schemaVersion: 1, projectId: 'p1', runId: 'run_1', taskId: 't1', attemptId: 'a1', operationId: 'op1', role: 'executor',
    baseTreeHash: 'b', specHash: 's', planHash: 'pl', allowedPathSetHash: 'ap', verifierPlanHash: 'vp',
    runnerConfigHash: 'rc', policyHash: 'po', budgetReservationId: 'br1', leaseGeneration: 1,
    expiresAt: new Date(T + 60_000).toISOString(), ...over
});
const proxy = (over = {}) => createWorkerProxy({ now: () => T, leaseGeneration: 1, ...over });

test('A10-P1 one ticket is claimed exactly once per operation', () => {
    const p = proxy();
    assert.deepEqual(p.claim(ticket()), { ok: true, code: 'CLAIMED', operationId: 'op1' });
    assert.deepEqual(p.claim(ticket()), { ok: false, code: 'ORCA_PROXY_ALREADY_CLAIMED', operationId: 'op1' });
    assert.deepEqual(p.claimedOperations(), ['op1']);
});

test('A10-P2 an expired, stale-lease or incomplete ticket is refused with its own code', () => {
    assert.equal(proxy().claim(ticket({ expiresAt: new Date(T - 1).toISOString() })).code, 'ORCA_TICKET_EXPIRED');
    assert.equal(proxy().claim(ticket({ leaseGeneration: 2 })).code, 'ORCA_TICKET_LEASE_STALE');
    assert.equal(proxy().claim(ticket({ planHash: '' })).code, 'ORCA_TICKET_INCOMPLETE');
    assert.equal(proxy().claim(ticket({ role: 'planner2' })).code, 'ORCA_TICKET_ROLE');
});

test('A10-P3 the claim memory is shared, so a second proxy cannot re-launch the same operation', () => {
    const shared = new Set();
    const first = createWorkerProxy({ now: () => T, leaseGeneration: 1, claimed: shared });
    const second = createWorkerProxy({ now: () => T, leaseGeneration: 1, claimed: shared });
    assert.equal(first.claim(ticket()).ok, true);
    assert.equal(second.claim(ticket()).code, 'ORCA_PROXY_ALREADY_CLAIMED');
});

test('A10-P4 the proxy exposes no way to run a command string', () => {
    const p = proxy();
    assert.equal(p.acceptsArbitraryCommand(), false);
    // The only execution-shaped API is claim(ticket) — there is no run(cmd) to call.
    assert.deepEqual(Object.keys(p).sort(), ['acceptsArbitraryCommand', 'claim', 'claimedOperations']);
});

test('A10-P5 a ticket for another run or another path set is refused', () => {
    assert.throws(() => assertTicketBelongsTo(ticket({ runId: 'other' }), { runId: 'run_1', allowedPathSetHash: 'ap' }), { code: 'ORCA_TICKET_WRONG_RUN' });
    assert.throws(() => assertTicketBelongsTo(ticket({ allowedPathSetHash: 'different' }), { runId: 'run_1', allowedPathSetHash: 'ap' }), { code: 'ORCA_TICKET_PATH_SET_MISMATCH' });
    assert.doesNotThrow(() => assertTicketBelongsTo(ticket(), { runId: 'run_1', allowedPathSetHash: 'ap' }));
});
// ---- A09: one SHADOW pass, wired but without authority ----
import { createOperationOutbox } from '../dist/server/orca/outbox.js';
import { runShadowPass } from '../dist/server/orca/shadow-pass.js';
import { createShadowMirror } from '../dist/server/orca/shadow.js';

const passing = workers => ({ poll: async () => ({ ok: true, workers, pagesRead: workers.length }) });
const failing = code => ({ poll: async () => ({ ok: false, workers: [], pagesRead: 0, errorCode: code }) });
const passInput = over => ({ mode: 'SHADOW', outbox: createOperationOutbox(), observer: passing([{ dispatchId: 'd1', lifecycle: 'RUNNING', rawStatus: 'working' }]), operationId: 'op1', budgetReservationId: 'br1', ...over });

test('A09-S1 OFF does not even poll', async () => {
    let polled = 0;
    const result = await runShadowPass(passInput({ mode: 'OFF', observer: { poll: async () => { polled += 1; return { ok: true, workers: [], pagesRead: 0 }; } } }));
    assert.equal(result.fired, false);
    assert.equal(result.reason, 'MODE_OFF');
    assert.equal(polled, 0);
});

test('A09-S2 a SHADOW pass records the dispatch and never completes the task', async () => {
    const outbox = createOperationOutbox();
    const mirror = createShadowMirror({ mode: 'SHADOW' });
    const result = await runShadowPass(passInput({ outbox, mirror }));
    assert.equal(result.fired, true);
    assert.equal(result.reason, 'OBSERVED');
    assert.equal(outbox.get('op1').state, 'DISPATCHED');
    assert.equal(outbox.get('op1').dispatchId, 'd1');
    assert.deepEqual(mirror.recent().map(e => e.kind), ['shadow.pass']);
});

test('A09-S3 an observation failure keeps the worst-case reservation', async () => {
    const outbox = createOperationOutbox();
    const result = await runShadowPass(passInput({ outbox, observer: failing('ORCA_CLI_FAILED') }));
    assert.equal(result.fired, true);
    assert.equal(result.reason, 'OBSERVATION_FAILED');
    const record = outbox.get('op1');
    assert.equal(record.state, 'OUTCOME_UNKNOWN');
    assert.equal(record.budgetReservationId, 'br1');
});

test('A09-S4 a second pass for the same operation is refused, not re-polled', async () => {
    const outbox = createOperationOutbox();
    await runShadowPass(passInput({ outbox }));
    let polled = 0;
    const result = await runShadowPass(passInput({ outbox, observer: { poll: async () => { polled += 1; return { ok: true, workers: [], pagesRead: 0 }; } } }));
    assert.equal(result.fired, false);
    assert.equal(result.reason, 'ORCA_OPERATION_DUPLICATE');
    assert.equal(polled, 0);
});

test('A09-S5 a changed dispatch id is not overwritten with a guess', async () => {
    const outbox = createOperationOutbox();
    await runShadowPass(passInput({ outbox }));
    // A second pass is refused by the outbox, so the recorded dispatch id stays the first one.
    await runShadowPass(passInput({ outbox, observer: passing([{ dispatchId: 'd2', lifecycle: 'RUNNING', rawStatus: 'working' }]) }));
    assert.equal(outbox.get('op1').dispatchId, 'd1');
});
