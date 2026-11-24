import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { harness, ready, root } from '../helpers.mjs';
import { Store, APPLICATION_SCHEMA_VERSION } from '../../dist/server/store.js';
import { createApp } from '../../dist/server/http.js';
import { compileSpec } from '../../dist/server/compile.js';

test('plan snapshots preserve three complete versions and approval history after edits', async t => {
    const h = harness(t), p = h.interviews.create('版本历史', '制作本机任务记录工具。', 'demo');
    await h.interviews.finish(p.id, '第一版', false);
    const first = h.store.project(p.id).specId;
    h.interviews.approve(p.id, h.store.spec(first).hash);
    const saved = h.store.planVersion(first);
    await h.interviews.finish(p.id, '第二版', false);
    await h.interviews.finish(p.id, '第三版', false);
    const versions = h.store.planVersions(p.id);
    assert.equal(versions.length, 3);
    assert.deepEqual(versions.map(v => v.revision), [1, 2, 3]);
    assert.equal(versions[1].parentId, first);
    assert.equal(versions[2].parentId, versions[1].id);
    assert.deepEqual(h.store.planVersion(first), saved);
    assert.equal(saved.snapshot.notes, '第一版');
    assert.equal(saved.source.idea, p.idea);
    assert.equal(saved.approval.actor, 'LOCAL_OPERATOR');
    assert.equal(h.store.approved(p.id, saved.specHash, 'SPEC'), false);
    assert.equal(versions[2].approval, null);
    assert.equal(h.store.runs(p.id).length, 0);
});

test('plan and approval tables reject in-place changes and the spec may only change its stale flag', async t => {
    const h = harness(t), { p, s } = await ready(h);
    const version = h.store.planVersion(s.id);
    for (const table of ['plan_versions', 'plan_version_approvals']) {
        assert.throws(() => h.store.db.prepare(`DELETE FROM ${table}`).run(), /IMMUTABLE_PLAN/);
    }
    assert.throws(() => h.store.db.prepare('UPDATE plan_versions SET snapshot=? WHERE id=?').run('{}', s.id), /IMMUTABLE_PLAN/);
    assert.throws(() => h.store.saveSpec({ ...s, notes: 'silently changed' }), { code: 'IMMUTABLE_PLAN' });
    h.store.saveSpec({ ...s, stale: true });
    assert.deepEqual(h.store.planVersion(s.id), version);
    assert.equal(h.store.spec(s.id).stale, true);
    assert.equal(h.store.project(p.id).specId, s.id);
});

test('new versions reject stale input and pause keeps the project closed to replanning', async t => {
    const h = harness(t, 50), { p, s } = await ready(h);
    assert.throws(() => h.store.saveSpec({ ...s, id: 'spec_late', revision: 2 }), { code: 'STALE_PLAN_INPUT' });
    const run = h.engine.create(p.id, s.hash, true);
    assert.equal(run.planVersionId, s.id);
    assert.equal(run.planVersionHash, h.store.planVersion(s.id).contentHash);
    h.engine.pause(run.id);
    await h.engine.settled(run.id);
    await assert.rejects(h.interviews.finish(p.id, 'new direction', false), { code: 'RUN_MUST_STOP_BEFORE_EDIT' });
    assert.equal(h.store.planVersions(p.id).length, 1);
});

test('a late plan cannot append onto a different parent or skip a revision', async t => {
    const h = harness(t), { p, s } = await ready(h);
    const current = h.store.project(p.id);
    const next = compileSpec(current, 2, 'second');
    assert.throws(() => h.store.saveSpec(next, null), { code: 'STALE_PLAN_PARENT' });
    assert.throws(() => h.store.saveSpec({ ...next, revision: 4 }, s.id), { code: 'INVALID_PLAN_REVISION' });
    h.store.saveSpec(next, s.id);
    assert.throws(() => h.store.saveSpec(compileSpec(current, 3, 'late'), s.id), { code: 'STALE_PLAN_PARENT' });
    assert.equal(h.store.planVersions(p.id).length, 2);
});

test('reading a changed current spec fails against its immutable snapshot', async t => {
    const h = harness(t), { s } = await ready(h);
    h.store.db.prepare('UPDATE specs SET data=? WHERE id=?').run(JSON.stringify({ ...s, notes: 'changed outside Store' }), s.id);
    assert.throws(() => h.store.spec(s.id), { code: 'PLAN_INTEGRITY_FAILED' });
    assert.equal(h.store.planVersion(s.id).snapshot.notes, s.notes);
});

test('migration preserves legacy spec bytes and never fabricates historical approval', async t => {
    const h = harness(t), { p, s } = await ready(h);
    const path = resolve(h.dir, 'legacy.sqlite');
    const old = new DatabaseSync(path);
    old.exec(readFileSync(resolve(root, 'migrations/001_initial.sql'), 'utf8'));
    old.prepare('INSERT INTO projects VALUES(?,?,?)').run(p.id, p.version, JSON.stringify(p));
    old.prepare('INSERT INTO specs VALUES(?,?,?,?)').run(s.id, p.id, s.hash, JSON.stringify(s));
    old.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run('old-approval', p.id, s.hash, 'SPEC', s.createdAt);
    old.close();
    const migrated = new Store(path);
    try {
        assert.deepEqual(migrated.spec(s.id), s);
        const version = migrated.planVersion(s.id);
        assert.equal(version.origin, 'LEGACY_IMPORTED');
        assert.equal(version.approval, null);
        assert.equal(migrated.approved(p.id, s.hash, 'SPEC'), true);
        assert.equal(migrated.db.prepare('SELECT MAX(version) v FROM schema_versions').get().v, APPLICATION_SCHEMA_VERSION);
        assert.equal(migrated.db.prepare('SELECT count(*) n FROM managed_dataset_versions').get().n, 0);
        assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { migrated.close(); }
});

test('authenticated plan history keeps CSRF and obtains actor identity from the session', async t => {
    const parent = resolve(root, '.runtime/test-temp');
    mkdirSync(parent, { recursive: true });
    const data = mkdtempSync(resolve(parent, 'revamp-http-'));
    const app = await createApp({ root, data, configPath: resolve(data, 'config.json'), port: 0 });
    t.after(async () => { await app.close(); rmSync(data, { recursive: true, force: true }); });
    const login = await fetch(app.origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: app.bootstrap }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
    const request = async (path, body) => {
        const r = await fetch(app.origin + '/api' + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
        assert.equal(r.status, 200);
        return r.json();
    };
    let snapshot = await request('/projects', { name: 'history', idea: 'keep original inputs', mode: 'demo' });
    const pid = snapshot.project.id;
    snapshot = await request(`/projects/${pid}/finish`, { summarize: false });
    await request(`/projects/${pid}/approve`, { specHash: snapshot.spec.hash, actor: { type: 'user', id: 'FORGED_ACTOR' } });
    const history = await request(`/projects/${pid}/plans`);
    assert.equal(history.plans.length, 1);
    assert.notEqual(history.plans[0].approval.actor, 'FORGED_ACTOR');
    assert.match(history.plans[0].approval.actor, /^local-session:[a-f0-9]{64}$/);
    assert.equal((await fetch(app.origin + `/api/projects/${pid}/plans`)).status, 401);
    const denied = await fetch(app.origin + `/api/projects/${pid}/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ specHash: snapshot.spec.hash }) });
    assert.equal(denied.status, 403);
});
