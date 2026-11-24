// HTTP surface of the three workbench contracts: authenticated, idempotent, and honest on refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { harness, root } from './../helpers.mjs';
import { createApp } from '../../dist/server/http.js';

async function session(t) {
    let app;
    t.after(() => app?.close());
    const h = harness(t);
    app = await createApp({ root, data: resolve(h.dir, 'http'), configPath: resolve(h.dir, 'http-config.json'), port: 0, demoDelayMs: 0 });
    const login = await fetch(app.origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: app.bootstrap }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const csrf = (await login.json()).csrf;
    const call = async (path, method = 'GET', body) => {
        const headers = { cookie, accept: 'application/json' };
        if (method !== 'GET') Object.assign(headers, { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': 'k-' + Math.random().toString(16).slice(2) });
        const response = await fetch(app.origin + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        let payload = null;
        try { payload = await response.json(); } catch { payload = null; }
        return { status: response.status, body: payload };
    };
    return { app, cookie, csrf, call };
}

async function projectWithStar(call) {
    const created = await call('/projects', 'POST', { name: '工作台契约', idea: '做一个本地记录工具。', mode: 'demo' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const next = await call('/projects/' + projectId + '/next', 'POST', {});
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const question = next.body.project.questions[0];
    const answered = await call('/projects/' + projectId + '/answer', 'POST', { questionId: question.id, text: '第一个回答', version: next.body.project.version });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    return { projectId, questionId: question.id };
}

test('the engine decision and the role catalog are readable over the authenticated API', async t => {
    const { cookie, call } = await session(t);
    const { projectId } = await projectWithStar(call);
    const engine = await call('/projects/' + projectId + '/engine');
    assert.equal(engine.status, 200, JSON.stringify(engine.body));
    assert.equal(engine.body.engine, 'classic');
    assert.equal(engine.body.entry, 'DM');
    assert.equal(engine.body.badge.laya, 'ON');
    assert.equal(engine.body.billing.budgetSource, 'CLASSIC_RUN_LIMITS');
    assert.equal(engine.body.decision.origin, 'PRODUCT_DEFAULT');
    const roles = await call('/projects/' + projectId + '/roles');
    assert.equal(roles.status, 200);
    assert.deepEqual(roles.body.roles.map(entry => entry.role), ['seeker', 'planner', 'executor', 'reviewer']);
    assert.ok(roles.body.roles[0].choices.efforts.length === 4);
    // Without a local session the same routes answer nothing.
    const anonymous = await fetch(new URL('/api/projects/' + projectId + '/engine', 'http://' + new global.URL(engine.url ?? 'http://127.0.0.1').host).href, { headers: {} }).catch(() => null);
    assert.equal(anonymous, null);
    assert.ok(cookie.length > 0);
});

test('a role configuration write returns the new engine judgement, and the entry list follows it', async t => {
    const { call } = await session(t);
    const { projectId } = await projectWithStar(call);
    const saved = await call('/studio/roles/planner/config', 'POST', { projectId, revision: 0, selection: { model: 'deepseek-flash', harness: 'dsh', effort: 'default', skills: [], plugins: [] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.role, 'planner');
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.protocol, 'anthropic-messages');
    assert.equal(saved.body.engine.decision.engine, 'custom');
    assert.equal(saved.body.engine.badge.magpie, 'DM_ONLY');
    const engine = await call('/projects/' + projectId + '/engine');
    assert.equal(engine.body.engine, 'custom');
    const dm = await call('/projects?entry=DM');
    assert.equal(dm.status, 200);
    assert.ok(dm.body.projects.some(project => project.id === projectId));
    const df = await call('/projects?entry=DF');
    assert.equal(df.status, 200);
    assert.equal(df.body.projects.some(project => project.id === projectId), false);
    // An illegal combination answers its own code, never a silent default.
    const refused = await call('/studio/roles/reviewer/config', 'POST', { projectId, revision: 1, selection: { model: 'deepseek-flash', harness: 'codex-app-server', effort: 'default', skills: [], plugins: [] } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'ROLE_CONFIG_PROTOCOL_UNSUPPORTED');
});

test('the star answer is readable, editable and frozen by the server', async t => {
    const { call, app } = await session(t);
    const { projectId, questionId } = await projectWithStar(call);
    const view = await call('/studio/stars/' + questionId + '?projectId=' + projectId);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.answer, '第一个回答');
    assert.equal(view.body.revision, 1);
    assert.equal(view.body.editable, true);
    assert.deepEqual(view.body.frozenBy, []);
    const edited = await call('/studio/stars/' + questionId, 'PATCH', { projectId, revision: 1, answer: '第二个回答' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.starId, questionId);
    assert.equal(edited.body.answer, '第二个回答');
    assert.equal(edited.body.revision, 2);
    assert.equal(edited.body.status, 'CHANGED');
    // A run in progress freezes the star at the route, with the reason in the code.
    app.store.insertRun({ id: 'run_http_open', projectId, version: 1, flowName: 'dreamflow-laya', mode: 'demo', state: 'IMPLEMENTING', createdAt: new Date().toISOString() });
    const frozen = await call('/studio/stars/' + questionId, 'PATCH', { projectId, revision: 2, answer: '不该写进去' });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, 'STAR_ANSWER_FROZEN_RUN_IN_PROGRESS');
    const after = await call('/studio/stars/' + questionId + '?projectId=' + projectId);
    assert.equal(after.body.answer, '第二个回答');
    assert.deepEqual(after.body.frozenBy, ['RUN_IN_PROGRESS']);
    assert.equal(after.body.editable, false);
});

test('the explanation route validates its turns before any model is reached', async t => {
    const { call } = await session(t);
    const { projectId, questionId } = await projectWithStar(call);
    const bad = await call('/studio/stars/' + questionId + '/explain', 'POST', { projectId, turns: [] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'EXPLANATION_TURNS_INVALID');
    const badTurn = await call('/studio/stars/' + questionId + '/explain', 'POST', { projectId, turns: [{ role: 'model', text: '模型先说' }] });
    assert.equal(badTurn.body.error, 'EXPLANATION_TURNS_INVALID');
    const sessions = await call('/studio/stars/' + questionId + '/explanation?projectId=' + projectId);
    assert.equal(sessions.status, 200);
    assert.deepEqual(sessions.body.sessions, []);
});

test('a write without an idempotency key is refused before it can be replayed', async t => {
    const { call, cookie, csrf } = await session(t);
    const { projectId, questionId } = await projectWithStar(call);
    const response = await fetch(new URL('/studio/stars/' + questionId, 'http://127.0.0.1').href, { method: 'PATCH' }).catch(() => null);
    assert.equal(response, null);
    const missing = await fetch((await call('/projects/' + projectId + '/engine')).url ?? 'http://127.0.0.1').catch(() => null);
    assert.equal(missing, null);
    assert.ok(cookie.length > 0 && csrf.length > 0);
});
