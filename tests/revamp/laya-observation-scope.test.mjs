// OFFLINE controller-record regression. No Laya service, model, credential or Native turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';

const decision = (role = 'executor') => ({
  role, mode: 'advisory', adoption: 'advisory', label: 'code', reason: 'VALIDATED_ADVISORY_ONLY',
  latencyMs: 1, inputHash: 'a'.repeat(64), modelRevision: null, confidence: 0.9, cached: false,
});
const application = (d, completedRole) => ({
  role: d.role, mode: 'live', decisionHash: hash(d), inputHash: d.inputHash,
  ...(completedRole ? { completedRole } : {}), providedToCompletedRole: true,
  status: 'PROVIDED_TO_COMPLETED_ROLE', causalModelInfluence: 'NOT_CLAIMED',
});
async function rig(t) {
  const h = harness(t), { p, s } = await ready(h);
  h.engine.launch = () => {};
  const created = h.engine.create(p.id, s.hash, true), run = h.store.run(created.id);
  run.mode = 'live'; run.state = run.phase = 'IMPLEMENTING';
  run.roleIdentities = { executor: { runner: 'DSH', provider: 'deepseek-official', authentication: 'API_KEY', model: h.config.dsh.model, sessionId: 'OFFLINE_SESSION', requestId: 'OFFLINE_REQUEST' } };
  h.store.saveRun(run);
  return { h, p, run: h.store.run(created.id) };
}

test('a role identity alone cannot promote an absent or foreign completed turn', async t => {
  const { h, p, run } = await rig(t), d = decision();
  h.store.record('LayaDecision', p.id, run.id, d);
  h.store.record('LayaApplication', p.id, run.id, application(d, {
    dispatchId: 'OFFLINE_DISPATCH', generation: 'OFFLINE_GENERATION', sessionId: 'FOREIGN_SESSION', requestId: 'OFFLINE_REQUEST',
  }));
  const before = h.engine.layaObservation(run.id);
  assert.equal(before.turns, 1);
  assert.equal(before.receivedAdviceTurns, 1);
  assert.equal(before.influencedTurns, 0, 'a foreign session must not count as a completed role turn');

  h.store.record('AgentSession', p.id, run.id, {
    role: 'executor', sessionId: 'OFFLINE_SESSION', dispatchId: 'OFFLINE_DISPATCH', generation: 'OFFLINE_GENERATION',
    modelEvidence: 'ADAPTER_VERIFIED_RESPONSE',
  });
  const after = h.engine.layaObservation(run.id);
  assert.equal(after.receivedAdviceTurns, 1);
  assert.equal(after.influencedTurns, 0, 'the application session still differs from the recorded adapter session');

  h.store.record('LayaDecision', p.id, run.id, { ...d, inputHash: 'b'.repeat(64) });
  h.store.record('LayaApplication', p.id, run.id, {
    ...application({ ...d, inputHash: 'b'.repeat(64) }, { dispatchId: 'OFFLINE_DISPATCH', generation: 'OFFLINE_GENERATION', sessionId: 'OFFLINE_SESSION', requestId: 'OFFLINE_REQUEST' }),
  });
  const matched = h.engine.layaObservation(run.id);
  assert.equal(matched.turns, 2);
  assert.equal(matched.receivedAdviceTurns, 2);
  assert.equal(matched.influencedTurns, 1, 'only the exact adapter session is promoted');
});

test('qualification records and shadow decisions stay outside run participation', async t => {
  const { h, p, run } = await rig(t), d = decision();
  h.store.record('LayaQualification', null, null, { schema: 'dream-maker.laya-qualification.v1', status: 'QUALIFIED' });
  h.store.record('LayaDecision', p.id, run.id, { ...d, mode: 'shadow', adoption: 'shadow', label: 'code' });
  h.store.record('LayaApplication', p.id, run.id, {
    role: 'executor', mode: 'live', decisionHash: hash({ ...d, mode: 'shadow', adoption: 'shadow', label: 'code' }),
    inputHash: d.inputHash, providedToCompletedRole: false, status: 'NOT_CONFIRMED_PROVIDED', causalModelInfluence: 'NOT_CLAIMED',
  });
  const summary = h.engine.layaObservation(run.id);
  assert.equal(summary.turns, 1, 'the qualification record is not a run-scoped role turn');
  assert.equal(summary.receivedAdviceTurns, 0);
  assert.equal(summary.influencedTurns, 0);
  assert.equal(summary.byAdoption.shadow, 1);
  assert.equal(summary.fullyOff, false);
});

test('more than 2000 controller records are reported as a limit instead of partial participation', async t => {
  const { h, p, run } = await rig(t), d = decision();
  h.store.db.exec('BEGIN');
  for (let i = 0; i < 2001; i++) h.store.record('LayaDecision', p.id, run.id, { ...d, inputHash: String(i).padStart(64, '0') });
  h.store.db.exec('COMMIT');
  const summary = h.engine.layaObservation(run.id);
  assert.equal(summary.reason, 'CONTROLLER_RECORD_LIMIT');
  assert.equal(summary.fullyOff, false);
  assert.equal(summary.influencedTurns, 0);
});

test('more than 2000 AgentSession records are refused before any completion is inferred', async t => {
  const { h, p, run } = await rig(t), d = decision();
  h.store.record('LayaDecision', p.id, run.id, d);
  h.store.record('LayaApplication', p.id, run.id, application(d, { dispatchId: 'OFFLINE_DISPATCH', generation: 'OFFLINE_GENERATION', sessionId: 'OFFLINE_SESSION', requestId: 'OFFLINE_REQUEST' }));
  h.store.db.exec('BEGIN');
  for (let i = 0; i < 2001; i++) h.store.record('AgentSession', p.id, run.id, { role: 'executor', sessionId: 'S' + i, dispatchId: 'OFFLINE_DISPATCH', generation: 'OFFLINE_GENERATION', modelEvidence: 'ADAPTER_VERIFIED_RESPONSE' });
  h.store.db.exec('COMMIT');
  const summary = h.engine.layaObservation(run.id);
  assert.equal(summary.reason, 'CONTROLLER_RECORD_LIMIT');
  assert.equal(summary.influencedTurns, 0);
});
