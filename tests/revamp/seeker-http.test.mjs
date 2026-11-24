import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../../dist/server/http.js';
import { defaults } from '../../dist/server/config.js';
import { SEEKER_PLANNER1_BINDING_VERSION } from '../../dist/server/planner1-binding.js';
import { root } from '../helpers.mjs';

// The Seeker routes over the real local HTTP server. No provider is reached: the api key env var is
// deliberately absent, so the dispatch refuses before any network call.

async function setup(t) {
    const parent = resolve(root, '.runtime/test-temp');
    mkdirSync(parent, { recursive: true });
    const data = mkdtempSync(resolve(parent, 'seeker-http-'));
    const configPath = resolve(data, 'config.json');
    // A complete settings file: the Seeker route differs from the defaults by identity only.
    const config = structuredClone(defaults);
    Object.assign(config.planner1, {
        provider: 'openai', bindingVersion: SEEKER_PLANNER1_BINDING_VERSION, authMode: 'api_key',
        model: 'SEEKER_OFFLINE_MODEL', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
        keyEnv: 'DM_SEEKER_HTTP_ABSENT'
    });
    writeFileSync(configPath, JSON.stringify(config));
    const app = await createApp({ root, data, configPath, port: 0 });
    t.after(async () => { await app.close(); rmSync(data, { recursive: true, force: true }); });
    const login = await fetch(app.origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: app.bootstrap }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
    const call = async (path, body) => {
        const response = await fetch(app.origin + '/api' + path, {
            method: body ? 'POST' : 'GET',
            headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    return { app, call };
}

test('H-01 a Live project on the Seeker route freezes the api_key route and exposes the draft routes', async t => {
    delete process.env.DM_SEEKER_HTTP_ABSENT;
    const { call } = await setup(t);
    const created = await call('/projects', { name: 'Seeker HTTP', idea: '做一个记录学习任务的本地工具', mode: 'live' });
    assert.equal(created.status, 200);
    const project = created.body.project;
    assert.equal(project.planner1Binding.provider, 'openai');
    assert.equal(project.planner1Binding.authMethod, 'api_key');
    assert.equal(project.planner1Binding.bindingVersion, SEEKER_PLANNER1_BINDING_VERSION);
    assert.equal(created.body.requirementsDraft, null);
    // No OAuth consent flag is required on the api_key route.
    assert.equal(created.body.project.planner1AuthMode, 'api_key');
    // Confirming or editing before a draft exists is a named refusal, not a generic failure.
    const confirm = await call('/projects/' + project.id + '/requirements/confirm', { draftHash: 'a'.repeat(64) });
    assert.equal(confirm.status, 409);
    assert.equal(confirm.body.error, 'REQUIREMENTS_DRAFT_REQUIRED');
    const revise = await call('/projects/' + project.id + '/requirements/revise', { requirements: [] });
    assert.equal(revise.status, 409);
    assert.equal(revise.body.error, 'REQUIREMENTS_DRAFT_REQUIRED');
    const missingHash = await call('/projects/' + project.id + '/requirements/confirm', {});
    assert.equal(missingHash.status, 400);
    assert.equal(missingHash.body.error, 'REQUIREMENTS_DRAFT_HASH_REQUIRED');
    // The first question was attempted at creation and refused for the missing key, with no network.
    const next = await call('/projects/' + project.id + '/next', {});
    assert.equal(next.body.error, 'PLANNER1_KEY_MISSING');
    assert.equal(confirm.body.error === 'REQUIREMENTS_DRAFT_REQUIRED', true);
});

test('H-02 a Demo project never enters the Seeker draft pipeline', async t => {
    const { call } = await setup(t);
    const demo = await call('/projects', { name: 'Demo', idea: '记录工具', mode: 'demo' });
    assert.equal(demo.status, 200);
    const draft = await call('/projects/' + demo.body.project.id + '/requirements/draft', {});
    assert.equal(draft.status, 409);
    assert.equal(draft.body.error, 'SEEKER_DRAFT_LIVE_ONLY');
});

test('H-03 the reviewer hand-back route names an unknown run', async t => {
    const { call } = await setup(t);
    const response = await call('/runs/run_missing/seeker-interpret', { runId: 'run_missing' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'RUN_NOT_FOUND');
});
