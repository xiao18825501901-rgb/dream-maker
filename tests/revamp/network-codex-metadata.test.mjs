// OFFLINE endpoint contract. The injected reader does not start Codex or contact OpenAI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../../dist/server/http.js';
import { defaults } from '../../dist/server/config.js';
import { root } from '../helpers.mjs';

const observations = () => ({
  windows: {
    available: true,
    systemProxyEnabled: true,
    loopbackProxy: true,
    codexServerRunning: false,
    dshRunning: false
  },
  wsl: {
    available: false,
    codexLoginRunning: false,
    codexServerRunning: false,
    proxyPresent: false,
    account: { mode: 'UNKNOWN', fingerprint: null },
    rejections: []
  },
  controller: {
    available: true,
    selectors: 1,
    nodes: 2,
    selectionPolicy: 'current',
    configuredSelector: 'fixture-selector',
    configuredNode: null,
    selectedNode: 'fixture-node',
    selectionMatchesExpected: null
  },
  dshHistory: null
});

const metadata = () => ({
  schema: 'dream-maker.codex-metadata.v1',
  at: '2026-11-10T08:00:00.000Z',
  transport: 'stdio',
  route: {
    path: 'DM_ROUTE_DISABLED',
    proxyEndpoint: null,
    proxyFingerprint: null
  },
  account: { type: 'chatgpt' },
  configuredModel: 'gpt-6-sol',
  models: [{ id: 'gpt-6-sol', model: 'gpt-6-sol' }],
  configuredModelListed: true,
  catalogComplete: true,
  quota: {
    ordinaryUsageAllowed: false,
    buckets: [{
      limitId: 'codex',
      spendControlReached: false,
      hasCredits: false,
      unlimitedCredits: false
    }]
  },
  errors: [],
  actualServedModel: 'NOT_VERIFIED',
  modelTurnsRequested: 0,
  cleanupReturned: true
});

async function fixture(t, controls = {}) {
  const temp = join(root, '.runtime/test-temp');
  mkdirSync(temp, { recursive: true });
  const data = mkdtempSync(join(temp, 'network-codex-metadata-'));
  const config = structuredClone(defaults);
  config.clash = {
    ...config.clash,
    enabled: false,
    selector: 'fixture-selector'
  };
  config.codex = {
    ...config.codex,
    home: join(data, 'codex-home'),
    model: 'gpt-6-sol'
  };
  writeFileSync(join(data, 'config.json'), JSON.stringify(config));
  let reads = 0;
  const app = await createApp({
    root,
    data,
    configPath: join(data, 'config.json'),
    port: 0,
    networkCollector: async () => ({
      ...observations(),
      controller: controls.controller ? controls.controller() : observations().controller
    }),
    networkCodexMetadata: async () => {
      reads += 1;
      return metadata();
    }
  });
  t.after(async () => {
    await app.close();
    rmSync(data, { force: true, recursive: true });
  });
  return { app, reads: () => reads };
}

async function session(app) {
  const login = await fetch(app.origin + '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap: app.bootstrap })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  return {
    cookie,
    'x-csrf-token': csrf,
    'content-type': 'application/json'
  };
}

test('Codex metadata endpoint keeps authentication, usage permission and inference separate', async (t) => {
  const x = await fixture(t);
  const url = x.app.origin + '/api/network/codex-metadata';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);

  const auth = await session(x.app);
  assert.equal((await fetch(url, {
    method: 'POST',
    headers: {
      cookie: auth.cookie,
      'content-type': 'application/json',
      'idempotency-key': 'codex-metadata-no-csrf'
    },
    body: '{}'
  })).status, 403);
  assert.equal(x.reads(), 0);

  const response = await fetch(url, {
    method: 'POST',
    headers: auth,
    body: '{}'
  });
  assert.equal(response.status, 400);

  const headers = { ...auth, 'idempotency-key': 'codex-metadata-offline' };
  for (let i = 0; i < 2; i += 1) {
    const result = await fetch(url, {
      method: 'POST',
      headers,
      body: '{}'
    });
    assert.equal(result.status, 200);
    const value = await result.json();
    assert.equal(value.schema, 'dream-maker.codex-metadata-observation.v1');
    assert.equal(value.account.state, 'OBSERVED');
    assert.equal(value.account.authentication, 'AUTHENTICATED_METADATA_ONLY');
    assert.equal(value.usage.state, 'RESTRICTED');
    assert.equal(value.serviceEligibility.state, 'USAGE_RESTRICTED');
    assert.equal(value.inference.state, 'NOT_RUN');
    assert.equal(value.modelTurnsRequested, 0);
    assert.equal(value.cleanupReturned, true);
  }
  assert.equal(x.reads(), 1);
  assert.equal(x.app.store.projects().length, 0);
  assert.equal(x.app.store.runs().length, 0);
});

test('Codex metadata endpoint rejects fields and cannot be used as a model or login route', async (t) => {
  const x = await fixture(t);
  const auth = await session(x.app);
  const response = await fetch(x.app.origin + '/api/network/codex-metadata', {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': 'codex-metadata-extra-field' },
    body: JSON.stringify({ login: true, model: 'foreign-model' })
  });
  assert.equal(response.status, 400);
  assert.equal(x.reads(), 0);
});

test('a metadata replay does not restart Codex and becomes stale when the CFW selection changes', async (t) => {
  let selectedNode = 'fixture-node-a';
  const x = await fixture(t, {
    controller: () => ({
      ...observations().controller,
      selectedNode
    })
  });
  const auth = await session(x.app);
  const url = x.app.origin + '/api/network/codex-metadata';
  const headers = { ...auth, 'idempotency-key': 'codex-metadata-selection-sensitive' };
  const first = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).currentConfiguration, true);

  selectedNode = 'fixture-node-b';
  const replay = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(replay.status, 200);
  const value = await replay.json();
  assert.equal(value.currentConfiguration, false);
  assert.equal(value.controller.selectedNode, 'fixture-node-b');
  assert.equal(value.inference.state, 'NOT_RUN');
  assert.equal(x.reads(), 1);
});
