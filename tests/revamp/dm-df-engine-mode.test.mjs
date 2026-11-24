// The DM/DF entry and the classic/custom determination: one rule, one source, no re-flagging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';
import {
    EngineModes, classicRoleDefaults, resolveEngineDecision, engineDeviations, roleSetHash,
    engineBadge, engineBillingPath, assertRunEngineAgainstStore
} from '../../dist/server/engine-mode.js';
import { WorkbenchContracts } from '../../dist/server/workbench-contracts.js';
import { fixedControllerCapacity } from '../fixtures/controller-capacity.mjs';

const actor = 'local-session:' + 'a'.repeat(64);
const operation = label => hash('dm-df-engine-' + label);
const selection = (model, effort = 'default', harnessName = 'dsh') => ({ model, effort, harness: harnessName, skills: [], plugins: [] });

function bench(h) {
    return new WorkbenchContracts({ store: h.store, config: () => h.config, interviews: h.interviews });
}

test('a project nobody configured is classic, with Laya attached and no deviation', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    const { p } = await ready(h);
    const bench1 = bench(h);
    const view = bench1.engine(p.id);
    assert.equal(view.engine, 'classic');
    assert.equal(view.origin, 'PRODUCT_DEFAULT');
    assert.equal(view.decision.entry, 'DM');
    assert.equal(view.badge.laya, 'ON');
    assert.equal(view.badge.magpie, 'NOT_APPLICABLE');
    assert.equal(view.roles.deviations.length, 0);
    assert.equal(view.billing.layer, 'classic-laya');
    assert.equal(view.billing.budgetSource, 'CLASSIC_RUN_LIMITS');
    // The rule itself: defaults derive from the product's own classic bindings.
    const defaults = classicRoleDefaults(h.config);
    assert.deepEqual(defaults.planner2, { harness: 'codex-app-server', model: 'gpt-6-luna', reasoning: 'default' });
    assert.deepEqual(defaults.executor, { harness: 'dsh', model: 'deepseek-flash', reasoning: 'default' });
});

test('changing a role harness makes the project custom, and the reason names the field', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    const { p } = await ready(h);
    const bench1 = bench(h);
    const saved = bench1.saveRole(p.id, 'planner', { revision: 0, selection: selection('deepseek-flash', 'default', 'dsh') }, actor, operation('harness'));
    assert.equal(saved.engine.decision.engine, 'custom');
    const view = bench1.engine(p.id);
    assert.equal(view.engine, 'custom');
    assert.equal(view.origin, 'USER_OVERRIDE');
    assert.equal(view.badge.laya, 'OFF');
    assert.equal(view.badge.magpie, 'DM_ONLY');
    assert.equal(view.billing.layer, 'custom-magpie');
    const reasons = view.decision.reasons.map(reason => reason.role + ':' + reason.field).sort();
    assert.deepEqual(reasons, ['planner2:harness', 'planner2:model']);
    assert.ok(view.decision.reasons.every(reason => reason.code === 'HARNESS_DEVIATES_FROM_DEFAULT' || reason.code === 'MODEL_DEVIATES_FROM_DEFAULT'));
});

test('changing only a role model makes the project custom', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    h.config.independent = { ...h.config.independent, enabled: true, model: 'independent-chat', protocol: 'chat-completions' };
    const { p } = await ready(h);
    const bench1 = bench(h);
    bench1.saveRole(p.id, 'executor', { revision: 0, selection: selection('independent-chat') }, actor, operation('model'));
    const view = bench1.engine(p.id);
    assert.equal(view.engine, 'custom');
    assert.deepEqual(view.decision.reasons.map(reason => reason.role + ':' + reason.field), ['executor:model']);
    assert.equal(view.roles.deviations[0].configured, 'independent-chat');
    assert.equal(view.roles.deviations[0].fallback, 'deepseek-flash');
});

test('changing only the reasoning strength is a deviation too: the conservative rule', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    const { p } = await ready(h);
    const bench1 = bench(h);
    bench1.saveRole(p.id, 'executor', { revision: 0, selection: selection('deepseek-flash', 'high') }, actor, operation('effort'));
    const view = bench1.engine(p.id);
    assert.equal(view.engine, 'custom');
    assert.deepEqual(view.decision.reasons.map(reason => reason.role + ':' + reason.field + ':' + reason.code), ['executor:reasoning:REASONING_DEVIATES_FROM_DEFAULT']);
});

test('putting every field back to its default returns the project to classic', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    h.config.independent = { ...h.config.independent, enabled: true, model: 'independent-chat', protocol: 'chat-completions' };
    const { p } = await ready(h);
    const bench1 = bench(h);
    bench1.saveRole(p.id, 'executor', { revision: 0, selection: selection('independent-chat', 'high') }, actor, operation('to-custom'));
    assert.equal(bench1.engine(p.id).engine, 'custom');
    bench1.saveRole(p.id, 'executor', { revision: 1, selection: selection('deepseek-flash', 'default') }, actor, operation('back-to-classic'));
    const view = bench1.engine(p.id);
    assert.equal(view.engine, 'classic');
    assert.equal(view.origin, 'PRODUCT_DEFAULT');
    assert.equal(view.roles.deviations.length, 0);
    assert.equal(view.badge.laya, 'ON');
    // The decision chain keeps both decisions: nothing was rewritten in place.
    const chain = h.store.records(p.id, 'EngineDecision').map(row => row.data.decision.engine);
    assert.deepEqual(chain.slice(-2), ['custom', 'classic']);
});

test('a project that already ran keeps the engine it actually ran under', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    fixedControllerCapacity(h.engine);
    const { p, s } = await ready(h);
    const run = h.engine.create(p.id, s.hash, true);
    assert.equal(run.flowConfig.mode, 'classic');
    const engines = new EngineModes(h.store, () => h.config);
    assert.equal(engines.recorded(p.id), null);
    // Today's defaults change; the classic run is still what this project is.
    h.config.dsh.model = 'a-model-that-was-never-used';
    h.config.codex.model = 'another-codex-model';
    const decision = engines.resolve(p.id);
    assert.equal(decision.engine, 'classic');
    assert.equal(decision.origin, 'HISTORICAL_FROZEN');
    assert.equal(decision.historicalRunId, run.id);
    assert.deepEqual(decision.reasons, []);
});

test('the pure rule: recorded wins, historical wins over today\'s defaults, else compare fields', t => {
    const h = harness(t);
    const defaults = classicRoleDefaults(h.config);
    const deviating = Object.freeze({
        planner1: { ...defaults.planner1, harness: 'local-http' },
        planner2: { ...defaults.planner2, harness: 'dsh' },
        executor: { ...defaults.executor, model: 'other-model' },
        reviewer: defaults.reviewer
    });
    // 1. A stored decision is returned unchanged, whatever the selection now says.
    const recorded = resolveEngineDecision({ entry: 'DM', selection: defaults, defaults });
    assert.equal(recorded.engine, 'classic');
    const again = resolveEngineDecision({ entry: 'DM', selection: deviating, defaults, recorded });
    assert.equal(again, recorded);
    // 2. A project that ran keeps its engine, even when today's defaults would say otherwise.
    const historicalClassic = resolveEngineDecision({ entry: 'DM', selection: deviating, defaults, historical: { engine: 'classic', runId: 'run_1' } });
    assert.equal(historicalClassic.engine, 'classic');
    const historicalCustom = resolveEngineDecision({ entry: 'DF', selection: defaults, defaults, historical: { engine: 'custom', runId: 'run_2' } });
    assert.equal(historicalCustom.engine, 'custom');
    assert.equal(historicalCustom.entry, 'DF');
    // 3. Otherwise the field comparison decides, and every deviating field is reported.
    const derived = resolveEngineDecision({ entry: 'DM', selection: deviating, defaults });
    assert.equal(derived.engine, 'custom');
    assert.deepEqual(derived.reasons.map(reason => reason.role + ':' + reason.field), ['planner1:harness', 'planner2:harness', 'executor:model']);
    assert.equal(derived.selectionHash, roleSetHash(deviating));
    assert.equal(derived.defaultsHash, roleSetHash(defaults));
    // 4. Re-typing the default is not a deviation.
    assert.deepEqual(engineDeviations(defaults, defaults), []);
    assert.equal(engineBadge(derived).laya, 'OFF');
    assert.equal(engineBillingPath(derived).payee, 'MAGPIE_CUSTOM_ROUTE');
});

test('the decision is one source: Store row, API view, badge and the Prework gate agree', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna';
    const { p } = await ready(h);
    const bench1 = bench(h);
    bench1.saveRole(p.id, 'planner', { revision: 0, selection: selection('deepseek-flash') }, actor, operation('one-source'));
    const view = bench1.engine(p.id);
    const stored = h.store.records(p.id, 'EngineDecision').at(-1).data.decision;
    assert.equal(view.engine, 'custom');
    assert.equal(stored.engine, view.engine);
    assert.equal(view.badge.engine, stored.engine);
    assert.equal(view.billing.engine, stored.engine);
    assert.equal(view.decision.selectionHash, stored.selectionHash);
    // The Prework gate reads the same row: a classic Flow may not be handed work now.
    const classicShape = { id: 'run_probe', projectId: p.id, flowConfig: { mode: 'classic' } };
    assert.throws(() => assertRunEngineAgainstStore(h.store, classicShape), error => error.code === 'ENGINE_DECISION_MISMATCH');
    assert.doesNotThrow(() => assertRunEngineAgainstStore(h.store, { id: 'run_probe2', projectId: p.id, flowConfig: { mode: 'custom' } }));
    // A project that never recorded a decision has only its own Flow: nothing to contradict.
    const second = h.interviews.create('第二个项目', '一个还没有任何角色配置的项目。', 'demo');
    assert.equal(h.store.records(second.id, 'EngineDecision').length, 0);
    assert.doesNotThrow(() => assertRunEngineAgainstStore(h.store, { id: 'run_probe3', projectId: second.id, flowConfig: { mode: 'classic' } }));
    // The entry is part of the decision, so the DM list and the DF list cannot mix.
    assert.equal(bench1.engine(p.id).entry, view.entry);
    assert.equal(bench1.engine(second.id).entry, 'DM');
});
