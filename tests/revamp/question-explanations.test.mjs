// Question explanations: their own context, no state change, late replies have no effect, capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';
import { QuestionExplanations } from '../../dist/server/question-explanations.js';
import { StarAnswers } from '../../dist/server/star-answers.js';
import { EngineModes } from '../../dist/server/engine-mode.js';

const actor = 'local-session:' + 'a'.repeat(64);
const turns = [{ role: 'user', text: '这句话是什么意思？' }, { role: 'user', text: '能不能举一个例子？' }];

async function starProject(h) {
    const created = h.interviews.create('解释请求', '做一个本地记录工具。', 'demo');
    let current = await h.interviews.next(created.id);
    const q = current.questions[0];
    current = h.interviews.answer(created.id, q.id, '我的回答', false, current.version, []);
    return { p: h.store.project(created.id), q, version: current.version };
}

function stub(text = '换一种说法：你希望第一版先解决哪一个具体问题。') {
    const calls = [];
    return {
        calls,
        model: { complete: async payload => { calls.push(payload); return { data: { reply: text }, usage: { role: 'planner1', tokens: 12 } }; } }
    };
}

function snapshot(h, projectId) {
    const project = h.store.project(projectId);
    return {
        answers: JSON.stringify(project.answers),
        history: JSON.stringify(project.answerHistory),
        specId: project.specId,
        state: project.state,
        runs: h.store.runs(projectId).length,
        approvals: h.store.db.prepare('SELECT count(*) n FROM approvals WHERE project_id=?').get(projectId).n,
        specs: h.store.specs(projectId).length,
        projectHash: hash(project)
    };
}

test('an explanation keeps its own context and changes no project state', async t => {
    const h = harness(t);
    const { p, q } = await starProject(h);
    const { model, calls } = stub();
    const explanations = new QuestionExplanations(h.store, model, () => h.config);
    const before = snapshot(h, p.id);
    const result = await explanations.ask(p.id, q.id, { turns, question: q.text });
    assert.equal(result.reply, '换一种说法：你希望第一版先解决哪一个具体问题。');
    assert.equal(result.superseded, false);
    assert.equal(result.turns, 3);
    assert.ok(result.remainingCalls > 0);
    // The model saw the question and the turns, and an instruction that forbids answering for the owner.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'question_explanation');
    assert.equal(calls[0].question, q.text);
    assert.equal(calls[0].answered, true);
    assert.match(calls[0].instruction, /不要替用户作答/);
    assert.deepEqual(calls[0].turns, turns.map(turn => ({ role: turn.role, text: turn.text })));
    // The answer is untouched: an explanation never fills it in.
    const after = snapshot(h, p.id);
    assert.equal(after.answers, before.answers);
    assert.equal(after.history, before.history);
    assert.equal(after.specId, before.specId);
    assert.equal(after.state, before.state);
    assert.equal(after.approvals, before.approvals);
    assert.equal(after.specs, before.specs);
    assert.equal(after.runs, 0);
    assert.equal(h.store.project(p.id).answers.find(answer => answer.questionId === q.id).text, '我的回答');
    // Its context is stored beside the answer, in its own record kind.
    const sessions = h.store.records(p.id, 'QuestionExplanationSession');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].data.starId, q.id);
    assert.equal(sessions[0].data.turns.length, 3);
    assert.equal(sessions[0].data.turns[2].role, 'model');
    assert.equal(explanations.history(p.id, q.id).length, 1);
    // It spent from the same call budget as any other model turn, and recorded the cost as unknown.
    assert.equal(h.store.records(p.id, 'ModelAttempt').length, 2);
    assert.equal(h.store.records(p.id, 'UsageLedger').length, 1);
});

test('an explanation that arrives after the owner answered changes nothing', async t => {
    const h = harness(t);
    const { p, q } = await starProject(h);
    let resolveModel;
    const gate = new Promise(resolve => { resolveModel = resolve; });
    const explanations = new QuestionExplanations(h.store, { complete: async () => { await gate; return { data: { reply: '迟到的解释' } }; } }, () => h.config);
    const engines = new EngineModes(h.store, () => h.config);
    const stars = new StarAnswers(h.store, h.interviews, engines);
    const pending = explanations.ask(p.id, q.id, { turns });
    // The owner answers while the model is still thinking.
    const edited = stars.edit(p.id, q.id, { revision: 1, answer: '改后的回答' }, actor);
    assert.equal(edited.answer, '改后的回答');
    resolveModel();
    const result = await pending;
    assert.equal(result.reply, '迟到的解释');
    assert.equal(result.superseded, true);
    assert.equal(result.ended, true);
    // The owner's answer stands; the late reply is history with no effect.
    assert.equal(h.store.project(p.id).answers.find(answer => answer.questionId === q.id).text, '改后的回答');
    const session = h.store.records(p.id, 'QuestionExplanationSession').at(-1).data;
    assert.equal(session.superseded, true);
    assert.equal(session.answerRevisionAtStart, 1);
    assert.equal(explanations.history(p.id, q.id).at(-1).superseded, true);
});

test('the explanation budget is enforced on the server', async t => {
    const h = harness(t);
    h.config.planner1.maxCallsPerProject = 2;
    const { p, q } = await starProject(h);
    const { model } = stub();
    const explanations = new QuestionExplanations(h.store, model, () => h.config);
    await explanations.ask(p.id, q.id, { turns });
    await assert.rejects(() => explanations.ask(p.id, q.id, { turns }), error => error.code === 'EXPLANATION_CALL_BUDGET_EXCEEDED');
    assert.equal(h.store.records(p.id, 'QuestionExplanationSession').length, 1);
});

test('malformed turns, an unknown star and an out-of-contract reply are named errors', async t => {
    const h = harness(t);
    const { p, q } = await starProject(h);
    const { model } = stub('   ');
    const explanations = new QuestionExplanations(h.store, model, () => h.config);
    await assert.rejects(() => explanations.ask(p.id, q.id, { turns: [] }), error => error.code === 'EXPLANATION_TURNS_INVALID');
    await assert.rejects(() => explanations.ask(p.id, q.id, { turns: [{ role: 'model', text: '模型先说' }] }), error => error.code === 'EXPLANATION_TURNS_INVALID');
    await assert.rejects(() => explanations.ask(p.id, q.id, { turns: [{ role: 'user', text: 'x', extra: 1 }] }), error => error.code === 'EXPLANATION_TURNS_INVALID');
    await assert.rejects(() => explanations.ask(p.id, 'star_missing', { turns }), error => error.code === 'STAR_NOT_FOUND');
    await assert.rejects(() => explanations.ask(p.id, q.id, { turns }), error => error.code === 'EXPLANATION_OUTPUT_INCONTRACT');
    assert.equal(h.store.records(p.id, 'ModelAttemptFailure').length, 1);
    assert.equal(h.store.records(p.id, 'QuestionExplanationSession').length, 0);
});
