// The compile step between the workbench's project role record and the run's frozen classic Flow.
// A project that never saved a role configuration must keep the classic bindings byte for byte;
// a saved selection must reach the frozen snapshot as run data, and never as a fabricated route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';
import { WorkbenchContracts } from '../../dist/server/workbench-contracts.js';
import { compileClassicRoleConfiguration } from '../../dist/server/flow-configuration.js';
import { fixedControllerCapacity } from '../fixtures/controller-capacity.mjs';

const actor = 'local-session:' + 'c'.repeat(64);
const pick = (model, harnessName, effort = 'default') => ({ model, harness: harnessName, effort, skills: [], plugins: [] });
const bench = h => new WorkbenchContracts({ store: h.store, config: () => h.config, interviews: h.interviews });

/** Capture the exact ROLE_CONFIG_COMPILED line a create() call writes to stderr. */
function captureStderr() {
    const lines = [], original = process.stderr.write;
    process.stderr.write = chunk => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { process.stderr.write = original; } };
}
function compiledLine(lines) {
    const line = lines.find(value => value.startsWith('ROLE_CONFIG_COMPILED '));
    return line ? JSON.parse(line.slice('ROLE_CONFIG_COMPILED '.length)) : null;
}

test('an absent record is not compiled: the same snapshot object comes back', () => {
    const snapshot = {
        schema: 'dream-maker.flow-config.v1', mode: 'classic', projectId: 'p1', runId: 'r1',
        plan: { versionId: 'v1', revision: 1, contentHash: 'a'.repeat(64), specHash: 'b'.repeat(64) },
        roles: { planner2: { id: 'planner2' }, executors: [{ id: 'executor-1' }], reviewer: { id: 'reviewer' } },
        laya: { enabled: false, mode: 'off', roles: [] }, magpie: null, configurationFingerprint: 'c'.repeat(64)
    };
    assert.equal(compileClassicRoleConfiguration(snapshot, null), snapshot);
});

test('a project with no saved role configuration freezes the classic bindings unchanged', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna'; fixedControllerCapacity(h.engine);
    const { p, s } = await ready(h);
    const capture = captureStderr();
    let run;
    try { run = h.engine.create(p.id, s.hash, true); } finally { capture.restore(); }
    assert.equal(compiledLine(capture.lines), null);
    const frozen = h.store.run(run.id).flowConfig;
    assert.equal(frozen.roles.planner2.runtime, 'codex-app-server');
    assert.equal(frozen.roles.planner2.model, 'gpt-6-luna');
    assert.equal(frozen.roles.reviewer.runtime, 'codex-app-server');
    assert.equal(frozen.roles.reviewer.model, 'gpt-6-luna');
    assert.equal(frozen.roles.executors[0].runtime, 'dsh');
    assert.equal(frozen.roles.executors[0].model, 'deepseek-flash');
    assert.equal(frozen.configurationFingerprint, run.configFingerprint);
    assert.equal(h.store.run(run.id).flowConfigHash, hash(frozen));
    await h.engine.settled(run.id);
});

test('a saved model on the classic Codex lane is compiled into the new run', async t => {
    const h = harness(t);
    h.config.codex.model = 'gpt-6-luna';
    h.config.independent.enabled = true; h.config.independent.model = 'gpt-6-luna-alt'; h.config.independent.protocol = 'openai-responses';
    fixedControllerCapacity(h.engine);
    const { p, s } = await ready(h);
    bench(h).saveRole(p.id, 'planner', { revision: 0, selection: pick('gpt-6-luna-alt', 'codex-app-server') }, actor, hash('dm-role-compile-planner'));
    const capture = captureStderr();
    let run;
    try { run = h.engine.create(p.id, s.hash, true); } finally { capture.restore(); }
    const frozen = h.store.run(run.id).flowConfig;
    assert.equal(frozen.roles.planner2.runtime, 'codex-app-server');
    assert.equal(frozen.roles.planner2.model, 'gpt-6-luna-alt');
    assert.equal(frozen.roles.reviewer.model, 'gpt-6-luna');
    assert.equal(frozen.roles.executors[0].model, 'deepseek-flash');
    assert.equal(h.store.run(run.id).flowConfigHash, hash(frozen));
    assert.deepEqual(compiledLine(capture.lines), { projectId: p.id, roles: [{ role: 'planner2', runtime: 'codex-app-server', model: 'gpt-6-luna-alt' }] });
    await h.engine.settled(run.id);
});

test('a saved executor model replaces only the executor binding', async t => {
    const h = harness(t);
    h.config.codex.model = 'gpt-6-luna';
    h.config.planner1.model = 'deepseek-chat'; h.config.planner1.protocol = 'chat-completions';
    fixedControllerCapacity(h.engine);
    const { p, s } = await ready(h);
    bench(h).saveRole(p.id, 'executor', { revision: 0, selection: pick('deepseek-chat', 'dsh') }, actor, hash('dm-role-compile-executor'));
    const capture = captureStderr();
    let run;
    try { run = h.engine.create(p.id, s.hash, true); } finally { capture.restore(); }
    const frozen = h.store.run(run.id).flowConfig;
    assert.equal(frozen.roles.executors.length, 1);
    assert.equal(frozen.roles.executors[0].id, 'executor-1');
    assert.equal(frozen.roles.executors[0].runtime, 'dsh');
    assert.equal(frozen.roles.executors[0].model, 'deepseek-chat');
    assert.equal(frozen.roles.executors[0].provider, 'deepseek-official');
    assert.equal(frozen.roles.planner2.model, 'gpt-6-luna');
    assert.equal(frozen.roles.reviewer.model, 'gpt-6-luna');
    assert.deepEqual(compiledLine(capture.lines), { projectId: p.id, roles: [{ role: 'executor', runtime: 'dsh', model: 'deepseek-chat' }] });
    await h.engine.settled(run.id);
});

test('a harness the classic lane cannot carry leaves the frozen binding at the classic default', async t => {
    const h = harness(t); h.config.codex.model = 'gpt-6-luna'; fixedControllerCapacity(h.engine);
    const { p, s } = await ready(h);
    // Planner 2 on DSH is a legal Custom registration, but a classic run has no DSH planning lane.
    bench(h).saveRole(p.id, 'planner', { revision: 0, selection: pick('deepseek-flash', 'dsh') }, actor, hash('dm-role-compile-foreign-lane'));
    const capture = captureStderr();
    let run;
    try { run = h.engine.create(p.id, s.hash, true); } finally { capture.restore(); }
    const frozen = h.store.run(run.id).flowConfig;
    assert.equal(frozen.roles.planner2.runtime, 'codex-app-server');
    assert.equal(frozen.roles.planner2.model, 'gpt-6-luna');
    assert.deepEqual(compiledLine(capture.lines), { projectId: p.id, roles: [] });
    await h.engine.settled(run.id);
});
