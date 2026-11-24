// Actual local HTTP auth/CSRF/idempotency contract with an explicit Engine substitute.
// Exact run eligibility and replay semantics are covered against the real offline Engine
// in m117-bounded-code-repair.test.mjs; this test never represents Live evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {root} from '../helpers.mjs';

test('bounded code verification recovery uses the authenticated owner route without dispatching a model', async t => {
  const dir = join(root, '.runtime/test-temp');
  mkdirSync(dir, {recursive: true});
  const data = mkdtempSync(join(dir, 'bounded-code-recovery-http-'));
  const configPath = join(data, 'config.json');
  writeFileSync(configPath, JSON.stringify(defaults));
  let models = 0;
  let recoveries = 0;
  const app = await createApp({
    root,
    data,
    configPath,
    port: 0,
    paidRequestGuard: () => {
      models++;
      throw Error('MODEL_FORBIDDEN');
    },
  });
  t.after(async () => {
    await app.close();
    rmSync(data, {recursive: true, force: true});
  });

  const url = app.origin + '/api/runs/OFFLINE_CHILD/bounded-code-repair/recover-verification';
  const input = {
    confirmed: true,
    expectedVersion: 12,
    sourceHash: 'a'.repeat(64),
    verificationEvidenceId: 'rec_VERIFICATION',
    ownerDecisionHash: 'b'.repeat(64),
  };
  const response = {
    id: 'OFFLINE_CHILD',
    state: 'PAUSED',
    phase: 'IMPLEMENTING',
    version: 13,
    treeHash: input.sourceHash,
    calls: 1,
    maxCalls: 3,
    repairCount: 1,
    maxRepairs: 1,
    review: null,
    verification: {ok: false, evidenceId: input.verificationEvidenceId},
    boundedCodeVerificationRecovery: {
      recordId: 'rec_RECOVERY',
      sha256: 'c'.repeat(64),
    },
  };

  assert.equal((await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(input),
  })).status, 401);

  const login = await fetch(app.origin + '/api/session', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({bootstrap: app.bootstrap}),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const {csrf} = await login.json();
  app.engine.recoverBoundedCodeVerificationFailure = async (rid, body, actor) => {
    recoveries++;
    assert.equal(rid, 'OFFLINE_CHILD');
    assert.deepEqual(body, input);
    assert.match(actor, /^local-session:[a-f0-9]{64}$/);
    assert.equal(app.engine.activeJobCount, 0);
    return response;
  };

  const idempotencyKey = crypto.randomUUID();
  const send = (body = input, headers = {}, suffix = '') => fetch(url + suffix, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'idempotency-key': idempotencyKey,
      ...headers,
    },
    body: JSON.stringify(body),
  });

  assert.equal((await send(input, {'x-csrf-token': 'WRONG'})).status, 403);
  assert.equal((await send({...input, confirmed: false})).status, 403);
  for (const body of [
    {...input, additionalDshRepairs: 2},
    {...input, expectedVersion: 0},
    {...input, sourceHash: 'not-a-hash'},
    {...input, verificationEvidenceId: ''},
    {...input, ownerDecisionHash: 'not-a-hash'},
  ]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal((await send(input, {}, '?reviewerReviews=2')).status, 400);
  assert.equal(recoveries, 0);

  const first = await send();
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  assert.equal(firstResult.runId, 'OFFLINE_CHILD');
  assert.equal(firstResult.state, 'PAUSED');
  assert.equal(firstResult.version, 13);
  assert.equal(firstResult.calls, 1);
  assert.equal(firstResult.maxCalls, 3);
  assert.equal(firstResult.repairCount, 1);
  assert.equal(firstResult.maxRepairs, 1);
  assert.equal(firstResult.additionalDshRepairs, 1);
  assert.equal(firstResult.additionalReviewerReviews, 1);
  assert.equal(firstResult.modelDispatched, false);
  assert.equal(firstResult.executionStartedByPreparation, false);

  const replay = await send();
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstResult);
  assert.equal(recoveries, 2);
  assert.equal(models, 0);
  assert.equal(app.store.runs().length, 0);
  assert.ok(JSON.stringify(firstResult).length < 2048);
});
