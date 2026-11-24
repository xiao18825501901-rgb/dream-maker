import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from './helpers.mjs';
import { root } from './helpers.mjs';
import { resolve } from 'node:path';
import { createApp } from '../dist/server/http.js';
import { validateSemanticRevision } from '../dist/server/semantics.js';
import { undecidedRequirements, looksUndecided } from '../dist/server/spec-decidability.js';

// A spec whose requirements are still open questions cannot yield a trusted verifier plan, so the
// product says so at SPEC_REVIEW (SPEC_REQUIREMENTS_UNDECIDED) instead of at verification time.
test('SPEC-UNDECIDED-1 an unanswered question and a two-character answer are reported', () => {
    assert.equal(looksUndecided('连续打卡按什么口径计算？'), true);
    assert.equal(looksUndecided('请决定 ERROR 码表，并给出每种情形的输出。'), true);
    assert.equal(looksUndecided('连续打卡按什么口径计算？\n用户回答：ok'), true, 'a 2-char answer is not a decision');
    assert.equal(looksUndecided('输出契约已决定：add 打印一行 ADDED <name>。'), false);
    assert.equal(looksUndecided('连续打卡按什么口径计算？\n用户回答：按单个习惯项计算，连续自然日都有 tick 才算连续，漏打一天清零。'), false);
    assert.equal(looksUndecided(''), false);
});
test('SPEC-UNDECIDED-2 acceptance items clear a requirement from the undecided list', () => {
    const spec = {
        requirements: [
            { id: 'R001', text: '这是一个已经决定的需求：node main.mjs help 打印 USAGE 开头一行。' },
            { id: 'R002', text: 'streak 的判定口径是什么？请二选一。' },
            { id: 'R003', text: '请决定错误码 NO_SUCH_ITEM 的取值。' }
        ],
        acceptanceItems: [{ requirementIds: ['R003'] }]
    };
    assert.deepEqual(undecidedRequirements(spec), ['R002']);
    assert.deepEqual(undecidedRequirements({ requirements: spec.requirements, acceptanceItems: [] }), ['R002', 'R003']);
    assert.deepEqual(undecidedRequirements(null), []);
});
function confirmation(spec) {
    return {
        confirmed: true,
        requirements: spec.requirements.map(r => ({ id: r.id, kind: 'functional', priority: r.priority })),
        acceptanceItems: spec.requirements.map((r, i) => ({ id: `A${i + 1}`, requirementIds: [r.id], criterion: `Observe the expected behavior for ${r.id}.`, method: 'manual' }))
    };
}

test('semantic confirmation preserves exact source and creates a new unapproved revision', async t => {
    const h = harness(t), p = h.interviews.create('Classification', 'Do not send private data to a cloud service.', 'demo');
    await h.interviews.next(p.id);
    h.interviews.answer(p.id, h.store.project(p.id).questions[0].id, 'A local tool for my own work.');
    await h.interviews.finish(p.id);
    const original = h.store.spec(h.store.project(p.id).specId);
    h.interviews.approve(p.id, original.hash);
    const next = h.interviews.reviseSemantics(p.id, original.hash, confirmation(original));
    const current = h.store.spec(next.specId);
    assert.equal(next.state, 'SPEC_REVIEW');
    assert.notEqual(current.id, original.id);
    assert.notEqual(current.hash, original.hash);
    assert.equal(current.revision, original.revision + 1);
    for (const req of original.requirements) {
        const updated = current.requirements.find(r => r.id === req.id);
        assert.equal(updated.text, req.text);
        assert.equal(updated.origin, req.origin);
        assert.deepEqual(updated.sourceAnswerIds, req.sourceAnswerIds);
        assert.equal(updated.classificationOrigin, 'USER_CONFIRMED');
    }
    assert.equal(current.acceptanceItems[0].evidenceStatus, 'NOT_RUN');
    assert.equal(current.semanticConfirmation.previousSpecHash, original.hash);
    assert.equal(h.store.spec(original.id).stale, true);
    assert.equal(h.store.approved(p.id, original.hash, 'SPEC'), false);
    assert.match(current.masterPrompt, /USER_CONFIRMED/);
    assert.match(current.masterPrompt, /A1/);
    assert.equal(h.store.runs(p.id).length, 0);
    assert.throws(() => h.interviews.approve(p.id, original.hash), { code: 'SPEC_APPROVAL_STALE' });
});

test('semantic suggestions require an explicit user decision', async t => {
    const h = harness(t), { s } = await ready(h), raw = confirmation(s);
    raw.confirmed = false;
    assert.throws(() => validateSemanticRevision(s, raw), { code: 'SEMANTIC_CONFIRMATION_REQUIRED' });
});

test('editing notes retains confirmed classifications and criteria while revoking the old freeze', async t => {
    const h = harness(t), { p, s } = await ready(h);
    h.interviews.reviseSemantics(p.id, s.hash, confirmation(s));
    const classified = h.store.spec(h.store.project(p.id).specId);
    h.interviews.approve(p.id, classified.hash);
    await h.interviews.finish(p.id, 'Additional delivery note.', false);
    const edited = h.store.spec(h.store.project(p.id).specId);
    assert.deepEqual(edited.requirements, classified.requirements);
    assert.deepEqual(edited.acceptanceItems, classified.acceptanceItems);
    assert.deepEqual(edited.semanticConfirmation, classified.semanticConfirmation);
    assert.notEqual(edited.hash, classified.hash);
    assert.equal(h.store.approved(p.id, classified.hash, 'SPEC'), false);
});

test('semantic boundary rejects missing, duplicate and foreign requirement references', async t => {
    const h = harness(t), { s } = await ready(h);
    for (const [edit, code] of [
        [raw => { raw.requirements = []; }, 'SEMANTIC_REQUIREMENT_COVERAGE'],
        [raw => { raw.requirements.push(raw.requirements[0]); }, 'SEMANTIC_REQUIREMENT_DUPLICATE'],
        [raw => { raw.requirements[0].id = 'FOREIGN'; }, 'SEMANTIC_REQUIREMENT_UNKNOWN'],
        [raw => { raw.acceptanceItems[0].requirementIds = ['FOREIGN']; }, 'ACCEPTANCE_REQUIREMENT_UNKNOWN'],
        [raw => { raw.acceptanceItems.push(raw.acceptanceItems[0]); }, 'ACCEPTANCE_DUPLICATE'],
        [raw => { raw.acceptanceItems = []; }, 'MUST_ACCEPTANCE_MISSING']
    ]) {
        const raw = confirmation(s); edit(raw);
        assert.throws(() => validateSemanticRevision(s, raw), { code });
    }
});

test('semantic boundary cannot replace raw requirements or authorize shell execution', async t => {
    const h = harness(t), { s } = await ready(h);
    const replacement = confirmation(s); replacement.requirements[0].text = 'Delete the original condition';
    assert.throws(() => validateSemanticRevision(s, replacement), { code: 'SEMANTIC_FIELD_NOT_ALLOWED' });
    const shell = confirmation(s); shell.acceptanceItems[0].command = ['node', 'untrusted.mjs'];
    assert.throws(() => validateSemanticRevision(s, shell), { code: 'SEMANTIC_FIELD_NOT_ALLOWED' });
    const secret = confirmation(s); secret.acceptanceItems[0].criterion = 'dsk-synthetic-secret-value';
    assert.throws(() => validateSemanticRevision(s, secret), { code: 'SECRET_IN_ACCEPTANCE' });
});

test('stale semantic confirmation and answer edits cannot retain old approval', async t => {
    const h = harness(t), p = h.interviews.create('Revisions', 'Keep all source statements.', 'demo');
    await h.interviews.next(p.id);
    const qid = h.store.project(p.id).questions[0].id;
    h.interviews.answer(p.id, qid, 'Original answer');
    await h.interviews.finish(p.id);
    const original = h.store.spec(h.store.project(p.id).specId);
    h.interviews.reviseSemantics(p.id, original.hash, confirmation(original));
    const current = h.store.spec(h.store.project(p.id).specId);
    assert.throws(() => h.interviews.reviseSemantics(p.id, original.hash, confirmation(original)), { code: 'SPEC_APPROVAL_STALE' });
    h.interviews.approve(p.id, current.hash);
    h.interviews.answer(p.id, qid, 'Changed answer');
    assert.equal(h.store.project(p.id).specId, null);
    assert.equal(h.store.spec(current.id).stale, true);
    assert.equal(h.store.approved(p.id, current.hash, 'SPEC'), false);
    assert.equal(h.store.project(p.id).answerHistory.length, 1);
});

test('long and contradictory source statements remain data without automatic semantic resolution', async t => {
    const h = harness(t), original = 'Offline operation is required. Cloud operation is required. ' + 'source '.repeat(800) + 'End.';
    const p = h.interviews.create('Source retention', original, 'demo');
    await h.interviews.finish(p.id);
    const spec = h.store.spec(h.store.project(p.id).specId);
    assert.equal(spec.requirements[0].text, original);
    assert.equal(spec.requirements[0].kind, undefined);
    assert.equal(spec.semanticConfirmation, undefined);
    const raw = confirmation(spec); raw.requirements[0].kind = 'constraint';
    h.interviews.reviseSemantics(p.id, spec.hash, raw);
    assert.equal(h.store.spec(h.store.project(p.id).specId).requirements[0].text, original);
});

test('authenticated HTTP confirms semantics once and rejects stale or source-changing requests', async t => {
    let app;
    t.after(async () => { await app?.close(); });
    const h = harness(t);
    app = await createApp({ root, data: h.dir, configPath: resolve(h.dir, 'http-config.json'), port: 0 });
    const login = await fetch(app.origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: app.bootstrap }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
    async function post(path, body, key = crypto.randomUUID()) {
        const response = await fetch(app.origin + '/api' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': key }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    }
    const created = await post('/projects', { name: 'HTTP semantics', idea: 'Preserve provenance.', mode: 'demo' });
    const pid = created.body.project.id, finished = await post(`/projects/${pid}/finish`, {}), original = finished.body.spec;
    const body = { specHash: original.hash, ...confirmation(original) };
    const first = await post(`/projects/${pid}/semantics`, body, 'semantic-once');
    assert.equal(first.status, 200);
    assert.equal(first.body.spec.acceptanceItems[0].evidenceStatus, 'NOT_RUN');
    const replay = await post(`/projects/${pid}/semantics`, body, 'semantic-once');
    assert.equal(replay.body.spec.id, first.body.spec.id);
    assert.equal((await post(`/projects/${pid}/semantics`, body)).status, 409);
    const wrong = { specHash: first.body.spec.hash, ...confirmation(first.body.spec), injectedField: 'change source' };
    assert.equal((await post(`/projects/${pid}/semantics`, wrong)).status, 400);
    assert.equal(app.store.project(pid).specId, first.body.spec.id);
});
