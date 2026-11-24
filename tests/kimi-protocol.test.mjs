import test from 'node:test';
import assert from 'node:assert/strict';
import { KimiTurnStream, unwrapKimiResponse, KIMI_EVENT_FAMILIES } from '../dist/server/providers/kimi-protocol.js';

// K05 offline half: the protocol contract and its reducer. Every frame here is synthetic and
// clearly labelled; nothing in this file is evidence about a running Kimi server.

const expect = () => ({ serverId: 'server_synthetic', epoch: 'e1', sessionId: 'session_synthetic', agentId: 'main', promptId: 'prompt_synthetic' });
const frame = (type, payload = {}, extra = {}) => ({ type, seq: undefined, timestamp: '2026-10-17T00:00:00Z', payload, ...extra });
let seq = 0;
const durable = (type, payload = {}, extra = {}) => frame(type, payload, { seq: ++seq, ...extra });

test('K05-01 a clean turn commits only after turn.ended reports completed', () => {
    seq = 0;
    const s = new KimiTurnStream(expect());
    s.accept(durable('turn.started', { turn_id: 'turn_1' }, { session_id: 'session_synthetic', epoch: 'e1' }));
    s.accept(frame('assistant.delta', { text: '{"a":' }, { volatile: true, offset: 0 }));
    s.accept(frame('assistant.delta', { text: '1}' }, { volatile: true, offset: 5 }));
    assert.equal(s.isComplete, false);
    assert.throws(() => s.receipt(), { code: 'KIMI_TURN_INCOMPLETE' });
    s.accept(durable('turn.ended', { turn_id: 'turn_1', reason: 'completed' }, { session_id: 'session_synthetic', epoch: 'e1' }));
    const r = s.receipt();
    assert.equal(r.reason, 'completed');
    assert.equal(r.turnId, 'turn_1');
    assert.equal(r.answerChars, 7);
    assert.match(r.answerHash, /^[a-f0-9]{64}$/);
    assert.equal(r.completedByTurnEnd, true);
    assert.equal(r.seq, 2);
});

test('K05-02 cancelled, failed and blocked turn ends are never success', () => {
    for (const reason of ['cancelled', 'failed', 'blocked', '']) {
        seq = 0;
        const s = new KimiTurnStream(expect());
        s.accept(durable('turn.started', { turn_id: 't' }));
        s.accept(frame('assistant.delta', { text: 'partial' }, { volatile: true }));
        assert.throws(() => s.accept(durable('turn.ended', { turn_id: 't', reason })), { code: 'KIMI_TURN_NOT_COMPLETED' });
        assert.equal(s.isComplete, false);
        assert.throws(() => s.receipt(), { code: 'KIMI_TURN_INCOMPLETE' });
    }
});

test('K05-03 a bare prompt.completed is corroboration, never the completion signal', () => {
    seq = 0;
    const s = new KimiTurnStream(expect());
    s.accept(durable('turn.started', { turn_id: 't' }));
    s.accept(durable('prompt.completed', { turn_id: 't', reason: 'completed' }));
    assert.equal(s.isComplete, false);
    assert.throws(() => s.receipt(), { code: 'KIMI_TURN_INCOMPLETE' });
    assert.throws(() => s.accept(durable('prompt.completed', { turn_id: 't', reason: 'cancelled' })), { code: 'KIMI_TURN_NOT_COMPLETED' });
});

test('K05-04 assistant.delta is draft only and thinking is never answer text', () => {
    seq = 0;
    const s = new KimiTurnStream(expect());
    s.accept(durable('turn.started', { turn_id: 't' }));
    s.accept(frame('thinking.delta', { text: 'SECRET_REASONING' }, { volatile: true }));
    s.accept(frame('assistant.delta', { text: 'answer' }, { volatile: true }));
    s.accept(durable('turn.ended', { turn_id: 't', reason: 'completed' }));
    const r = s.receipt();
    assert.equal(s.answer, 'answer');
    assert.equal(r.answerChars, 6);
    assert.equal(r.thinkingChars, 'SECRET_REASONING'.length);
    assert.equal(JSON.stringify(r).includes('SECRET_REASONING'), false);
});

test('K05-05 zero-tool policy turns any tool, subagent, shell, task or interaction event into a stop', () => {
    const forbidden = ['tool.call.started', 'tool.result', 'subagent.spawned', 'shell.started', 'task.started', 'event.approval.requested', 'event.question.requested'];
    for (const type of forbidden) {
        seq = 0;
        const s = new KimiTurnStream(expect());
        s.accept(durable('turn.started', { turn_id: 't' }));
        assert.throws(() => s.accept(frame(type, {}, { volatile: true })), { code: 'KIMI_TOOL_EVENT_VIOLATION' }, type);
    }
    // The same frames are tolerated when the caller explicitly runs a tool-capable profile.
    seq = 0;
    const relaxed = new KimiTurnStream(expect(), { zeroTools: false });
    relaxed.accept(durable('turn.started', { turn_id: 't' }));
    assert.doesNotThrow(() => relaxed.accept(frame('tool.call.started', {}, { volatile: true })));
    assert.ok(KIMI_EVENT_FAMILIES.tools.includes('tool.call.started'));
});

test('K05-06 duplicate durable frames are idempotent, out-of-order frames are refused', () => {
    const s = new KimiTurnStream(expect());
    s.accept({ type: 'turn.started', seq: 5, payload: { turn_id: 't' }, timestamp: '' });
    assert.doesNotThrow(() => s.accept({ type: 'turn.started', seq: 5, payload: { turn_id: 't' }, timestamp: '' }));
    assert.throws(() => s.accept({ type: 'turn.ended', seq: 4, payload: { reason: 'completed' }, timestamp: '' }), { code: 'KIMI_EVENT_SEQ_REGRESSION' });
    assert.throws(() => s.accept({ type: 'turn.ended', payload: { reason: 'completed' }, timestamp: '' }), { code: 'KIMI_EVENT_SEQ_REQUIRED' });
});

test('K05-07 foreign session, changed epoch and foreign turn never join this answer', () => {
    seq = 0;
    const s = new KimiTurnStream(expect());
    s.accept(durable('turn.started', { turn_id: 't' }, { session_id: 'session_synthetic', epoch: 'e1' }));
    assert.throws(() => s.accept(durable('assistant.delta', { text: 'x' }, { session_id: 'session_other', volatile: true })), { code: 'KIMI_EVENT_FOREIGN_SESSION' });
    assert.throws(() => s.accept(durable('turn.ended', { turn_id: 't', reason: 'completed' }, { epoch: 'e2' })), { code: 'KIMI_EVENT_EPOCH_MISMATCH' });
    assert.throws(() => s.accept(durable('turn.ended', { turn_id: 'turn_other', reason: 'completed' })), { code: 'KIMI_TURN_ID_MISMATCH' });
    assert.equal(s.isComplete, false);
});

test('K05-08 a delta offset gap forces reconciliation instead of appending blindly', () => {
    const s = new KimiTurnStream(expect());
    s.accept(frame('assistant.delta', { text: 'abc' }, { volatile: true, offset: 0 }));
    assert.throws(() => s.accept(frame('assistant.delta', { text: 'zzz' }, { volatile: true, offset: 99 })), { code: 'KIMI_DELTA_OFFSET_GAP' });
});

test('K05-09 an error event ends the turn and an incomplete binding is refused up front', () => {
    seq = 0;
    const s = new KimiTurnStream(expect());
    s.accept(durable('turn.started', { turn_id: 't' }));
    assert.throws(() => s.accept(durable('error', { message: 'upstream' })), { code: 'KIMI_STREAM_ERROR' });
    assert.throws(() => new KimiTurnStream({ ...expect(), serverId: '' }), { code: 'KIMI_BINDING_INCOMPLETE' });
    assert.throws(() => new KimiTurnStream({ ...expect(), promptId: '' }), { code: 'KIMI_BINDING_INCOMPLETE' });
});

test('K05-11 an in-band {kind:"error"} payload is a failure even with business code 0', () => {
    // Observed on the real 2.2.0 server: /api/v1/oauth/usage replies HTTP 200, code 0, and
    // { data: { kind: 'error', message: ... } } when no account is bound.
    assert.throws(() => unwrapKimiResponse({ code: 0, msg: 'success', data: { kind: 'error', message: 'not logged in' } }), { code: 'KIMI_API_IN_BAND_ERROR' });
    assert.deepEqual(unwrapKimiResponse({ code: 0, data: { kind: 'ok', quota: {} } }), { kind: 'ok', quota: {} });
});

test('K05-10 REST envelopes must carry a zero business code', () => {
    assert.deepEqual(unwrapKimiResponse({ code: 0, data: { ok: true } }), { ok: true });
    assert.deepEqual(unwrapKimiResponse({ ok: true }), { ok: true });
    assert.throws(() => unwrapKimiResponse({ code: 40001, msg: 'bad' }), { code: 'KIMI_API_ERROR' });
    assert.throws(() => unwrapKimiResponse({ code: '40927' }), { code: 'KIMI_API_ERROR' });
});
