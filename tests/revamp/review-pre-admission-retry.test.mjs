// OFFLINE recovery-contract tests. They never qualify a model or run a product role.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewWindowFixture} from '../fixtures/review-window.mjs';
import {buildReviewPacket} from '../../dist/server/review-packet.js';
import {hash} from '../../dist/server/security.js';

const retryModule = '../../dist/server/review-preparation-retry.js';

async function fixture(t) {
  const x = await reviewWindowFixture(t);
  const r = x.h.store.run(x.r.id);
  Object.assign(r, {
    reason: 'REVIEW_ADMISSION_BINDING_INVALID',
    calls: r.maxCalls,
    repairCount: r.maxRepairs,
    review: null,
  });
  x.h.store.saveRun(r);

  const packet = buildReviewPacket(x.h.store, r, x.s);
  const packetHash = hash(packet);
  const dispatchId = 'OFFLINE_PRE_ADMISSION_REVIEW';
  const generation = 'OFFLINE_PRE_ADMISSION_GENERATION';
  const processId = 'OFFLINE_CODEX_PROCESS';
  x.h.store.record('ReviewPacket', r.projectId, r.id, {packet, sha256: packetHash});
  x.h.store.record('DispatchGranted', r.projectId, r.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  x.h.store.event(r.projectId, r.id, 'role.dispatch', {
    state: 'REVIEWING',
    phase: 'REVIEWING',
    attempt: r.attempt,
    reason: null,
  });
  x.h.store.record('OwnedProcessIntent', r.projectId, r.id, {
    dispatchId,
    generation,
    processId,
    platform: 'win32',
  });
  for (const [method, status] of [
    ['initialize', 'STARTED'],
    ['initialize', 'COMPLETED'],
    ['account/read', 'STARTED'],
    ['account/read', 'COMPLETED'],
    ['account/rateLimits/read', 'STARTED'],
    ['account/rateLimits/read', 'COMPLETED'],
    ['model/list', 'STARTED'],
    ['model/list', 'COMPLETED'],
    ['thread/start', 'STARTED'],
    ['thread/start', 'COMPLETED'],
    ['account/rateLimits/read', 'STARTED'],
    ['account/rateLimits/read', 'COMPLETED'],
  ]) {
    x.h.store.event(r.projectId, r.id, 'agent.event', {
      method: 'dm/codexPreparation',
      params: {role: 'reviewer', method, status},
    });
  }
  x.h.store.record('OwnedProcessCleanup', r.projectId, r.id, {
    dispatchId,
    generation,
    processId,
    cleanupReturned: true,
  });
  x.h.store.record('DispatchFinished', r.projectId, r.id, {
    dispatchId,
    generation,
    outcome: 'REVIEW_ADMISSION_BINDING_INVALID',
    cleanupReturned: true,
  });
  x.h.store.event(r.projectId, r.id, 'run.blocked', {
    state: 'BLOCKED',
    phase: 'REVIEWING',
    reason: 'REVIEW_ADMISSION_BINDING_INVALID',
  });
  return {
    ...x,
    r: x.h.store.run(r.id),
    packet,
    packetHash,
    dispatchId,
    generation,
    processId,
  };
}

async function probeBindingFailureFixture(t) {
  const x = await fixture(t);
  const mod = await import(retryModule);
  const firstBasis = mod.reviewPreparationBasis(
    x.h.store,
    x.h.store.run(x.r.id),
    x.packetHash,
  );
  const current = x.h.store.run(x.r.id);
  const currentPacket = buildReviewPacket(x.h.store, current, x.s);
  const currentPacketHash = hash(currentPacket);
  const previousPacket = x.h.store.records(current.projectId, 'ReviewPacket')[0];
  const firstMarkerId = x.h.store.record(
    'ReviewPreparationRecovery',
    current.projectId,
    current.id,
    {
      ...firstBasis,
      actorHash: 'a'.repeat(64),
      sourceHash: current.treeHash,
      specHash: current.specHash,
      planVersionHash: current.planVersionHash,
      calls: current.calls,
      repairCount: current.repairCount,
      createdAt: current.createdAt,
      maxSeconds: current.maxSeconds,
      preparationFailure: 'REVIEW_ADMISSION_BINDING_INVALID',
      packetRecordId: null,
      packetRebuilt: true,
      previousPacketRecordId: previousPacket.id,
      previousPacketHash: previousPacket.data.sha256,
      modelDispatched: false,
    },
  );
  const currentPacketId = x.h.store.record('ReviewPacket', current.projectId, current.id, {
    packet: currentPacket,
    sha256: currentPacketHash,
  });
  const dispatchId = 'OFFLINE_PROBE_BINDING_RETRY';
  const generation = 'OFFLINE_PROBE_BINDING_GENERATION';
  x.h.store.record('DispatchGranted', current.projectId, current.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  x.h.store.record('ReviewPreparationReplayReservation', current.projectId, current.id, {
    approvalRecordId: firstMarkerId,
    approvalPacketHash: currentPacketHash,
    packetRecordId: currentPacketId,
    sourceHash: current.treeHash,
    specHash: current.specHash,
    role: 'reviewer',
    dispatchId,
    generation,
    modelDispatched: false,
  });
  x.h.store.record('DispatchFinished', current.projectId, current.id, {
    dispatchId,
    generation,
    outcome: 'NATIVE_PROBE_MISSING',
    cleanupReturned: true,
  });
  x.h.store.event(current.projectId, current.id, 'run.blocked', {
    state: 'BLOCKED',
    phase: 'REVIEWING',
    reason: 'NATIVE_PROBE_MISSING',
  });
  current.state = 'BLOCKED';
  current.reason = 'NATIVE_PROBE_MISSING';
  x.h.store.saveRun(current);
  return {
    ...x,
    mod,
    currentPacket,
    currentPacketHash,
    firstMarkerId,
    probeDispatchId: dispatchId,
    probeGeneration: generation,
  };
}

test('a cleaned pre-admission refusal becomes one reusable reviewer call', async t => {
  const x = await fixture(t);
  const {reviewPreparationBasis} = await import(retryModule);
  const basis = reviewPreparationBasis(
    x.h.store,
    x.h.store.run(x.r.id),
    x.packetHash,
  );
  assert.equal(basis.dispatchId, x.dispatchId);
  assert.equal(basis.packetHash, x.packetHash);
  assert.equal(basis.replayConsumedCall, true);
});

for (const [name, mutate] of [
  ['an admitted reviewer session', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    {method: 'dm/codexAdmission', params: {role: 'reviewer'}},
  )],
  ['a completed reviewer turn', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    {method: 'dm/codexCompletion', params: {role: 'reviewer'}},
  )],
  ['a turn/start preparation event', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    {
      method: 'dm/codexPreparation',
      params: {role: 'reviewer', method: 'turn/start', status: 'STARTED'},
    },
  )],
  ['an unproven process cleanup', x => x.h.store.db.prepare(
    "UPDATE records SET data=json_set(data,'$.cleanupReturned',0) "
      + "WHERE run_id=? AND kind='DispatchFinished'",
  ).run(x.r.id)],
  ['a reviewer tool side effect', x => x.h.store.record(
    'ToolIntent',
    x.r.projectId,
    x.r.id,
    {tool: 'desk_write', dispatchId: x.dispatchId},
  )],
  ['a reviewer session', x => x.h.store.record(
    'AgentSession',
    x.r.projectId,
    x.r.id,
    {role: 'reviewer', sessionId: 'OFFLINE_REVIEWER'},
  )],
  ['an existing recovery marker', x => x.h.store.record(
    'ReviewPreparationRecovery',
    x.r.projectId,
    x.r.id,
    {sourceHash: x.r.treeHash, replayConsumedCall: true},
  )],
]) {
  test(`pre-admission recovery refuses ${name}`, async t => {
    const x = await fixture(t);
    mutate(x);
    const {reviewPreparationBasis} = await import(retryModule);
    assert.throws(() =>
      reviewPreparationBasis(x.h.store, x.h.store.run(x.r.id), x.packetHash),
    );
  });
}

test('the replay reservation reuses exactly one consumed call and cannot repeat', async t => {
  const x = await fixture(t);
  const mod = await import(retryModule);
  const basis = mod.reviewPreparationBasis(
    x.h.store,
    x.h.store.run(x.r.id),
    x.packetHash,
  );
  const markerId = x.h.store.record('ReviewPreparationRecovery', x.r.projectId, x.r.id, {
    ...basis,
    actorHash: 'a'.repeat(64),
    sourceHash: x.r.treeHash,
    specHash: x.r.specHash,
    planVersionHash: x.r.planVersionHash,
    calls: x.r.calls,
    repairCount: x.r.repairCount,
    createdAt: x.r.createdAt,
    maxSeconds: x.r.maxSeconds,
    modelDispatched: false,
  });
  const paused = x.h.store.run(x.r.id);
  paused.state = 'PAUSED';
  paused.reason = 'REVIEW_PREPARATION_RECHECKED';
  x.h.store.saveRun(paused);
  const resumed = x.h.store.run(x.r.id);
  resumed.state = 'REVIEWING';
  resumed.reason = null;
  x.h.store.saveRun(resumed);

  const dispatchId = 'OFFLINE_REPLAY_REVIEW';
  const generation = 'OFFLINE_REPLAY_GENERATION';
  x.h.store.record('DispatchGranted', x.r.projectId, x.r.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  const before = x.h.store.run(x.r.id);
  const used = mod.reserveReviewPreparationReplay(
    x.h.store,
    before,
    'reviewer',
    {dispatchId, generation},
  );
  const after = x.h.store.run(x.r.id);
  assert.equal(used, true);
  assert.equal(after.calls, before.calls);
  assert.equal(after.maxCalls, before.maxCalls);
  const reservations = x.h.store.records(
    x.r.projectId,
    'ReviewPreparationReplayReservation',
  );
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].data.approvalRecordId, markerId);
  assert.equal(reservations[0].data.dispatchId, dispatchId);
  assert.throws(
    () => mod.reserveReviewPreparationReplay(
      x.h.store,
      after,
      'reviewer',
      {dispatchId, generation},
    ),
    {code: 'REVIEW_PREPARATION_REPLAY_CONSUMED'},
  );
});

test('an oversized recorded packet can bind one rebuilt current packet without another call', async t => {
  const x = await fixture(t);
  const saved = x.h.store.db.prepare(
    "SELECT id,data FROM records WHERE run_id=? AND kind='ReviewPacket'",
  ).get(x.r.id);
  const stored = JSON.parse(saved.data);
  const oversized = {
    ...stored.packet,
    obsoleteParentCopy: 'x'.repeat(520000),
  };
  const previousPacketHash = hash(oversized);
  x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(
    JSON.stringify({sha256: previousPacketHash, packet: oversized}),
    saved.id,
  );

  const mod = await import(retryModule);
  const current = x.h.store.run(x.r.id);
  const rebuilt = buildReviewPacket(x.h.store, current, x.s);
  const rebuiltHash = hash(rebuilt);
  assert.notEqual(rebuiltHash, previousPacketHash);
  assert.throws(() =>
    mod.reviewPreparationBasis(x.h.store, current, rebuiltHash),
  );

  const basis = mod.reviewPreparationBasis(
    x.h.store,
    current,
    rebuiltHash,
    {allowPacketRebuild: true},
  );
  assert.equal(basis.packetRebuilt, true);
  assert.equal(basis.packetHash, rebuiltHash);
  assert.equal(basis.packetRecordId, null);
  assert.equal(basis.previousPacketRecordId, saved.id);
  assert.equal(basis.previousPacketHash, previousPacketHash);
  assert.equal(basis.replayConsumedCall, true);

  x.h.store.record('ReviewPreparationRecovery', x.r.projectId, x.r.id, {
    ...basis,
    actorHash: 'a'.repeat(64),
    sourceHash: current.treeHash,
    specHash: current.specHash,
    planVersionHash: current.planVersionHash,
    calls: current.calls,
    repairCount: current.repairCount,
    createdAt: current.createdAt,
    maxSeconds: current.maxSeconds,
    modelDispatched: false,
  });
  const paused = x.h.store.run(x.r.id);
  paused.state = 'PAUSED';
  paused.reason = 'REVIEW_PREPARATION_RECHECKED';
  x.h.store.saveRun(paused);
  const resumed = x.h.store.run(x.r.id);
  resumed.state = 'REVIEWING';
  resumed.reason = null;
  x.h.store.saveRun(resumed);

  const packetId = x.h.store.record('ReviewPacket', x.r.projectId, x.r.id, {
    packet: rebuilt,
    sha256: rebuiltHash,
  });
  const dispatchId = 'OFFLINE_REBUILT_REPLAY_REVIEW';
  const generation = 'OFFLINE_REBUILT_REPLAY_GENERATION';
  x.h.store.record('DispatchGranted', x.r.projectId, x.r.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  const before = x.h.store.run(x.r.id);
  assert.equal(
    mod.reserveReviewPreparationReplay(
      x.h.store,
      before,
      'reviewer',
      {dispatchId, generation},
    ),
    true,
  );
  const reservations = x.h.store.records(
    x.r.projectId,
    'ReviewPreparationReplayReservation',
  );
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].data.packetRecordId, packetId);
  assert.equal(reservations[0].data.approvalPacketHash, rebuiltHash);
  assert.equal(x.h.store.run(x.r.id).calls, before.calls);
});

test('a cleaned probe-binding failure before process launch can reuse the same reviewer call once', async t => {
  const x = await probeBindingFailureFixture(t);
  const run = x.h.store.run(x.r.id);
  const basis = x.mod.reviewPreparationBasis(
    x.h.store,
    run,
    x.currentPacketHash,
  );
  assert.equal(basis.dispatchId, x.probeDispatchId);
  assert.equal(basis.preparationFailure, 'NATIVE_PROBE_MISSING');
  assert.equal(basis.replayConsumedCall, true);
  assert.equal(basis.probeBindingRecovery, true);
  assert.deepEqual(basis.dispatchIds, [x.dispatchId, x.probeDispatchId]);
  assert.equal(run.calls, run.maxCalls);
});

for (const [name, mutate] of [
  ['an unproven second cleanup', x => x.h.store.db.prepare(
    "UPDATE records SET data=json_set(data,'$.cleanupReturned',0) "
      + "WHERE run_id=? AND kind='DispatchFinished' AND json_extract(data,'$.dispatchId')=?",
  ).run(x.r.id, x.probeDispatchId)],
  ['a missing replay reservation', x => x.h.store.db.prepare(
    "DELETE FROM records WHERE run_id=? AND kind='ReviewPreparationReplayReservation'",
  ).run(x.r.id)],
  ['a reviewer session', x => x.h.store.record(
    'AgentSession',
    x.r.projectId,
    x.r.id,
    {role: 'reviewer', sessionId: 'OFFLINE_PROBE_REVIEWER'},
  )],
  ['a reviewer turn', x => x.h.store.event(
    x.r.projectId,
    x.r.id,
    'agent.event',
    {
      method: 'dm/codexPreparation',
      params: {role: 'reviewer', method: 'turn/start', status: 'STARTED'},
    },
  )],
  ['a reviewer tool side effect', x => x.h.store.record(
    'ToolIntent',
    x.r.projectId,
    x.r.id,
    {tool: 'desk_write', dispatchId: x.probeDispatchId},
  )],
]) {
  test(`probe-binding recovery refuses ${name}`, async t => {
    const x = await probeBindingFailureFixture(t);
    mutate(x);
    assert.throws(() => x.mod.reviewPreparationBasis(
      x.h.store,
      x.h.store.run(x.r.id),
      x.currentPacketHash,
    ));
  });
}

test('probe-binding recovery reserves one final replay without increasing calls', async t => {
  const x = await probeBindingFailureFixture(t);
  const basis = x.mod.reviewPreparationBasis(
    x.h.store,
    x.h.store.run(x.r.id),
    x.currentPacketHash,
  );
  const run = x.h.store.run(x.r.id);
  const markerId = x.h.store.record('ReviewPreparationRecovery', run.projectId, run.id, {
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
  });
  run.state = 'PAUSED';
  run.reason = 'REVIEW_PREPARATION_RECHECKED';
  x.h.store.saveRun(run);
  const resumed = x.h.store.run(run.id);
  resumed.state = 'REVIEWING';
  resumed.reason = null;
  x.h.store.saveRun(resumed);
  const dispatchId = 'OFFLINE_FINAL_PROBE_REPLAY';
  const generation = 'OFFLINE_FINAL_PROBE_GENERATION';
  x.h.store.record('DispatchGranted', run.projectId, run.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  const before = x.h.store.run(run.id);
  assert.equal(x.mod.reserveReviewPreparationReplay(
    x.h.store,
    before,
    'reviewer',
    {dispatchId, generation},
  ), true);
  const after = x.h.store.run(run.id);
  assert.equal(after.calls, before.calls);
  const reservations = x.h.store.records(
    run.projectId,
    'ReviewPreparationReplayReservation',
  );
  assert.equal(reservations.length, 2);
  assert.equal(reservations.at(-1).data.approvalRecordId, markerId);
  assert.equal(reservations.at(-1).data.dispatchId, dispatchId);
  assert.throws(() => x.mod.reserveReviewPreparationReplay(
    x.h.store,
    after,
    'reviewer',
    {dispatchId, generation},
  ), {code: 'REVIEW_PREPARATION_REPLAY_CONSUMED'});
});

test('rebuilt packet replay refuses a missing current packet or stale history', async t => {
  const x = await fixture(t);
  const saved = x.h.store.db.prepare(
    "SELECT id,data FROM records WHERE run_id=? AND kind='ReviewPacket'",
  ).get(x.r.id);
  const stored = JSON.parse(saved.data);
  const oversized = {
    ...stored.packet,
    obsoleteParentCopy: 'x'.repeat(520000),
  };
  const previousPacketHash = hash(oversized);
  x.h.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(
    JSON.stringify({sha256: previousPacketHash, packet: oversized}),
    saved.id,
  );
  const mod = await import(retryModule);
  const current = x.h.store.run(x.r.id);
  const rebuiltHash = hash(buildReviewPacket(x.h.store, current, x.s));
  const basis = mod.reviewPreparationBasis(
    x.h.store,
    current,
    rebuiltHash,
    {allowPacketRebuild: true},
  );
  x.h.store.record('ReviewPreparationRecovery', x.r.projectId, x.r.id, {
    ...basis,
    actorHash: 'a'.repeat(64),
    sourceHash: current.treeHash,
    specHash: current.specHash,
    planVersionHash: current.planVersionHash,
    calls: current.calls,
    repairCount: current.repairCount,
    createdAt: current.createdAt,
    maxSeconds: current.maxSeconds,
    modelDispatched: false,
  });
  const paused = x.h.store.run(x.r.id);
  paused.state = 'PAUSED';
  paused.reason = 'REVIEW_PREPARATION_RECHECKED';
  x.h.store.saveRun(paused);
  const resumed = x.h.store.run(x.r.id);
  resumed.state = 'REVIEWING';
  resumed.reason = null;
  x.h.store.saveRun(resumed);
  const dispatchId = 'OFFLINE_MISSING_REBUILT_PACKET';
  const generation = 'OFFLINE_MISSING_REBUILT_GENERATION';
  x.h.store.record('DispatchGranted', x.r.projectId, x.r.id, {
    kind: 'reviewer',
    mode: 'live',
    dispatchId,
    generation,
  });
  assert.throws(() => mod.reserveReviewPreparationReplay(
    x.h.store,
    x.h.store.run(x.r.id),
    'reviewer',
    {dispatchId, generation},
  ));

  x.h.store.record('ReviewPacket', x.r.projectId, x.r.id, {
    packet: buildReviewPacket(x.h.store, x.h.store.run(x.r.id), x.s),
    sha256: rebuiltHash,
  });
  x.h.store.db.prepare(
    "UPDATE records SET data=json_set(data,'$.previousPacketHash',?) "
      + "WHERE run_id=? AND kind='ReviewPreparationRecovery'",
  ).run('b'.repeat(64), x.r.id);
  assert.throws(() => mod.reserveReviewPreparationReplay(
    x.h.store,
    x.h.store.run(x.r.id),
    'reviewer',
    {dispatchId, generation},
  ));
});
