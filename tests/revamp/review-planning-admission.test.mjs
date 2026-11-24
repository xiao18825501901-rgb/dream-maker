// Controller-only fixture: no account, no model, no native qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {planningAdmission} from '../../dist/server/review-packet.js';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';

const PLANNER_SESSION = 'planning-admission-session';
const PLANNER_REQUEST = 'planning-admission-turn';

function withPlanner(h, runId, options = {}) {
  const run = h.store.run(runId);
  const identity = {
    runner: 'CODEX_CLI', provider: 'openai', authentication: 'CHATGPT_SUBSCRIPTION',
    model: 'fixture-model', sessionId: PLANNER_SESSION, requestId: PLANNER_REQUEST,
    ...options.identity,
  };
  run.mode = 'live';
  run.roleIdentities = {...(run.roleIdentities ?? {}), planner2: identity};
  run.sessions = {...run.sessions, planner2: PLANNER_SESSION};
  h.store.saveRun(run);
  h.store.record('AgentSession', run.projectId, run.id, {role: 'planner2', ...identity,
    modelEvidence: 'ADAPTER_VERIFIED_RESPONSE'});
  h.store.event(run.projectId, run.id, 'agent.event', {method: 'dm/codexAdmission', params: {
    role: 'planner2', threadId: PLANNER_SESSION, model: identity.model, provider: options.eventProvider ?? identity.provider,
    authentication: identity.authentication, includedUsageAllowed: true, paidFallback: false,
    permissionProfile: 'dream-maker-supervisor-data', policyHash: 'f'.repeat(64),
  }});
  h.store.event(run.projectId, run.id, 'agent.event', {method: 'dm/codexCompletion', params: {
    role: 'planner2', threadId: PLANNER_SESSION, turnId: PLANNER_REQUEST, status: 'completed',
    model: identity.model, provider: options.eventProvider ?? identity.provider, specHash: run.specHash, runId: run.id,
  }});
  return identity;
}

function customProfile(h, p) {
  const account = {provider:'openai',authentication:'oauth',authRef:'offline-openai',accountRef:'offline-openai-account'},
    deepseek = {provider:'deepseek-official',authentication:'api_key',authRef:'offline-deepseek',accountRef:'offline-deepseek-account'},
    role = (id, provider, runtime, model, auth, write = false) => ({
      id, ...auth, runtime, model:{kind:'model',id:model}, transport:'magpie', nativeException:false,
      permissions:write?['source_read','source_write']:['source_read'],
      budget:{currency:'CNY',maxMicros:1000000},
    });
  return new FlowProfiles(h.store).confirm(p.id, {configuration:{
      mode:'custom',laya:false,accounts:[account,deepseek],roles:{
        planner2:role('planner2','openai','codex','gpt-6-luna',account),
        executors:[role('executor-one','deepseek-official','dsh','deepseek-flash',deepseek,true)],
        reviewer:role('reviewer','deepseek-official','independent','deepseek-v4-pro',deepseek),
      },groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},
      budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai',
    },expectedRevision:0,confirmed:true}, 'local-session:'+'d'.repeat(64), 'OFFLINE_CODEX_MAGPIE_ADMISSION');
}

function customRun(h, p, s, profile) {
  const prepared = h.engine.prepareCustomFlow(p.id, s.hash, profile.contentHash);
  h.engine.launch = () => {};
  const base = h.engine.create(p.id, s.hash, true);
  h.store.release(p.id, base.id);
  const run = structuredClone(base);
  Object.assign(run, {
    id: prepared.flowConfig.runId,
    mode: 'live',
    flowName: 'custom',
    rolePolicy: 'CUSTOM_FROZEN_V1',
    flowConfig: prepared.flowConfig,
    flowConfigHash: prepared.flowConfigHash,
    configFingerprint: prepared.flowConfig.configurationFingerprint,
    state: 'PLANNING',
    phase: 'PLANNING',
  });
  h.store.insertRun(run);
  return h.store.run(run.id);
}

test('planner admission is explicit and bound to the current run', async t => {
  const h = harness(t);
  const {p, s} = await ready(h);
  const run = h.engine.create(p.id, s.hash, true);
  await h.engine.settled(run.id);
  const identity = withPlanner(h, run.id);
  const admission = planningAdmission(h.store, h.store.run(run.id));
  assert.ok(admission, 'PLANNING_ADMISSION_MISSING');
  assert.equal(admission.role, 'planner2');
  assert.equal(admission.sessionId, identity.sessionId);
  assert.equal(admission.requestId, identity.requestId);
  assert.equal(admission.runId, run.id);
  assert.equal(admission.specHash, run.specHash);
  assert.equal(admission.status, 'COMPLETED');
  assert.equal(admission.includedUsageAllowed, true);
  assert.equal(admission.paidFallback, false);
});

test('planner admission refuses completion belonging to another run', async t => {
  const h = harness(t);
  const {p, s} = await ready(h);
  const run = h.engine.create(p.id, s.hash, true);
  await h.engine.settled(run.id);
  withPlanner(h, run.id);
  h.store.db.prepare("UPDATE events SET payload=replace(payload,'\"runId\":\"'||?||'\"','\"runId\":\"OTHER_RUN\"') WHERE type='agent.event' AND run_id=?").run(run.id, run.id);
  assert.throws(() => planningAdmission(h.store, h.store.run(run.id)), {code: 'REVIEW_ROLE_EVIDENCE_REQUIRED'});
});

test('Custom Codex through Magpie binds the transport without relabelling its model provider', async t => {
  const h = harness(t);
  const {p, s} = await ready(h);
  const profile = customProfile(h, p);
  const run = customRun(h, p, s, profile);
  const identity = withPlanner(h, run.id, {
    identity: {
      runtime: 'codex', roleId: 'planner2',
      provider: 'openai', authentication: 'CHATGPT_SUBSCRIPTION', model: 'gpt-6-luna',
      authRef: 'offline-openai', accountRef: 'offline-openai-account',
      configurationHash: run.flowConfigHash, routeHash: 'c'.repeat(64),
    },
    eventProvider: 'magpie',
  });
  const admission = planningAdmission(h.store, h.store.run(run.id));
  assert.equal(admission.provider, identity.provider);
  assert.equal(admission.sessionId, identity.sessionId);
});

test('Custom Codex refuses a model-provider label when Magpie is the configured transport', async t => {
  const h = harness(t);
  const {p, s} = await ready(h);
  const profile = customProfile(h, p);
  const run = customRun(h, p, s, profile);
  withPlanner(h, run.id, {
    identity: {
      runtime: 'codex', roleId: 'planner2',
      provider: 'openai', authentication: 'CHATGPT_SUBSCRIPTION', model: 'gpt-6-luna',
      authRef: 'offline-openai', accountRef: 'offline-openai-account',
      configurationHash: run.flowConfigHash, routeHash: 'c'.repeat(64),
    },
    eventProvider: 'openai',
  });
  assert.throws(() => planningAdmission(h.store, h.store.run(run.id)), {code: 'REVIEW_ROLE_EVIDENCE_REQUIRED'});
});
