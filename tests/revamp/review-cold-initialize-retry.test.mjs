// OFFLINE recovery-contract tests. They never qualify a model or run a product role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWindowFixture } from '../fixtures/review-window.mjs';
import { buildReviewPacket } from '../../dist/server/review-packet.js';
import { hash } from '../../dist/server/security.js';

const retryModule = '../../dist/server/review-preparation-retry.js';

async function fixture(t, options = {}) {
  const x = await reviewWindowFixture(t);
  const run = x.h.store.run(x.r.id);
  Object.assign(run, {
    state: 'BLOCKED',
    phase: 'REVIEWING',
    reason: 'RPC_REQUEST_TIMEOUT',
    review: null,
    calls: 7,
    maxCalls: 13,
    repairCount: 0,
    maxRepairs: 2,
  });
  x.h.store.saveRun(run);

  const packet = buildReviewPacket(x.h.store, run, x.s);
  const packetHash = hash(packet);
  const dispatchId = 'OFFLINE_COLD_INITIALIZE_REVIEW';
  const generation = 'OFFLINE_COLD_INITIALIZE_GENERATION';
  const processId = 'OFFLINE_COLD_INITIALIZE_PROCESS';
  x.h.store.record('ReviewPacket', run.projectId, run.id, {
    packet,
    sha256: packetHash,
  });
  x.h.store.record('DispatchGranted', run.projectId, run.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  x.h.store.event(run.projectId, run.id, 'role.dispatch', {
    state: 'REVIEWING',
    phase: 'REVIEWING',
    attempt: run.attempt,
    reason: null,
  });
  x.h.store.record('OwnedProcessIntent', run.projectId, run.id, {
    dispatchId,
    generation,
    processId,
    platform: 'win32',
  });
  x.h.store.event(run.projectId, run.id, 'agent.event', {
    method: 'dm/codexPreparation',
    params: {
      role: 'reviewer',
      method: 'initialize',
      status: 'STARTED',
      timeoutMs: 30000,
    },
  });
  x.h.store.event(run.projectId, run.id, 'agent.event', {
    method: 'dm/codexPreparation',
    params: {
      role: 'reviewer',
      method: 'initialize',
      status: 'FAILED',
      code: 'RPC_REQUEST_TIMEOUT',
      ...(options.failedTimeoutMs === false ? {} : {timeoutMs: 30000}),
      elapsedMs: 30076,
    },
  });
  x.h.store.record('OwnedProcessCleanup', run.projectId, run.id, {
    dispatchId,
    generation,
    processId,
    cleanupReturned: true,
  });
  x.h.store.record('DispatchFinished', run.projectId, run.id, {
    dispatchId,
    generation,
    outcome: 'RPC_REQUEST_TIMEOUT',
    cleanupReturned: true,
  });
  x.h.store.event(run.projectId, run.id, 'run.blocked', {
    state: 'BLOCKED',
    phase: 'REVIEWING',
    reason: 'RPC_REQUEST_TIMEOUT',
  });
  return {
    ...x,
    run: x.h.store.run(run.id),
    packet,
    packetHash,
    dispatchId,
    generation,
    processId,
  };
}

test('a cleaned initialize timeout can authorize one new reviewer attempt without hiding the failed call', async t => {
  const x = await fixture(t);
  const { reviewPreparationBasis } = await import(retryModule);
  const basis = reviewPreparationBasis(
    x.h.store,
    x.h.store.run(x.r.id),
    x.packetHash,
  );
  assert.equal(basis.preparationFailure, 'RPC_REQUEST_TIMEOUT');
  assert.equal(basis.replayConsumedCall, false);
  assert.equal(basis.coldInitializeRecovery, true);
  assert.equal(basis.dispatchId, x.dispatchId);
  assert.equal(basis.packetHash, x.packetHash);
  assert.deepEqual(x.h.engine.reviewPreparationCandidate(x.r.id), {
    kind: 'SOURCE_VERSION',
    sourceHash: x.run.treeHash,
    version: x.run.version,
  });
});

test('the persisted failed initialize event may omit the repeated timeout value', async t => {
  const x = await fixture(t, {failedTimeoutMs: false});
  const { reviewPreparationBasis } = await import(retryModule);
  const basis = reviewPreparationBasis(
    x.h.store,
    x.h.store.run(x.r.id),
    x.packetHash,
  );
  assert.equal(basis.preparationFailure, 'RPC_REQUEST_TIMEOUT');
  assert.equal(basis.coldInitializeRecovery, true);
  assert.deepEqual(x.h.engine.reviewPreparationCandidate(x.r.id), {
    kind: 'SOURCE_VERSION',
    sourceHash: x.run.treeHash,
    version: x.run.version,
  });
});

test('the original Engine accepts the cold initialize SOURCE_VERSION recovery candidate', async t => {
  const x = await fixture(t);
  x.h.engine.nativeExecution = {
    assertReady() {},
    executor() {
      throw new Error('OFFLINE_NO_EXECUTOR');
    },
    async verify() {
      throw new Error('OFFLINE_NO_VERIFIER');
    },
    async close() {},
  };
  const prepared = await x.h.engine.prepareUndispatchedReviewRetry(
    x.r.id,
    x.run.treeHash,
    x.run.version,
    x.actor,
  );
  assert.equal(prepared.state, 'PAUSED');
  assert.equal(prepared.reason, 'REVIEW_PREPARATION_RECHECKED');
  const recovery = x.h.store.records(
    x.r.projectId,
    'ReviewPreparationRecovery',
    x.r.id,
  ).at(-1);
  assert.equal(recovery.data.coldInitializeRecovery, true);
  assert.equal(recovery.data.replayConsumedCall, false);
});

for (const [name, mutate] of [
  ['an admitted reviewer session', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    { method: 'dm/codexAdmission', params: { role: 'reviewer' } },
  )],
  ['a later account/read preparation', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    {
      method: 'dm/codexPreparation',
      params: {
        role: 'reviewer',
        method: 'account/read',
        status: 'STARTED',
      },
    },
  )],
  ['a turn/start preparation', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    {
      method: 'dm/codexPreparation',
      params: {
        role: 'reviewer',
        method: 'turn/start',
        status: 'STARTED',
      },
    },
  )],
  ['a completed reviewer turn', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    { method: 'dm/codexCompletion', params: { role: 'reviewer' } },
  )],
  ['a reviewer session', x => x.h.store.record(
    'AgentSession',
    x.r.projectId,
    x.r.id,
    { role: 'reviewer', sessionId: 'OFFLINE_REVIEWER' },
  )],
  ['a reviewer tool side effect', x => x.h.store.record(
    'ToolIntent',
    x.r.projectId,
    x.r.id,
    { tool: 'desk_write', dispatchId: x.dispatchId },
  )],
  ['a review verdict', x => x.h.store.record(
    'Review',
    x.r.projectId,
    x.r.id,
    { source: 'CODEX', verdict: 'PASS', treeHash: x.r.treeHash },
  )],
  ['an unproven process cleanup', x => x.h.store.db.prepare(
    "UPDATE records SET data=json_set(data,'$.cleanupReturned',0) "
      + "WHERE run_id=? AND kind='DispatchFinished'",
  ).run(x.r.id)],
  ['a non-timeout dispatch outcome', x => x.h.store.db.prepare(
    "UPDATE records SET data=json_set(data,'$.outcome','RUNNER_RPC_ERROR') "
      + "WHERE run_id=? AND kind='DispatchFinished'",
  ).run(x.r.id)],
  ['a missing initialize failure event', x => x.h.store.db.prepare(
    "DELETE FROM events WHERE run_id=? AND type='agent.event' "
      + "AND json_extract(payload,'$.params.code')='RPC_REQUEST_TIMEOUT'",
  ).run(x.r.id)],
  ['an existing recovery marker', x => x.h.store.record(
    'ReviewPreparationRecovery',
    x.r.projectId,
    x.r.id,
    { sourceHash: x.r.treeHash, coldInitializeRecovery: true },
  )],
]) {
  test(`cold initialize recovery refuses ${name}`, async t => {
    const x = await fixture(t);
    mutate(x);
    const { reviewPreparationBasis } = await import(retryModule);
    assert.throws(() => reviewPreparationBasis(
      x.h.store,
      x.h.store.run(x.r.id),
      x.packetHash,
    ));
  });
}

test('cold initialize recovery spends a new call rather than replaying the failed attempt', async t => {
  const x = await fixture(t);
  const mod = await import(retryModule);
  const basis = mod.reviewPreparationBasis(
    x.h.store,
    x.h.store.run(x.r.id),
    x.packetHash,
  );
  const run = x.h.store.run(x.r.id);
  const markerId = x.h.store.record(
    'ReviewPreparationRecovery',
    run.projectId,
    run.id,
    {
      ...basis,
      actorHash: 'a'.repeat(64),
      sourceHash: run.treeHash,
      specHash: run.specHash,
      planVersionHash: run.planVersionHash,
      calls: run.calls,
      repairCount: run.repairCount,
      createdAt: run.createdAt,
      maxSeconds: run.maxSeconds,
      modelDispatched: false,
    },
  );
  run.state = 'PAUSED';
  run.reason = 'REVIEW_PREPARATION_RECHECKED';
  x.h.store.saveRun(run);
  const resumed = x.h.store.run(run.id);
  resumed.state = 'REVIEWING';
  resumed.reason = null;
  x.h.store.saveRun(resumed);

  const dispatchId = 'OFFLINE_COLD_INITIALIZE_RETRY';
  const generation = 'OFFLINE_COLD_INITIALIZE_RETRY_GENERATION';
  x.h.store.record('DispatchGranted', run.projectId, run.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  const before = x.h.store.run(run.id);
  assert.equal(mod.reserveReviewPreparationReplay(
    x.h.store,
    before,
    'reviewer',
    { dispatchId, generation },
  ), false);
  const reservation = x.h.store.records(
    run.projectId,
    'ReviewPreparationReplayReservation',
  ).at(-1);
  assert.equal(reservation.data.approvalRecordId, markerId);
  assert.equal(reservation.data.dispatchId, dispatchId);
  assert.equal(reservation.data.replayedCall, false);
  assert.equal(x.h.store.run(run.id).calls, before.calls);
});

test('a cold retry that later hits probe binding can recover without reusing the timeout call', async t => {
  const x = await fixture(t);
  const mod = await import(retryModule);
  const run = x.h.store.run(x.r.id);
  const coldBasis = mod.reviewPreparationBasis(x.h.store, run, x.packetHash);
  assert.equal(coldBasis.coldInitializeRecovery, true);
  assert.equal(coldBasis.replayConsumedCall, false);
  x.h.store.record('ReviewPreparationRecovery', run.projectId, run.id, {
    ...coldBasis,
    actorHash: 'a'.repeat(64),
    sourceHash: run.treeHash,
    specHash: run.specHash,
    planVersionHash: run.planVersionHash,
    calls: run.calls,
    repairCount: run.repairCount,
    createdAt: run.createdAt,
    maxSeconds: run.maxSeconds,
    modelDispatched: false,
  });
  run.state = 'PAUSED';
  run.reason = 'REVIEW_PREPARATION_RECHECKED';
  // The cold retry consumed one call before it reached the probe gate, so the
  // persisted marker keeps calls=7 while the run has advanced to calls=8.
  run.calls = run.calls + 1;
  x.h.store.saveRun(run);

  const secondDispatchId = 'OFFLINE_COLD_PROBE_BINDING_RETRY';
  const secondGeneration = 'OFFLINE_COLD_PROBE_BINDING_GENERATION';
  x.h.store.record('ReviewPacket', run.projectId, run.id, {
    packet: x.packet,
    sha256: x.packetHash,
  });
  x.h.store.record('DispatchGranted', run.projectId, run.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId: secondDispatchId,
    generation: secondGeneration,
  });
  x.h.store.record('ReviewPreparationReplayReservation', run.projectId, run.id, {
    approvalRecordId: x.h.store.records(run.projectId, 'ReviewPreparationRecovery').at(-1).id,
    approvalPacketHash: x.packetHash,
    packetRecordId: x.h.store.records(run.projectId, 'ReviewPacket')[0].id,
    sourceHash: run.treeHash,
    specHash: run.specHash,
    role: 'reviewer',
    dispatchId: secondDispatchId,
    generation: secondGeneration,
    modelDispatched: false,
  });
  x.h.store.record('DispatchFinished', run.projectId, run.id, {
    dispatchId: secondDispatchId,
    generation: secondGeneration,
    outcome: 'NATIVE_PROBE_BINDING_CHANGED',
    cleanupReturned: true,
  });
  x.h.store.event(run.projectId, run.id, 'run.blocked', {
    state: 'BLOCKED',
    phase: 'REVIEWING',
    reason: 'NATIVE_PROBE_BINDING_CHANGED',
  });
  const blocked = x.h.store.run(run.id);
  blocked.state = 'BLOCKED';
  blocked.phase = 'REVIEWING';
  blocked.reason = 'NATIVE_PROBE_BINDING_CHANGED';
  x.h.store.saveRun(blocked);

  const basis = mod.reviewPreparationBasis(
    x.h.store,
    x.h.store.run(run.id),
    x.packetHash,
  );
  assert.equal(basis.coldInitializeRecovery, true);
  assert.equal(basis.probeBindingRecovery, true);
  assert.equal(basis.replayConsumedCall, false);
  assert.deepEqual(basis.dispatchIds, [x.dispatchId, secondDispatchId]);
});
