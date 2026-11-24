// Isolated Engine/Store only. No model, product database or qualification evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {documentationCorrectionFixture} from '../fixtures/documentation-correction.mjs';
import {hash} from '../../dist/server/security.js';

const actor = 'local-session:' + 'a'.repeat(64);
const ownerDecisionHash = 'b'.repeat(64);

async function fixture(t) {
  const x = await documentationCorrectionFixture(t, {includeMainTask: true});
  const candidate = x.h.engine.documentationCorrectionCandidate(x.r.id, 'README.md');
  const child = await x.h.engine.approveDocumentationContinuation(x.r.id, {
    confirmed: true,
    file: 'README.md',
    candidateHash: candidate.candidateHash,
    taskDeadline: null,
  }, actor);
  const consumed = x.h.store.run(child.id);
  consumed.calls = 1;
  consumed.repairCount = 1;
  consumed.reason = 'EXECUTOR_CHECKPOINT_PREPARED';
  consumed.tasks = consumed.tasks.map(task => task.id === 'OFFLINE_DOC'
    ? {...task, status: 'pending'}
    : task);
  x.h.store.saveRun(consumed);
  const current = x.h.store.run(child.id);
  const input = {
    confirmed: true,
    expectedVersion: current.version,
    approvalRecordId: current.documentationContinuation.recordId,
    approvalHash: current.documentationContinuation.sha256,
    ownerDecisionHash,
  };
  return {...x, childId: child.id, input};
}

function extensionRows(x) {
  return x.h.store.records(x.p.id, 'DocumentationContinuationCallExtension');
}

test('one audited call extension preserves the consumed boundary and does not dispatch or resume', async t => {
  const x = await fixture(t);
  const before = x.h.store.run(x.childId);
  const approvalRow = x.h.store.db.prepare(
    "SELECT data FROM records WHERE id=? AND kind='DocumentationContinuationApproval'",
  ).get(before.documentationContinuation.recordId);
  const approvalBytes = String(approvalRow.data);
  const approval = JSON.parse(approvalBytes);

  const after = await x.h.engine.extendDocumentationContinuation(x.childId, x.input, actor);

  assert.equal(after.maxCalls, 3);
  assert.equal(after.calls, before.calls);
  assert.equal(after.repairCount, before.repairCount);
  assert.equal(after.maxRepairs, before.maxRepairs);
  assert.equal(after.state, before.state);
  assert.equal(after.phase, before.phase);
  assert.equal(after.reason, before.reason);
  assert.equal(after.treeHash, before.treeHash);
  assert.deepEqual(after.documentationContinuation, before.documentationContinuation);
  assert.ok(after.documentationContinuationExtension?.recordId);
  assert.match(after.documentationContinuationExtension.sha256, /^[a-f0-9]{64}$/);
  assert.equal(x.h.engine.activeJobCount, 0);

  const rows = extensionRows(x);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.schema, 'dream-maker.documentation-continuation-call-extension.v1');
  assert.equal(rows[0].data.runId, x.childId);
  assert.equal(rows[0].data.approvalRecordId, before.documentationContinuation.recordId);
  assert.equal(rows[0].data.approvalHash, before.documentationContinuation.sha256);
  assert.equal(rows[0].data.additionalCalls, 1);
  assert.equal(rows[0].data.previousMaxCalls, 2);
  assert.equal(rows[0].data.newMaxCalls, 3);
  assert.equal(rows[0].data.previousSeriesMaxCalls, approval.seriesMaxCalls);
  assert.equal(rows[0].data.newSeriesMaxCalls, rows[0].data.previousSeriesMaxCalls + 1);
  assert.equal(rows[0].data.ownerDecisionHash, ownerDecisionHash);
  assert.equal(rows[0].data.modelDispatched, false);
  assert.equal(rows[0].data.automaticRepair, false);
  assert.equal(
    x.h.store.db.prepare(
      "SELECT data FROM records WHERE id=? AND kind='DocumentationContinuationApproval'",
    ).get(before.documentationContinuation.recordId).data,
    approvalBytes,
    'the original approval is immutable',
  );
});

test('same boundary is idempotent but a changed owner decision or caller limit is refused', async t => {
  const x = await fixture(t);
  const first = await x.h.engine.extendDocumentationContinuation(x.childId, x.input, actor);
  const replay = await x.h.engine.extendDocumentationContinuation(x.childId, x.input, actor);
  assert.equal(replay.id, first.id);
  assert.equal(extensionRows(x).length, 1);

  for (const changed of [
    {...x.input, ownerDecisionHash: 'c'.repeat(64)},
    {...x.input, expectedVersion: first.version + 1},
  ]) {
    await assert.rejects(
      x.h.engine.extendDocumentationContinuation(x.childId, changed, actor),
      {code: 'DOCUMENTATION_CALL_EXTENSION_CHANGED'},
    );
  }
  for (const invalid of [
    {...x.input, additionalCalls: 2},
    {...x.input, maxCalls: 99},
  ]) {
    await assert.rejects(
      x.h.engine.extendDocumentationContinuation(x.childId, invalid, actor),
      {code: 'DOCUMENTATION_CALL_EXTENSION_INPUT_INVALID'},
    );
  }
  await assert.rejects(
    x.h.engine.extendDocumentationContinuation(x.childId, {...x.input, confirmed: false}, actor),
    {code: 'DOCUMENTATION_CALL_EXTENSION_CONFIRMATION_REQUIRED'},
  );
  assert.equal(extensionRows(x).length, 1);
  assert.equal(x.h.store.run(x.childId).maxCalls, 3);
});

test('extension is denied before the one consumed call or after protected source drift', async t => {
  const x = await fixture(t);
  const fresh = {...x.h.store.run(x.childId), calls: 0};
  x.h.store.saveRun(fresh);
  await assert.rejects(
    x.h.engine.extendDocumentationContinuation(x.childId, {...x.input, expectedVersion: fresh.version}, actor),
    {code: 'DOCUMENTATION_CALL_EXTENSION_NOT_ELIGIBLE'},
  );
  const restored = x.h.store.run(x.childId);
  restored.calls = 1;
  x.h.store.saveRun(restored);
  writeFileSync(join(restored.workspace, 'main.mjs'), 'OFFLINE protected source changed');
  await assert.rejects(
    x.h.engine.extendDocumentationContinuation(x.childId, {...x.input, expectedVersion: restored.version}, actor),
    {code: 'DOCUMENTATION_CONTINUATION_PROTECTED_SOURCE_CHANGED'},
  );
  assert.equal(extensionRows(x).length, 0);
});

test('resume distinguishes an initial preparation from an executed checkpoint', async t => {
  const x = await fixture(t);
  const current = x.h.store.run(x.childId);
  const reservation = {
    schema: 'dream-maker.documentation-native-repair-reservation.v1',
    runId: current.id,
    parentRunId: x.r.id,
    approvalRecordId: current.documentationContinuation.recordId,
    approvalHash: current.documentationContinuation.sha256,
    sourceHash: current.treeHash,
    budgetRevision: 1,
    automaticRetry: false,
    modelDispatched: false,
  };
  x.h.store.record('DocumentationNativeRepairReservation', x.p.id, current.id, reservation);
  let launched = false;
  x.h.engine.launch = () => {
    launched = true;
  };
  x.h.engine.nativeExecution = {
    assertReady() {},
    executor() {
      throw Error('OFFLINE_EXECUTOR_MUST_NOT_RUN');
    },
    async verify() {
      throw Error('OFFLINE_VERIFIER_MUST_NOT_RUN');
    },
    async close() {},
    repairRevision() {
      return 1;
    },
    reserveRepair() {
      throw Error('OFFLINE_RESERVATION_MUST_NOT_BE_RENEWED');
    },
  };

  const resumed = await x.h.engine.resume(x.childId);

  assert.equal(resumed.state, 'IMPLEMENTING');
  assert.equal(launched, true);
  assert.equal(x.h.store.run(x.childId).calls, 1);
  assert.equal(x.h.store.run(x.childId).repairCount, 1);
});

test('Store reopen verifies the extension and preserves the original two-call continuation when absent', async t => {
  const x = await fixture(t);
  const {Store} = await import('../../dist/server/store.js');
  const {Engine} = await import('../../dist/server/engine.js');
  const {root} = await import('../helpers.mjs');
  const store = new Store(join(x.h.dir, 'state.sqlite'));
  const engine = new Engine(store, x.h.laya, () => x.h.config, root, x.h.dir, 0);
  try {
    engine.recover();
    const extended = await engine.extendDocumentationContinuation(x.childId, x.input, actor);
    assert.equal(extended.maxCalls, 3);
  } finally {
    await engine.close();
    store.close();
  }
});

test('a failed Store commit leaves no call extension and no raised limit', async t => {
  const x = await fixture(t);
  const before = x.h.store.run(x.childId);
  const mock = t.mock.method(x.h.store, 'saveRun', () => {
    throw Error('OFFLINE_EXTENSION_COMMIT_FAILURE');
  });
  await assert.rejects(
    x.h.engine.extendDocumentationContinuation(x.childId, x.input, actor),
    /OFFLINE_EXTENSION_COMMIT_FAILURE/,
  );
  mock.mock.restore();
  assert.equal(extensionRows(x).length, 0);
  assert.equal(x.h.store.run(x.childId).maxCalls, before.maxCalls);
  assert.equal(hash(x.h.store.run(x.childId)), hash(before));
});
