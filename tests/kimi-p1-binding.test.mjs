import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaults, parseConfig, Settings } from '../dist/server/config.js';
import { planner1Binding, planner1BindingHash, assertPlanner1DispatchAllowed, isRetiredProvider, RETIRED_PLANNER1_PROVIDERS } from '../dist/server/planner1-binding.js';
import { Interviews } from '../dist/server/interview.js';
import { harness } from './helpers.mjs';
import { offlineKimi } from './fixtures/offline-kimi.mjs';

// K02: planner1 is Kimi-only. The historical OpenAI/SIWC planners stay readable
// (old projects and evidence) but must be REFUSED at the execution boundary,
// not merely hidden in the UI. These tests pin that contract.

const kimi = () => {
    const c = structuredClone(defaults);
    c.planner1.provider = 'kimi';
    c.planner1.accountRef = 'local-owner-account';
    c.planner1.model = 'kimi-code';
    c.planner1.policyHash = 'policy-sha256-placeholder';
    c.planner1.protocolHash = 'protocol-sha256-placeholder';
    c.planner1.keyEnv = 'Dream_Maker_codex';
    return parseConfig(c);
};

test('K02-01 a legacy config without an explicit provider is derived as a retired upstream', () => {
    const b = planner1Binding(parseConfig(structuredClone(defaults)));
    assert.equal(b.provider, 'openai');
    assert.equal(b.runner, 'http-api');
    assert.equal(b.authMethod, 'api_key');
    assert.equal(b.credentialRef, 'OPENAI_API_KEY');
    assert.equal(isRetiredProvider(b.provider), true);
    assert.throws(() => assertPlanner1DispatchAllowed(b), { code: 'PLANNER1_PROVIDER_RETIRED' });
});

test('K02-02 siwc and chat-completions legacy files derive their own retired provider', () => {
    const siwc = structuredClone(defaults);
    siwc.planner1.authMode = 'siwc_plan';
    const sb = planner1Binding(parseConfig(siwc));
    assert.equal(sb.provider, 'siwc');
    assert.equal(sb.runner, 'siwc-sdk');
    assert.equal(sb.credentialRef, '');
    assert.throws(() => assertPlanner1DispatchAllowed(sb), { code: 'PLANNER1_PROVIDER_RETIRED' });

    const chat = structuredClone(defaults);
    chat.planner1.protocol = 'chat-completions';
    chat.planner1.baseUrl = 'https://api.deepseek.com';
    const cb = planner1Binding(parseConfig(chat));
    assert.equal(cb.provider, 'deepseek');
    assert.throws(() => assertPlanner1DispatchAllowed(cb), { code: 'PLANNER1_PROVIDER_RETIRED' });
});

test('K02-03 an explicit Kimi binding is the only one allowed to dispatch', () => {
    const b = planner1Binding(kimi());
    assert.equal(b.provider, 'kimi');
    assert.equal(b.runner, 'kimi-server');
    assert.equal(b.authMethod, 'oauth');
    assert.equal(b.credentialRef, '');
    assert.equal(b.accountRef, 'local-owner-account');
    assert.equal(b.bindingVersion, 1);
    assert.equal(RETIRED_PLANNER1_PROVIDERS.includes('kimi'), false);
    assert.doesNotThrow(() => assertPlanner1DispatchAllowed(b));
    assert.match(planner1BindingHash(b), /^[a-f0-9]{64}$/);
});

test('K02-04 the binding fingerprint separates identity fields that must not be conflated', () => {
    const a = planner1Binding(kimi());
    const moved = { ...a, model: 'other-model' };
    const account = { ...a, accountRef: 'other-account' };
    const policy = { ...a, policyHash: 'different-policy' };
    const hashes = new Set([planner1BindingHash(a), planner1BindingHash(moved), planner1BindingHash(account), planner1BindingHash(policy)]);
    assert.equal(hashes.size, 4);
});

test('K02-05 settings refuse to switch into a retired planner1 but keep an existing binding editable', t => {
    const dir = harness(t).dir;
    const path = resolve(dir, 'settings-kimi.json');
    writeFileSync(path, JSON.stringify(kimi()));
    const settings = new Settings(path);
    assert.equal(settings.value.planner1.provider, 'kimi');
    assert.equal(settings.public().planner1Retired, false);

    assert.throws(() => settings.updateUI({ planner1: { provider: 'siwc', protocol: 'openai-responses', model: 'kimi-code' } }), { code: 'PLANNER1_PROVIDER_RETIRED' });
    assert.throws(() => settings.updateUI({ planner1: { provider: 'openai', protocol: 'openai-responses', model: 'kimi-code' } }), { code: 'PLANNER1_PROVIDER_RETIRED' });
    assert.throws(() => settings.updateUI({ planner1: { provider: 'not-a-provider', protocol: 'openai-responses', model: 'kimi-code' } }), { code: 'INVALID_ENUM' });
    assert.equal(settings.value.planner1.provider, 'kimi');

    settings.updateUI({ planner1: { provider: 'kimi', protocol: 'openai-responses', model: 'kimi-code-next' } });
    assert.equal(settings.value.planner1.model, 'kimi-code-next');
});

test('K02-06 a legacy local settings file stays readable but reports itself retired', t => {
    const dir = harness(t).dir;
    const path = resolve(dir, 'settings-legacy.json');
    const legacy = structuredClone(defaults);
    legacy.planner1.keyEnv = 'Dream_Maker_codex';
    writeFileSync(path, JSON.stringify(legacy));
    const settings = new Settings(path);
    const view = settings.public();
    assert.equal(view.planner1Retired, true);
    assert.equal(view.planner1Binding.provider, 'openai');
    assert.equal(view.planner1Binding.credentialRef, 'Dream_Maker_codex');
    assert.match(view.planner1RetiredReason, /已退役/);
    // Editing the model of an already-retired binding is allowed; it still cannot dispatch.
    settings.updateUI({ planner1: { protocol: 'openai-responses', model: 'OFFLINE_MODEL' } });
    assert.equal(settings.value.planner1.keyEnv, 'Dream_Maker_codex');
    assert.equal(settings.public().planner1Retired, true);
});

test('K02-07 creating a Live project on a retired planner1 is refused before any model call', () => {
    const h = harness(test);
    let calls = 0;
    h.model.complete = async () => { calls++; throw new Error('must not be reached'); };
    assert.throws(() => h.interviews.create('Legacy live', 'A simple test idea', 'live'), { code: 'PLANNER1_PROVIDER_RETIRED' });
    assert.equal(calls, 0);
    // Demo projects never bind planner1 and remain creatable.
    const demo = h.interviews.create('Demo', 'A simple demo idea', 'demo');
    assert.equal(demo.planner1Binding, undefined);
    assert.equal(demo.planner1AuthMode, undefined);
});

test('K02-08 a Live project freezes the full Kimi binding and is re-checked before dispatch', () => {
    const h = harness(test);
    const k = kimi();
    for (const [key, value] of Object.entries(k.planner1)) h.config.planner1[key] = value;
    const p = h.interviews.create('Kimi live', 'A simple test idea', 'live');
    assert.equal(p.planner1Binding.provider, 'kimi');
    assert.equal(p.planner1Binding.runner, 'kimi-server');
    assert.equal(p.planner1Binding.authMethod, 'oauth');
    assert.equal(p.planner1Binding.policyHash, 'policy-sha256-placeholder');
    assert.match(p.planner1Binding.bindingHash, /^[a-f0-9]{64}$/);

    // A later settings change must invalidate the frozen binding instead of re-routing it.
    h.config.planner1.accountRef = 'a-different-account';
    return h.interviews.next(p.id).then(
        () => assert.fail('dispatch must be blocked'),
        error => {
            assert.equal(error.code, 'PROJECT_PLANNER1_BINDING_MISMATCH');
        }
    );
});

test('K02-10 a failed planner1 dispatch records only a stable code under the Kimi binding', async () => {
    // Replacement for the archived C06: the failure record must keep the stable code and never
    // the upstream body, bearer value or model output.
    const h = harness(test);
    const k = kimi();
    for (const [key, value] of Object.entries(k.planner1)) h.config.planner1[key] = value;
    const rejected = { code: 'KIMI_OAUTH_REQUIRED', message: 'Bearer secret-do-not-log' };
    h.config.kimi.enabled = true;
    const interviews = new Interviews(h.store, { complete: () => assert.fail('Kimi must not fall back to the API') }, h.laya, () => h.config,
        offlineKimi(h.dir, () => Promise.reject(rejected)));
    const p = interviews.create('Sample', 'Describe a simple app', 'live');
    await assert.rejects(interviews.next(p.id));
    const records = h.store.records(p.id, 'ModelAttemptFailure');
    assert.equal(records.length, 1);
    assert.equal(records[0].data.code, 'KIMI_OAUTH_REQUIRED');
    assert.equal(JSON.stringify(records[0].data).includes('secret-do-not-log'), false);
    await interviews.close();
});

test('K02-09 the legacy HTTP transport refuses to stand in for the Kimi runner', async () => {
    const h = harness(test);
    const k = kimi();
    for (const [key, value] of Object.entries(k.planner1)) h.config.planner1[key] = value;
    await assert.rejects(h.model.complete({ task: 'summary' }), { code: 'PLANNER1_RUNNER_ROUTE_MISMATCH' });
    await assert.rejects(h.model.models(), { code: 'PLANNER1_RUNNER_ROUTE_MISMATCH' });
});
