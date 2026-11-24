// Star answer editing: six server-enforced freeze conditions, then a real edit that keeps history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';
import { StarAnswers } from '../../dist/server/star-answers.js';
import { EngineModes } from '../../dist/server/engine-mode.js';
import { WorkbenchContracts } from '../../dist/server/workbench-contracts.js';

const actor = 'local-session:' + 'a'.repeat(64);

function insertRun(h, state, extra = {}) {
    const run = {
        id: 'run_' + state.toLowerCase() + '_' + Math.random().toString(16).slice(2, 8),
        projectId: extra.projectId,
        version: 1,
        flowName: 'dreamflow-laya',
        mode: 'demo',
        state,
        createdAt: new Date().toISOString(),
        ...extra
    };
    h.store.insertRun(run);
    return run;
}

/** A project with one answered star and an approved spec, i.e. the state an edit is worth. */
async function answeredStar(h) {
    const p = h.interviews.create('星星编辑', '做一个本地记录工具。', 'demo');
    let current = await h.interviews.next(p.id);
    const q = current.questions[0];
    current = h.interviews.answer(p.id, q.id, '第一个回答', false, current.version, []);
    await h.interviews.finish(p.id, '', false);
    const spec = h.store.spec(h.store.project(p.id).specId);
    h.interviews.approve(p.id, spec.hash);
    const engines = new EngineModes(h.store, () => h.config);
    return { p: h.store.project(p.id), q, spec, stars: new StarAnswers(h.store, h.interviews, engines), engines };
}

test('a normal edit keeps the old answer, invalidates the draft, the spec and its approvals', async t => {
    const h = harness(t);
    const { p, q, spec, stars } = await answeredStar(h);
    // A confirmed requirements draft, so the invalidation has something real to drop.
    const staged = h.store.project(p.id);
    staged.requirementsDraft = { recordId: 'rec_draft', version: 1, contentHash: 'a'.repeat(64), confirmed: { recordId: 'rec_draft', hash: 'a'.repeat(64), at: new Date().toISOString(), actor: 'USER' } };
    h.store.tx(() => h.store.saveProject(staged));
    const before = stars.view(p.id, q.id);
    assert.equal(before.answer, '第一个回答');
    assert.equal(before.revision, 1);
    assert.equal(before.editable, true);
    assert.deepEqual(before.frozenBy, []);
    assert.deepEqual(before.history, []);
    const saved = stars.edit(p.id, q.id, { revision: 1, answer: '第二个回答' }, actor);
    assert.equal(saved.answer, '第二个回答');
    assert.equal(saved.revision, 2);
    assert.equal(saved.status, 'CHANGED');
    assert.equal(saved.superseded.draftInvalidated, true);
    assert.equal(saved.superseded.specId, spec.id);
    assert.equal(saved.superseded.approvalsRevoked, true);
    const after = h.store.project(p.id);
    assert.equal(after.specId, null);
    assert.equal(after.requirementsDraft.confirmed, null);
    assert.equal(h.store.approved(p.id, spec.hash, 'SPEC'), false);
    assert.equal(h.store.spec(spec.id).stale, true);
    const history = after.answerHistory.filter(answer => answer.questionId === q.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].text, '第一个回答');
    assert.equal(history[0].revision, 1);
    // The edit itself is an auditable record, not an event that only exists in memory.
    const records = h.store.records(p.id, 'StarAnswerEdit');
    assert.equal(records.length, 1);
    assert.equal(records[0].data.before.specId, spec.id);
    assert.equal(stars.view(p.id, q.id).history.length, 1);
});

test('a stale revision is refused instead of overwriting a newer answer', async t => {
    const h = harness(t);
    const { p, q, stars } = await answeredStar(h);
    assert.throws(() => stars.edit(p.id, q.id, { revision: 7, answer: 'x' }, actor), error => error.code === 'STAR_ANSWER_REVISION_CONFLICT');
    assert.equal(h.store.project(p.id).answers.find(answer => answer.questionId === q.id).text, '第一个回答');
});

test('an unknown star and a secret-bearing answer are named errors, not silent writes', async t => {
    const h = harness(t);
    const { p, q, stars } = await answeredStar(h);
    assert.throws(() => stars.edit(p.id, 'star_missing', { revision: 0, answer: 'x' }, actor), error => error.code === 'STAR_NOT_FOUND');
    assert.throws(() => stars.edit(p.id, q.id, { revision: 1, answer: 'sk-live-0123456789abcdef' }, actor), error => error.code === 'SECRET_IN_NOTES');
});

for (const [reason, state, extra, lease] of [
    ['RUN_IN_PROGRESS', 'IMPLEMENTING', {}, false],
    ['RUN_PAUSED', 'PAUSED', {}, false],
    ['WORKSPACE_LEASE_HELD', 'CANCELLED', {}, true],
    ['RESULT_UNKNOWN', 'BLOCKED', { reason: 'RESULT_UNCERTAIN' }, false],
    ['DELIVERY_NOT_SETTLED', 'READY_FOR_DELIVERY', {}, false]
]) {
    test('freeze condition ' + reason + ' refuses the edit on the server', async t => {
        const h = harness(t);
        const { p, q, stars } = await answeredStar(h);
        const run = insertRun(h, state, { projectId: p.id, ...extra });
        if (lease) h.store.acquire(p.id, run.id);
        const view = stars.view(p.id, q.id);
        assert.equal(view.editable, false);
        assert.ok(view.frozenBy.includes(reason), 'frozenBy was ' + JSON.stringify(view.frozenBy));
        assert.throws(
            () => stars.edit(p.id, q.id, { revision: 1, answer: '不该写进去' }, actor),
            error => error.code === 'STAR_ANSWER_FROZEN_' + reason
        );
        assert.equal(h.store.project(p.id).answers.find(answer => answer.questionId === q.id).text, '第一个回答');
    });
}

test('freeze condition DF_WORK_IN_PROGRESS refuses the edit while DF work is open', async t => {
    const h = harness(t);
    const { p, q, stars } = await answeredStar(h);
    // A second registered model, so the executor selection can genuinely deviate from the default.
    h.config.independent = { ...h.config.independent, enabled: true, model: 'independent-chat', protocol: 'chat-completions' };
    const bench = new WorkbenchContracts({ store: h.store, config: () => h.config, interviews: h.interviews });
    // The project is decided custom (DF) by its own role configuration…
    bench.saveRole(p.id, 'executor', { revision: 0, selection: { model: 'independent-chat', harness: 'dsh', effort: 'default', skills: [], plugins: [] } }, actor, hash('df-freeze'));
    assert.equal(bench.engine(p.id).engine, 'custom');
    // …and a blocked Flow is still open work, so answers stay frozen.
    const run = insertRun(h, 'BLOCKED', { projectId: p.id, reason: 'REVIEW_ROLE_EVIDENCE_REQUIRED' });
    assert.ok(run.id);
    const view = stars.view(p.id, q.id);
    assert.deepEqual(view.frozenBy, ['DF_WORK_IN_PROGRESS']);
    assert.throws(() => stars.edit(p.id, q.id, { revision: 1, answer: '不该写进去' }, actor), error => error.code === 'STAR_ANSWER_FROZEN_DF_WORK_IN_PROGRESS');
    // A closed DF flow is history: the answer is editable again.
    const closed = h.store.project(p.id);
    const stored = h.store.run(run.id);
    stored.state = 'CANCELLED';
    h.store.saveRun(stored);
    assert.equal(closed.id, p.id);
    assert.deepEqual(stars.view(p.id, q.id).frozenBy, []);
});

test('the freeze code names every condition at once when several hold', async t => {
    const h = harness(t);
    const { p, q, stars } = await answeredStar(h);
    const run = insertRun(h, 'PAUSED', { projectId: p.id });
    h.store.acquire(p.id, run.id);
    const view = stars.view(p.id, q.id);
    assert.deepEqual(view.frozenBy, ['RUN_PAUSED', 'WORKSPACE_LEASE_HELD']);
    assert.throws(() => stars.edit(p.id, q.id, { revision: 1, answer: 'x' }, actor), error => error.code === 'STAR_ANSWER_FROZEN_RUN_PAUSED');
});
