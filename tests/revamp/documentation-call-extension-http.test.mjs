// Actual local HTTP auth/CSRF/idempotency with an explicit Engine substitute.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {defaults} from '../../dist/server/config.js';
import {root} from '../helpers.mjs';

test('authenticated owner path records one call extension without dispatching a model', async t => {
  const dir = join(root, '.runtime/test-temp');
  mkdirSync(dir, {recursive: true});
  const data = mkdtempSync(join(dir, 'doc-call-extension-http-'));
  const configPath = join(data, 'config.json');
  writeFileSync(configPath, JSON.stringify(defaults));
  let models = 0;
  let extensions = 0;
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

  const url = app.origin + '/api/runs/OFFLINE_CHILD/documentation-correction/extend-calls';
  const input = {
    confirmed: true,
    expectedVersion: 8,
    approvalRecordId: 'rec_APPROVAL',
    approvalHash: 'a'.repeat(64),
    ownerDecisionHash: 'b'.repeat(64),
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
  app.engine.extendDocumentationContinuation = async (rid, body, actor) => {
    extensions++;
    assert.equal(rid, 'OFFLINE_CHILD');
    assert.deepEqual(body, input);
    assert.match(actor, /^local-session:[a-f0-9]{64}$/);
    assert.equal(app.engine.activeJobCount, 0);
    return {
      id: 'OFFLINE_CHILD',
      state: 'PAUSED',
      phase: 'IMPLEMENTING',
      version: 9,
      treeHash: 'c'.repeat(64),
      calls: 1,
      maxCalls: 3,
      repairCount: 1,
      maxRepairs: 1,
      reason: 'EXECUTOR_CHECKPOINT_PREPARED',
      documentationContinuation: {recordId: 'rec_APPROVAL', sha256: input.approvalHash},
      documentationContinuationExtension: {recordId: 'rec_EXTENSION', sha256: 'd'.repeat(64)},
    };
  };

  const send = (body = input, headers = {}, suffix = '') => fetch(url + suffix, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'idempotency-key': crypto.randomUUID(),
      ...headers,
    },
    body: JSON.stringify(body),
  });

  assert.equal((await send(input, {'x-csrf-token': 'WRONG'})).status, 403);
  assert.equal((await send({...input, confirmed: false})).status, 403);
  for (const body of [
    {...input, additionalCalls: 2},
    {...input, maxCalls: 99},
    {...input, expectedVersion: 0},
    {...input, approvalHash: 'not-a-hash'},
  ]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal((await send(input, {}, '?maxCalls=99')).status, 400);
  assert.equal(extensions, 0);

  const response = await send();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.runId, 'OFFLINE_CHILD');
  assert.equal(result.maxCalls, 3);
  assert.equal(result.calls, 1);
  assert.equal(result.additionalCalls, 1);
  assert.equal(result.executionStartedByPreparation, false);
  assert.equal(result.modelDispatched, false);
  assert.equal(models, 0);
  assert.equal(extensions, 1);
  assert.equal(app.store.runs().length, 0);
  assert.ok(JSON.stringify(result).length < 2048);
});
