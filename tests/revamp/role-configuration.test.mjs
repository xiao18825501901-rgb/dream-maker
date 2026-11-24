// The role-configuration write contract: legal combinations pass, illegal ones are refused by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';
import { WorkbenchContracts } from '../../dist/server/workbench-contracts.js';
import { magpieRoleRegistry } from '../../dist/server/role-configuration.js';

const actor = 'local-session:' + 'a'.repeat(64);
const operation = label => hash('dm-role-config-' + label);
const registeredDigest = '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40';
const pick = (model, harnessName, effort = 'default', extra = {}) => ({ model, harness: harnessName, effort, skills: [], plugins: [], ...extra });

function bench(h, registry) {
    return new WorkbenchContracts({
        store: h.store, config: () => h.config, interviews: h.interviews,
        ...(registry === undefined ? {} : { registry: () => registry })
    });
}

test('a legal combination is stored, and the write returns the new engine decision', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    const { p } = await ready(h);
    const bench1 = bench(h);
    const saved = bench1.saveRole(p.id, 'planner', { revision: 0, selection: pick('deepseek-flash', 'dsh') }, actor, operation('legal'));
    assert.equal(saved.role, 'planner');
    assert.equal(saved.revision, 1);
    assert.equal(saved.protocol, 'anthropic-messages');
    assert.equal(saved.selection.harness, 'dsh');
    assert.equal(saved.selection.model, 'deepseek-flash');
    assert.equal(saved.engine.decision.engine, 'custom');
    assert.equal(saved.engine.badge.magpie, 'DM_ONLY');
    // The stored readback is the same answer, not a second opinion.
    const view = bench1.engine(p.id);
    assert.equal(view.engine, saved.engine.decision.engine);
    assert.equal(view.roles.selection.planner2.harness, 'dsh');
});

test('a combination whose model speaks no wire the harness offers is refused', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    const { p } = await ready(h);
    const bench1 = bench(h);
    // codex-app-server speaks openai-responses only; deepseek-flash declares messages + chat.
    assert.throws(
        () => bench1.saveRole(p.id, 'reviewer', { revision: 0, selection: pick('deepseek-flash', 'codex-app-server') }, actor, operation('cross-wire')),
        error => error.code === 'ROLE_CONFIG_PROTOCOL_UNSUPPORTED' && /没有交集/.test(error.message)
    );
    assert.equal(h.store.records(p.id, 'ProjectRoleConfiguration').length, 0);
});

test('an unknown model, an unregistered harness for the role and a bad effort are each named', async t => {
    const h = harness(t);
    const { p } = await ready(h);
    const bench1 = bench(h);
    assert.throws(() => bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('no-such-model', 'dsh') }, actor, operation('unknown-model')), error => error.code === 'ROLE_CONFIG_MODEL_UNKNOWN');
    assert.throws(() => bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'codex-app-server') }, actor, operation('wrong-harness')), error => error.code === 'ROLE_CONFIG_HARNESS_NOT_REGISTERED_FOR_ROLE');
    assert.throws(() => bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'dsh', 'extreme') }, actor, operation('bad-effort')), error => error.code === 'ROLE_CONFIG_EFFORT_INVALID');
    assert.throws(() => bench1.saveRole(p.id, 'nobody', { revision: 0, selection: pick('deepseek-flash', 'dsh') }, actor, operation('bad-role')), error => error.code === 'ROLE_CONFIG_ROLE_UNKNOWN');
    assert.throws(() => bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('sk-live-0123456789abcdef', 'dsh') }, actor, operation('secret')), error => error.code === 'ROLE_CONFIG_INPUT_INVALID');
    assert.throws(() => bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'dsh', 'default', { skills: ['not-a-skill'] }) }, actor, operation('bad-skill')), error => error.code === 'ROLE_CONFIG_SKILL_UNKNOWN');
    assert.equal(h.store.records(p.id, 'ProjectRoleConfiguration').length, 0);
});

test('a Magpie lane needs the exact reviewed build digest, not just a protocol match', async t => {
    const h = harness(t);
    const { p } = await ready(h);
    const catalog = { models: [{ id: 'deepseek-flash', protocols: ['anthropic-messages', 'chat-completions'] }, { id: 'chat-only-model', protocols: ['chat-completions'] }, { id: 'gpt-6-luna', protocols: ['openai-responses'] }] };
    const reviewed = bench(h, magpieRoleRegistry(catalog, registeredDigest));
    const saved = reviewed.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'cline') }, actor, operation('magpie-ok'));
    assert.equal(saved.protocol, 'anthropic-messages');
    assert.equal(saved.engine.decision.engine, 'custom');
    // Same combination, exact build not in the reviewed set: refused, never dispatched on trust.
    const unreviewed = bench(h, magpieRoleRegistry(catalog, 'b'.repeat(64)));
    assert.throws(
        () => unreviewed.saveRole(p.id, 'executor', { revision: 1, selection: pick('deepseek-flash', 'cline') }, actor, operation('magpie-unreviewed')),
        error => error.code === 'ROLE_CONFIG_BUILD_NOT_REGISTERED'
    );
    // Contract change: a harness the product itself ships keeps its own wire even while the
    // snapshot is a Magpie catalog. Rejecting it there would evict DSH the moment a desktop
    // Magpie answered /v1/models, which is exactly what the registry is supposed to enable.
    const shipped = reviewed.saveRole(p.id, 'reviewer', { revision: 1, selection: pick('chat-only-model', 'dsh') }, actor, operation('magpie-product-wire'));
    assert.equal(shipped.protocol, 'chat-completions');
});

test('a write without a trusted registry snapshot is refused instead of falling back', async t => {
    const h = harness(t);
    const { p } = await ready(h);
    const bench1 = bench(h, null);
    assert.throws(
        () => bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'dsh') }, actor, operation('no-registry')),
        error => error.code === 'ROLE_CONFIG_REGISTRY_REQUIRED'
    );
});

test('a stale revision, an open run and a replayed operation are each handled explicitly', async t => {
    const h = harness(t);
    const { p } = await ready(h);
    const bench1 = bench(h);
    bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'dsh') }, actor, operation('revision'));
    assert.throws(() => bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'dsh') }, actor, operation('revision-stale')), error => error.code === 'ROLE_CONFIG_REVISION_CONFLICT');
    // The same operation replayed returns the stored revision instead of appending a second one.
    const replayed = bench1.saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-flash', 'dsh') }, actor, operation('revision'));
    assert.equal(replayed.revision, 1);
    assert.equal(h.store.records(p.id, 'ProjectRoleConfiguration').length, 1);
    // An open run freezes the configuration: the write is refused, the run is untouched.
    h.store.insertRun({ id: 'run_open', projectId: p.id, version: 1, flowName: 'dreamflow-laya', mode: 'demo', state: 'IMPLEMENTING', createdAt: new Date().toISOString() });
    assert.throws(() => bench1.saveRole(p.id, 'executor', { revision: 1, selection: pick('deepseek-flash', 'dsh', 'high') }, actor, operation('frozen')), error => error.code === 'ROLE_CONFIG_FROZEN_BY_RUN');
    assert.equal(h.store.records(p.id, 'ProjectRoleConfiguration').length, 1);
});

test('the catalog only offers server-supplied choices and the effective selection', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    const { p } = await ready(h);
    const bench1 = bench(h);
    const catalog = bench1.roleCatalog(p.id);
    assert.deepEqual(catalog.roles.map(entry => entry.role), ['seeker', 'planner', 'executor', 'reviewer']);
    const planner = catalog.roles.find(entry => entry.role === 'planner');
    assert.deepEqual(planner.choices.harnesses.map(option => option.id), ['codex-app-server', 'codex', 'dsh', 'claude', 'opencode', 'cline', 'pi', 'independent']);
    assert.deepEqual(planner.choices.efforts.map(option => option.id), ['default', 'low', 'medium', 'high']);
    assert.equal(planner.selection.harness, 'codex-app-server');
    assert.equal(planner.selection.model, 'gpt-6-luna');
    assert.equal(catalog.engine.engine, 'classic');
    assert.ok(planner.label.length > 0);
});
