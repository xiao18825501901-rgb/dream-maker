// Actual localhost HTTP reaches the original authenticated route. No model or project is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../../dist/server/http.js';
import { defaults } from '../../dist/server/config.js';
import { root } from '../helpers.mjs';

test('authenticated Laya probe calls only the configured loopback health and info endpoints', async t => {
  const requests = [];
  const laya = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/health')
      res.end(JSON.stringify({ ok: true, status: 'ok', requestId: 'fixture-health' }));
    else if (req.url === '/info')
      res.end(JSON.stringify({ revision: 'fixture-revision', tokenizer: 'fixture-tokenizer', device: 'cpu' }));
    else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    laya.once('error', reject);
    laya.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    laya.closeAllConnections();
    laya.close(resolve);
  }));

  const temp = join(root, '.runtime/test-temp');
  mkdirSync(temp, { recursive: true });
  const data = mkdtempSync(join(temp, 'laya-probe-http-'));
  const config = structuredClone(defaults);
  config.laya.baseUrl = `http://127.0.0.1:${laya.address().port}`;
  config.laya.mode = 'off';
  writeFileSync(join(data, 'config.json'), JSON.stringify(config));

  let modelCalls = 0;
  const app = await createApp({
    root,
    data,
    configPath: join(data, 'config.json'),
    port: 0,
    paidRequestGuard: () => {
      modelCalls++;
      throw new Error('MODEL_MUST_NOT_RUN');
    }
  });
  t.after(async () => {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  });

  const url = app.origin + '/api/diagnostics/laya';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);

  const login = await fetch(app.origin + '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap: app.bootstrap })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      'idempotency-key': 'explicit-laya-probe'
    },
    body: '{}'
  });

  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.base, config.laya.baseUrl);
  assert.equal(body.health.ok, true);
  assert.equal(body.info.revision, 'fixture-revision');
  assert.equal(body.verified, 'HTTP_ONLY_NOT_MODEL_QUALITY');
  assert.deepEqual([...requests].sort(), ['/health', '/info']);
  assert.equal(modelCalls, 0);
  assert.equal(app.store.projects().length, 0);
  assert.equal(app.store.runs().length, 0);
});
