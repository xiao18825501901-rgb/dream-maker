import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaults, parseConfig, Settings } from '../../dist/server/config.js';
import { planner1Binding, planner1BindingHash, assertPlanner1DispatchAllowed, isRetiredProvider, SEEKER_PLANNER1_BINDING_VERSION } from '../../dist/server/planner1-binding.js';
import { projectSeekerRoute, isSeekerApiBinding } from '../../dist/server/seeker-route.js';
import { Interviews } from '../../dist/server/interview.js';
import { harness, until } from '../helpers.mjs';

// Seeker route: planner1 answers through the official HTTP API on an api_key credential. The Kimi
// OAuth binding stays a frozen historical identity, so no existing project is moved by a settings
// change. These tests pin the route identity, not the interview content.

const seeker = (extra = {}) => {
    const c = structuredClone(defaults);
    Object.assign(c.planner1, {
        provider: 'openai', bindingVersion: SEEKER_PLANNER1_BINDING_VERSION, authMode: 'api_key',
        model: 'SEEKER_OFFLINE_MODEL', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
        keyEnv: 'DM_SEEKER_TEST_KEY'
    }, extra);
    return parseConfig(c);
};
const oauth = () => {
    const c = structuredClone(defaults);
    Object.assign(c.planner1, { provider: 'kimi', bindingVersion: 1, model: 'kimi-code', accountRef: 'offline-owner-account', policyHash: 'policy-sha', protocolHash: 'protocol-sha' });
    return parseConfig(c);
};
const stubInterviews = (h, model) => {
    const interviews = new Interviews(h.store, model, h.laya, () => h.config);
    h.t.after?.(() => {});
    return interviews;
};

test('S-01 the Seeker route is an api_key dispatch path, distinct from the Kimi OAuth identity', () => {
    const binding = planner1Binding(seeker());
    assert.equal(binding.provider, 'openai');
    assert.equal(binding.runner, 'http-api');
    assert.equal(binding.authMethod, 'api_key');
    assert.equal(binding.bindingVersion, SEEKER_PLANNER1_BINDING_VERSION);
    assert.equal(binding.credentialRef, 'DM_SEEKER_TEST_KEY');
    assert.equal(isRetiredProvider(binding.provider, binding.bindingVersion), false);
    assert.doesNotThrow(() => assertPlanner1DispatchAllowed(binding, 'seeker_api_test'));
    assert.equal(isSeekerApiBinding(binding), true);

    const legacy = planner1Binding(oauth());
    assert.equal(legacy.authMethod, 'oauth');
    assert.equal(isSeekerApiBinding(legacy), false);
    // Two frozen identities, not one upgraded in place.
    assert.notEqual(planner1BindingHash(binding), planner1BindingHash(legacy));
    assert.match(planner1BindingHash(binding), /^[a-f0-9]{64}$/);
});

test('S-02 the Seeker route refuses anything but the official API endpoints', () => {
    assert.throws(() => planner1Binding(seeker({ provider: 'kimi' })), { code: 'PLANNER1_PROVIDER_ROUTE_MISMATCH' });
    // A foreign host never even reaches the binding: configuration refuses it first.
    assert.throws(() => seeker({ baseUrl: 'https://api.example.com/v1' }), { code: 'API_HOST_NOT_ALLOWED' });
    assert.throws(() => planner1Binding(seeker({ authMode: 'siwc_plan' })), { code: 'PLANNER1_PROVIDER_ROUTE_MISMATCH' });
    assert.throws(() => planner1Binding(seeker({ protocol: 'chat-completions' })), { code: 'PLANNER1_PROVIDER_ROUTE_MISMATCH' });
    const deepseek = planner1Binding(seeker({ provider: 'deepseek', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com', keyEnv: 'DM_SEEKER_TEST_KEY' }));
    assert.equal(deepseek.authMethod, 'api_key');
    assert.equal(isSeekerApiBinding(deepseek), true);
});

test('S-03 selecting the Seeker route is explicit; a legacy API selection keeps version 2', t => {
    const dir = harness(t).dir;
    const path = resolve(dir, 'settings-seeker.json');
    writeFileSync(path, JSON.stringify(oauth()));
    const settings = new Settings(path);
    assert.equal(settings.value.planner1.provider, 'kimi');

    settings.selectPlanner1({ provider: 'openai', authentication: 'api_key', model: 'SEEKER_OFFLINE_MODEL', route: 'seeker_api', confirmed: true });
    assert.equal(settings.value.planner1.bindingVersion, SEEKER_PLANNER1_BINDING_VERSION);
    assert.equal(settings.public().planner1Binding.authMethod, 'api_key');
    assert.equal(isSeekerApiBinding(settings.public().planner1Binding), true);

    // No route field: the earlier version 2 API selection, so nothing is silently promoted.
    settings.selectPlanner1({ provider: 'openai', authentication: 'api_key', model: 'LEGACY_MODEL', confirmed: true });
    assert.equal(settings.value.planner1.bindingVersion, 2);
    assert.equal(isSeekerApiBinding(settings.public().planner1Binding), false);
    assert.throws(() => settings.selectPlanner1({ provider: 'openai', authentication: 'api_key', model: 'M', route: 'seeker_plus', confirmed: true }), { code: 'INVALID_ENUM' });
    assert.throws(() => settings.selectPlanner1({ provider: 'openai', authentication: 'oauth', model: 'M', route: 'seeker_api', confirmed: true }), { code: 'PLANNER1_OFFICIAL_AUTH_UNAVAILABLE' });
});

test('S-04 a project freezes the route it was created on and is never silently re-routed', async t => {
    const h = harness(t);
    const seekerConfig = seeker();
    for (const [key, value] of Object.entries(seekerConfig.planner1)) h.config.planner1[key] = value;
    const model = { complete: async () => ({ data: { topic: 'goal', text: '第一版最重要的一次操作是什么？', suggestion: '', prerequisites: [], options: [{ id: 'A', label: '开始使用' }, { id: 'B', label: '记录内容' }, { id: 'C', label: '查看结果' }, { id: 'D', label: '导出数据' }], allowMultiple: true }, usage: { role: 'planner1' } }) };
    const interviews = new Interviews(h.store, model, h.laya, () => h.config);
    try {
        const p = interviews.create('Seeker 路线', '做一个记录学习任务的本地工具', 'live');
        assert.equal(p.planner1Binding.provider, 'openai');
        assert.equal(p.planner1Binding.authMethod, 'api_key');
        assert.equal(p.planner1Binding.bindingVersion, SEEKER_PLANNER1_BINDING_VERSION);
        assert.equal(projectSeekerRoute(p), true);
        await until(() => h.store.project(p.id).questions.length === 1);
        const question = h.store.project(p.id).questions[0];
        interviews.answer(p.id, question.id, '先记录当天任务');
        // A later settings change must invalidate the frozen route instead of re-routing the project.
        const kimi = oauth();
        for (const [key, value] of Object.entries(kimi.planner1)) h.config.planner1[key] = value;
        await assert.rejects(interviews.next(p.id), { code: 'PROJECT_PLANNER1_BINDING_MISMATCH' });
    } finally { await interviews.close(); }
});

test('S-05 an OAuth project keeps OAuth as its frozen identity', async t => {
    const h = harness(t);
    const kimi = oauth();
    for (const [key, value] of Object.entries(kimi.planner1)) h.config.planner1[key] = value;
    const interviews = new Interviews(h.store, { complete: async () => { throw new Error('kimi must not reach the HTTP transport'); } }, h.laya, () => h.config);
    try {
        const p = interviews.create('OAuth 项目', '做一个记录工具', 'live');
        assert.equal(p.planner1Binding.provider, 'kimi');
        assert.equal(p.planner1Binding.authMethod, 'oauth');
        assert.equal(p.planner1Binding.bindingVersion, 1);
        assert.equal(projectSeekerRoute(p), false);
        // No Seeker skill pipeline and no automatic first question on the OAuth route.
        await new Promise(r => setTimeout(r, 20));
        assert.equal(h.store.project(p.id).questions.length, 0);
        const seekerConfig = seeker();
        for (const [key, value] of Object.entries(seekerConfig.planner1)) h.config.planner1[key] = value;
        await assert.rejects(interviews.next(p.id), { code: 'PROJECT_PLANNER1_BINDING_MISMATCH' });
    } finally { await interviews.close(); }
});
