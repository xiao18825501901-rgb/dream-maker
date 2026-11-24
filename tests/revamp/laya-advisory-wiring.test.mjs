// OFFLINE Engine/AgentInput wiring regression. Fake Laya and fake runners only; no model or service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';
import { ExecutorSlices } from '../../dist/server/flow/executor-slices.js';
import { fixedControllerCapacity } from '../fixtures/controller-capacity.mjs';
import { installOfflinePrework } from '../fixtures/offline-prework.mjs';

function stubLaya(labels) {
  const calls = [];
  return {
    calls,
    async decide(role, projectId, state, allowed, _signal, policy = {}) {
      calls.push({ role, projectId, state, labels: allowed, policy });
      if (policy.forceOff) return { role, mode: 'off', adoption: 'off', label: null, reason: 'DISABLED_NO_NETWORK', latencyMs: 1, inputHash: hash({ role, state, allowed }), modelRevision: null, confidence: null, cached: false };
      const label = labels[role] ?? allowed[0];
      return { role, mode: 'advisory', adoption: 'advisory', label, reason: 'VALIDATED_ADVISORY_ONLY', latencyMs: 1, inputHash: hash({ role, state, allowed }), modelRevision: null, confidence: 0.9, cached: false };
    },
  };
}
function codexRunner(role, sessionId, model) {
  return {
    async run() {
      return {
        text: role === 'planner2' ? '{"tasks":[]}' : '{"verdict":"PASS","findings":[]}',
        sessionId, model,
        usage: { role, requestId: 'OFFLINE_REQUEST_' + role, inputTokens: null, outputTokens: null, costUsd: null, source: 'OFFLINE_TEST' },
        identity: { runner: 'CODEX_CLI', provider: 'openai', authentication: 'CHATGPT_SUBSCRIPTION', model },
      };
    },
  };
}
function executorRunner(model) {
  return {
    async run() {
      return {
        text: 'OFFLINE_EXECUTOR_RESULT', sessionId: 'OFFLINE_EXECUTOR_SESSION', model,
        usage: { role: 'executor', requestId: 'OFFLINE_REQUEST_executor', inputTokens: null, outputTokens: null, costUsd: null, source: 'OFFLINE_TEST' },
        identity: { runner: 'DSH', provider: 'deepseek-official', authentication: 'API_KEY', model },
      };
    },
  };
}
async function enhanced(h, phase) {
  const { p, s } = await ready(h);
  h.engine.launch = () => {};
  const created = h.engine.create(p.id, s.hash, true, false, 'classic', { laya: true });
  const run = h.store.run(created.id);
  run.mode = 'live'; run.state = run.phase = phase;
  h.store.saveRun(run);
  return { p, s, run: h.store.run(created.id) };
}
function assertAdvisory(input, run, role, label) {
  assert.equal(input.role, role);
  assert.equal(input.laya.adoption, 'advisory');
  assert.equal(input.laya.label, label);
  assert.equal(input.laya.support.authority, 'ADVISORY_ONLY');
  assert.equal(input.laya.support.runId, run.id);
  assert.equal(input.laya.support.specHash, run.specHash);
  assert.ok(input.laya.support.guide, 'the fixed trusted guide must accompany the advisory label');
  const body = JSON.parse(input.prompt);
  assert.equal(hash(body.taskData), input.laya.support.taskDataHash);
  assert.equal(body.laya.adoption, 'advisory');
  assert.equal(body.laya.support.guide, input.laya.support.guide);
}
function assertCompletedApplication(h, p, run, role, input) {
  const apps = h.store.records(p.id, 'LayaApplication').filter(row => row.runId === run.id && row.data.role === role);
  assert.equal(apps.length, 1);
  const app = apps[0].data;
  assert.equal(app.status, 'PROVIDED_TO_COMPLETED_ROLE');
  assert.equal(app.providedToCompletedRole, true);
  assert.equal(app.agentInputPromptHash, hash(input.prompt));
  assert.equal(app.completedRole.sessionId, h.store.run(run.id).roleIdentities[role].sessionId);
  assert.equal(app.completedRole.requestId, h.store.run(run.id).roleIdentities[role].requestId);
  const decisions = h.store.records(p.id, 'LayaDecision').filter(row => row.runId === run.id && row.data.role === role);
  assert.equal(decisions.length, 1);
  assert.equal(app.decisionHash, hash(decisions[0].data));
  assert.equal(app.inputHash, decisions[0].data.inputHash);
}

test('planner2, executor and reviewer each receive their own advisory Laya input', async t => {
  const h = harness(t);
  h.config.laya.mode = 'advisory';
  h.config.codex.model = 'OFFLINE_CODEX_MODEL';
  fixedControllerCapacity(h.engine);
  const laya = stubLaya({ planner2: 'plan', executor: 'code', reviewer: 'security' });
  h.engine.laya = laya;
  let plannerInput, executorInput, reviewerInput;
  h.engine.nativeExecution = {
    assertReady() {},
    codex(input) {
      if (input.role === 'planner2') { plannerInput = input; return codexRunner('planner2', 'OFFLINE_PLANNER_SESSION', h.config.codex.model); }
      reviewerInput = input; return codexRunner('reviewer', 'OFFLINE_REVIEWER_SESSION', h.config.codex.model);
    },
    executor(input) { executorInput = input; return executorRunner(h.config.dsh.model); },
    verify: async () => ({}),
    async close() {},
  };

  const plannerRun = await enhanced(h, 'PLANNING');
  await h.engine.role(plannerRun.run, 'planner2', 'OFFLINE_PLAN_TASK', new AbortController().signal);
  assertAdvisory(plannerInput, plannerRun.run, 'planner2', 'plan');
  assertCompletedApplication(h, plannerRun.p, plannerRun.run, 'planner2', plannerInput);

  const reviewerRun = await enhanced(h, 'REVIEWING');
  await h.engine.role(reviewerRun.run, 'reviewer', 'OFFLINE_REVIEW_TASK', new AbortController().signal);
  assertAdvisory(reviewerInput, reviewerRun.run, 'reviewer', 'security');
  assertCompletedApplication(h, reviewerRun.p, reviewerRun.run, 'reviewer', reviewerInput);

  const executorRun = await enhanced(h, 'IMPLEMENTING');
  const seeded = h.store.run(executorRun.run.id);
  seeded.tasks = [{ id: 'T1', title: 'OFFLINE task', status: 'pending', dependsOn: [], requirementIds: executorRun.s.requirements.map(value => value.id), acceptance: ['OFFLINE'], writePaths: ['out.txt'] }];
  h.store.saveRun(seeded);
  const installed = installOfflinePrework(h, seeded.id);
  const assignment = new ExecutorSlices(h.store, h.dir).prepare(installed.id).assignments[0];
  await h.engine.role(installed, 'executor', 'OFFLINE_EXEC_TASK', new AbortController().signal, assignment.taskId, assignment.id);
  assertAdvisory(executorInput, installed, 'executor', 'code');
  assert.equal(executorInput.taskId, assignment.taskId);
  assert.equal(executorInput.executorSliceId, assignment.id);
  assertCompletedApplication(h, executorRun.p, installed, 'executor', executorInput);

  assert.deepEqual(laya.calls.map(call => call.role), ['planner2', 'reviewer', 'executor']);
});

test('a shadow decision never enters the task body or claims completion', async t => {
  const h = harness(t);
  h.config.laya.mode = 'shadow';
  h.config.codex.model = 'OFFLINE_CODEX_MODEL';
  fixedControllerCapacity(h.engine);
  const laya = stubLaya({ planner2: 'plan' });
  laya.decide = async (role, projectId, state, allowed) => ({
    role, mode: 'shadow', adoption: 'shadow', label: 'plan', reason: 'VALIDATED_ADVISORY_ONLY',
    latencyMs: 1, inputHash: hash({ role, state, allowed }), modelRevision: null, confidence: 0.9, cached: false,
  });
  h.engine.laya = laya;
  let input;
  h.engine.nativeExecution = {
    assertReady() {},
    codex(value) { input = value; return codexRunner('planner2', 'OFFLINE_SHADOW_SESSION', h.config.codex.model); },
    executor() { throw Error('OFFLINE_NO_EXECUTOR'); },
    verify: async () => ({}),
    async close() {},
  };
  const { p, run } = await enhanced(h, 'PLANNING');
  await h.engine.role(run, 'planner2', 'OFFLINE_PLAN_TASK', new AbortController().signal);
  assert.equal(input.laya.adoption, 'shadow');
  assert.equal(input.laya.support.guide, null);
  assert.equal(JSON.parse(input.prompt).laya, null, 'shadow advice is not inserted into the model task body');
  const app = h.store.records(p.id, 'LayaApplication').filter(row => row.runId === run.id && row.data.role === 'planner2')[0].data;
  assert.equal(app.providedToCompletedRole, false);
  assert.equal(app.status, 'NOT_CONFIRMED_PROVIDED');
});
