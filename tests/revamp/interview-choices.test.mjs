import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready, bindOfflineApi } from '../helpers.mjs';
import { Interviews, answered } from '../../dist/server/interview.js';

test('new questions have four separate choices; zero answers can still finish without invented choices', async t => {
    const h = harness(t), p = h.interviews.create('零回答', '制作一个本地记录工具。', 'demo');
    const q = (await h.interviews.next(p.id)).questions[0];
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options.map(o => o.id)).size, 4);
    await h.interviews.finish(p.id, '', false);
    const version = h.store.planHead(p.id);
    assert.deepEqual(version.source.answers, []);
    assert.equal(version.snapshot.requirements.length, 1);
    assert.equal(h.store.runs(p.id).length, 0);
});

test('selected labels and original custom text are stored separately and revisions do not inflate the count', async t => {
    const h = harness(t), p = h.interviews.create('选择来源', '做记录工具。', 'demo');
    let current = await h.interviews.next(p.id); const q = current.questions[0];
    current = h.interviews.answer(p.id, q.id, '另外保留我的原话', false, current.version, [q.options[1].id]);
    assert.deepEqual(current.answers[0].optionIds, [q.options[1].id]);
    assert.equal(current.answers[0].customText, '另外保留我的原话');
    assert.equal(current.answers[0].source, 'USER_MIXED');
    assert.match(current.answers[0].text, new RegExp(q.options[1].label));
    current = h.interviews.answer(p.id, q.id, '改为纯自由输入', false, current.version, []);
    assert.equal(answered(current), 1);
    assert.equal(current.answerHistory[0].source, 'USER_MIXED');
    assert.equal(current.answers[0].source, 'USER_FREE_TEXT');
});

test('unknown, duplicate, conflicting skip and disallowed multiple choices are rejected before storing an answer', async t => {
    const h = harness(t), p = h.interviews.create('拒绝伪选择', '做记录工具。', 'demo');
    const current = await h.interviews.next(p.id), q = current.questions[0];
    for (const [value, skip, choices, code] of [
        ['', false, ['missing'], 'INVALID_ANSWER_OPTIONS'],
        ['', false, [q.options[0].id, q.options[0].id], 'INVALID_ANSWER_OPTIONS'],
        ['', false, q.options.slice(0, 2).map(o=>o.id), 'MULTIPLE_OPTIONS_NOT_ALLOWED'],
        ['do not silently ignore this', true, [], 'SKIP_WITH_ANSWER'],
        ['', false, [], 'ANSWER_REQUIRED']
    ]) assert.throws(() => h.interviews.answer(p.id, q.id, value, skip, current.version, choices), { code });
    assert.equal(h.store.project(p.id).answers.length, 0);
});

test('malformed model choices cannot commit a question or become a silent rule-bank fallback', async t => {
    const h = harness(t); bindOfflineApi(h.config);
    const model = { complete: async () => ({ data: { topic: 'goal', text: '实际使用场景？', suggestion: '', prerequisites: [] }, usage: { role: 'planner1', costUsd: 0, source: 'OFFLINE_TEST' } }) };
    const interviews = new Interviews(h.store, model, h.laya, () => h.config);
    const p = interviews.create('模型契约', '小工具', 'live');
    await assert.rejects(interviews.next(p.id), { code: 'QUESTION_REQUIRES_FOUR_OPTIONS' });
    assert.equal(h.store.project(p.id).questions.length, 0);
    assert.equal(h.store.records(p.id, 'ModelAttempt').length, 1);
});

test('alternative direction waits for a settled Flow then uses five-answer batches', async t => {
    const h = harness(t, 30), { p, s } = await ready(h);
    assert.throws(() => h.interviews.alternative(p.id), { code: 'FLOW_TERMINATION_REQUIRED' });
    const run = h.engine.create(p.id, s.hash, true);
    assert.throws(() => h.interviews.alternative(p.id), { code: 'RUN_MUST_STOP_BEFORE_EDIT' });
    await h.engine.cancel(run.id); await h.engine.settled(run.id);
    let current = h.interviews.alternative(p.id);
    assert.equal(current.interviewMode, 'ALTERNATIVE');
    assert.equal(current.batchSize, 5);
    assert.equal(current.alternativeContext.runId, run.id);
    for (let i = 0; i < 5; i++) {
        current = await h.interviews.next(p.id); const q = current.questions.at(-1);
        current = h.interviews.answer(p.id, q.id, '', false, current.version, [q.options[0].id]);
    }
    assert.equal(current.state, 'AWAITING_INTERVIEW_DECISION');
    await assert.rejects(h.interviews.next(p.id), { code: 'INTERVIEW_NOT_ACTIVE' });
    current = h.interviews.continue(p.id);
    assert.equal(current.batchTarget, 10);
});
