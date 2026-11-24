import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRunForShadow } from '../dist/server/orca/shadow.js';

// A09 source half: what SHADOW may see. Synthetic runs only; no Orca, no engine, no process.

const run = (over = {}) => ({
    id: 'run_1', projectId: 'proj_1', mode: 'demo', state: 'IMPLEMENTING', phase: 'EXECUTING',
    specHash: 'a'.repeat(64), treeHash: 'b'.repeat(64), calls: 3, maxCalls: 20, repairCount: 1, maxRepairs: 2,
    tasks: [{ id: 't1', title: 'Build the desk view', status: 'running', dependsOn: ['t0'], requirementIds: ['r1', 'r2'], acceptance: ['shows rows'] }],
    ...over
});

test('A09-S1 the projection carries shape and lifecycle but never the workspace, plan or finding text', () => {
    const p = projectRunForShadow(run());
    const text = JSON.stringify(p);
    assert.equal(text.includes('workspace'), false);
    assert.equal(text.includes('plan'), false);
    assert.equal(text.includes('finding'), false);
    // Task acceptance text is replaced by a count.
    assert.equal(text.includes('shows rows'), false);
    assert.equal(p.tasks[0].acceptanceCount, 1);
    assert.equal(p.tasks[0].requirementCount, 2);
    assert.equal(p.tasks[0].title, 'Build the desk view');
});

test('A09-S2 identifiers, hashes, counters and cursor-facing numbers survive', () => {
    const p = projectRunForShadow(run());
    assert.equal(p.runId, 'run_1');
    assert.equal(p.projectId, 'proj_1');
    assert.equal(p.specHash.length, 64);
    assert.deepEqual(p.calls, { used: 3, max: 20 });
    assert.deepEqual(p.repairs, { used: 1, max: 2 });
    assert.deepEqual(p.tasks[0].dependsOn, ['t0']);
});

test('A09-S3 the task list is bounded and truncation is reported, never silently zero', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i, title: 'task ' + i, status: 'pending' }));
    const p = projectRunForShadow(run({ tasks: many }), { maxTasks: 10 });
    assert.equal(p.tasks.length, 10);
    assert.equal(p.tasksTruncated, 50);
    assert.equal(projectRunForShadow(run({ tasks: many })).tasksTruncated, 10);
});

test('A09-S4 an absurd bound is refused instead of producing an unbounded payload', () => {
    assert.throws(() => projectRunForShadow(run(), { maxTasks: 0 }), /SHADOW_MAX_TASKS_INVALID/);
    assert.throws(() => projectRunForShadow(run(), { maxTasks: 10_000 }), /SHADOW_MAX_TASKS_INVALID/);
});

test('A09-S5 a runaway title is capped and a missing tree hash stays null', () => {
    const p = projectRunForShadow(run({ treeHash: undefined, tasks: [{ id: 't1', title: 'x'.repeat(500), status: 'running' }] }));
    assert.equal(p.tasks[0].title.length, 80);
    assert.equal(p.treeHash, null);
    assert.deepEqual(p.tasks[0].requirementCount, 0);
});
