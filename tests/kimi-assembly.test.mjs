import test from 'node:test';
import assert from 'node:assert/strict';
import { Interviews } from '../dist/server/interview.js';
import { harness } from './helpers.mjs';
import { DomainError, hash as hashOf } from '../dist/server/security.js';
import { createKimiAdmission } from '../dist/server/kimi-admission.js';
import { fixtureProjectPlan } from './fixtures/full-project-plan.mjs';
const OPTIONS = ['one','two','three','four'].map((label,i)=>({id:'o'+i,label})); // Offline output contract, never a production fallback.

// A01: planner1 dispatch is gated by the shared admission authority. These fixtures exercise the
// assembly seam (runner vs. no runner vs. bad receipts), so they present an explicit OFF record.
const ALLOW = createKimiAdmission({
    schema: 1, state: 'OFF', source: 'USER_ATTESTED', accountRef: 'kimi:user_synthetic',
    observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
});

// K03 assembly tests: the planner1 dispatch either goes through the injected Kimi runner or it
// refuses outright. There is no path where a Kimi-enabled config silently uses another provider.

function rig(t, { enabled = true, withRunner = true } = {}) {
    const h = harness(t);
    h.config.planner1.provider = 'kimi';
    h.config.planner1.accountRef = 'offline';
    h.config.planner1.model = 'kimi-code/kimi-for-coding';
    h.config.kimi = { baseUrl: 'http://127.0.0.1:58631', timeoutMs: 5000, pollMs: 10, tokenFile: '/synthetic/server.token', enabled };
    const calls = [];
    const runner = {
        async run(input, onEvent) {
            calls.push(input);
            onEvent({ method: 'dm/kimiAccepted', params: { sessionId: 'session_synthetic' } });
            const body = JSON.stringify({ topic: 'goal', text: 'What is the single problem?', suggestion: 'one', prerequisites: [], options: OPTIONS, allowMultiple: false });
            return { text: body, sessionId: 'session_synthetic', usage: { role: 'planner1', inputTokens: 11, outputTokens: 22, costUsd: null, source: 'PROVIDER', requestId: 'p1' }, receipt: { turnId: 'msg_synthetic_1', reason: 'completed', answerChars: body.length, answerHash: hashOf(body), sessionId: 'session_synthetic', promptId: 'msg_synthetic_1', source: 'REST_TRANSCRIPT' } };
        }
    };
    const interviews = new Interviews(h.store, h.model, h.laya, () => h.config, withRunner ? { runner, workspace: h.dir, instructions: '', admission: ALLOW } : undefined);
    return { h, calls, interviews };
}

test('K03-A1 a kimi-enabled planner1 dispatches through the injected runner and records usage', async t => {
    const { h, calls, interviews } = rig(t);
    const project = interviews.create('Kimi project', 'A simple idea', 'live');
    await interviews.next(project.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, 'planner1');
    assert.equal(calls[0].model, 'kimi-code/kimi-for-coding');
    assert.match(calls[0].prompt, /\{/);
    const ledger = h.store.records(project.id, 'UsageLedger');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].data.inputTokens, 11);
    const attempts = h.store.records(project.id, 'ModelAttempt');
    assert.equal(attempts.at(-1).data.providerId, 'kimi');
});

test('K03 identity records keep requested Kimi model, protocol and session in distinct fields',async t=>{
    const {h,interviews}=rig(t),project=interviews.create('Identity metadata','A simple idea','live');
    await interviews.next(project.id);
    const records=h.store.records(project.id,'ModelAttempt').map(r=>r.data),request=records.find(r=>r.status==='REQUESTED'),done=records.find(r=>r.status==='COMPLETED');
    assert.equal(request.providerId,'kimi');assert.equal(request.protocol,'kimi-server');assert.equal(request.provider,'KIMI_CODE');
    assert.equal(done.model,'kimi-code/kimi-for-coding');assert.equal(done.requestedModelId,'kimi-code/kimi-for-coding');
    assert.equal(done.sessionId,'session_synthetic');assert.equal(done.actualModelId,null);assert.equal(done.modelIdentitySource,'REQUESTED_RUNTIME_ROUTE');
});

test('K03-A6 membership consumption is never written as money', async t => {
    // Kimi runs on a member subscription. Its usage must stay in the quota column: no cash cost
    // may be invented for it and no paid reservation may be created on this path.
    const { h, interviews } = rig(t);
    const project = interviews.create('Membership only', 'A simple idea', 'live');
    await interviews.next(project.id);
    const ledger = h.store.records(project.id, 'UsageLedger');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].data.costUsd, null);
    assert.equal(ledger[0].data.source, 'PROVIDER');
    const kinds = h.store.db.prepare('select distinct kind from records where project_id=?').all(project.id).map(r => r.kind);
    assert.equal(kinds.some(k => /Reservation|Reserve|Price|Cash/i.test(String(k))), false, 'no cash reservation kinds on the membership path: ' + kinds.join(','));
});
test('K03-A2 a kimi-enabled config without an assembled runner refuses instead of falling back', async t => {
    const { interviews } = rig(t, { withRunner: false });
    const project = interviews.create('No runner', 'A simple idea', 'live');
    await assert.rejects(interviews.next(project.id), { code: 'KIMI_RUNNER_UNAVAILABLE' });
});

test('K03-A3 a disabled selected Kimi cannot silently dispatch the legacy API path', async t => {
    const { h, calls, interviews } = rig(t, { enabled: false });
    let providerCalls = 0;
    h.model.complete = async () => { providerCalls++; throw new DomainError('LEGACY_PROVIDER_REACHED', 409); };
    const project = interviews.create('Legacy', 'A simple idea', 'live');
    await assert.rejects(interviews.next(project.id), { code: 'KIMI_RUNNER_DISABLED' });
    assert.equal(calls.length, 0);
    assert.equal(providerCalls, 0);
});

test('K03-A4 a runner failure surfaces with its own code and is recorded', async t => {
    const { h, interviews } = rig(t);
    const failing = {
        async run() { const e = new Error('no auth'); e.code = 'KIMI_NOT_AUTHENTICATED'; throw e; }
    };
    const interviews2 = new Interviews(h.store, h.model, h.laya, () => h.config, { runner: failing, workspace: h.dir, instructions: '', admission: ALLOW });
    const project = interviews2.create('Fail', 'A simple idea', 'live');
    await assert.rejects(interviews2.next(project.id), { code: 'KIMI_NOT_AUTHENTICATED' });
    const failures = h.store.records(project.id, 'ModelAttemptFailure');
    assert.equal(failures.at(-1).data.code, 'KIMI_NOT_AUTHENTICATED');
});
test('K03-A5 a runner that cannot produce a receipt never commits', async t => {
    const { h } = rig(t);
    const noReceipt = { async run() { return { text: '{}', sessionId: 'session_synthetic', usage: { role: 'planner1', inputTokens: 0, outputTokens: 0, costUsd: null, source: 'PROVIDER', requestId: 'x' } }; } };
    const interviews = new Interviews(h.store, h.model, h.laya, () => h.config, { runner: noReceipt, workspace: h.dir, instructions: '', admission: ALLOW });
    const project = interviews.create('No receipt', 'A simple idea', 'live');
    await assert.rejects(interviews.next(project.id), { code: 'KIMI_TURN_INCOMPLETE' });
});
// A07: the planner1 role dispatches real model turns through the interview layer, not the Engine.
// If that seam does not record, `/api/laya/observation` reports "no turns observed" while real turns
// were happening — which is exactly the unproven claim this mechanism exists to prevent.
test('A07-A2 a real planner1 dispatch is recorded as an observed Laya turn', async t => {
    const { h, interviews } = rig(t);
    const recorded = [];
    const observer = { record: turn => recorded.push(turn) };
    const wired = new Interviews(h.store, h.model, h.laya, () => h.config, {
        runner: {
            async run(input, onEvent) {
                onEvent({ method: 'dm/kimiAccepted', params: { sessionId: 'session_synthetic' } });
                const body = JSON.stringify({ topic: 'goal', text: '第一问：这是什么？', suggestion: 'one', prerequisites: [], options: OPTIONS, allowMultiple: false });
                return { text: body, sessionId: 'session_synthetic', usage: { role: 'planner1', inputTokens: 1, outputTokens: 2, costUsd: null, source: 'PROVIDER', requestId: 'p2' }, receipt: { turnId: 'msg_synthetic_2', reason: 'completed', answerChars: body.length, answerHash: hashOf(body), sessionId: 'session_synthetic', promptId: 'msg_synthetic_2', source: 'REST_TRANSCRIPT' } };
            }
        }, workspace: h.dir, instructions: '', admission: ALLOW
    }, observer);
    const project = wired.create('For the observer', 'A simple idea', 'live');
    await wired.next(project.id);
    assert.equal(recorded.length, 1, 'one real dispatch, one observed turn');
    assert.equal(recorded[0].role, 'planner1');
    assert.equal(recorded[0].mode, 'off');
    assert.ok(['off', 'abstained'].includes(recorded[0].adoption), recorded[0].adoption);
    void interviews;
});
test('A07-A3 the complete-plan dispatch is counted too, and as abstained rather than as an OFF observation', async t => {
    const { h } = rig(t);
    const recorded = [];
    const observer = { record: turn => recorded.push(turn) };
    const body = JSON.stringify({ topic: 'goal', text: '第一问：这是什么？', suggestion: 'one', prerequisites: [], options: OPTIONS, allowMultiple: false });
    const runner = {
        async run(input) {
            const payload=JSON.parse(input.prompt.trim());
            const response=payload.task==='project_plan'?JSON.stringify(fixtureProjectPlan(payload.requiredUserRequirements)):body;
            return { text: response, sessionId: 'session_synthetic', usage: { role: 'planner1', inputTokens: 1, outputTokens: 2, costUsd: null, source: 'PROVIDER', requestId: 'p3' }, receipt: { turnId: 'msg_synthetic_3', reason: 'completed', answerChars: response.length, answerHash: hashOf(response), sessionId: 'session_synthetic', promptId: 'msg_synthetic_3', source: 'REST_TRANSCRIPT' } };
        }
    };
    const wired = new Interviews(h.store, h.model, h.laya, () => h.config, { runner, workspace: h.dir, instructions: '', admission: ALLOW }, observer);
    const project = wired.create('Summary turn', 'A simple idea', 'live');
    await wired.next(project.id);
    const answered = (await wired.answer(project.id, wired.store.project(project.id).questions[0].id, '细节')).answers;
    assert.equal(answered.filter(a => a.status === 'answered').length, 1);
    await wired.finish(project.id, '本地专用', true);
    assert.equal(recorded.length, 2, 'one question turn and one complete-plan turn');
    assert.equal(recorded[0].adoption, 'off');
    assert.equal(recorded[1].adoption, 'abstained', 'Laya is not consulted for the summary, so it abstained');
    assert.equal(recorded[1].role, 'planner1');
});
