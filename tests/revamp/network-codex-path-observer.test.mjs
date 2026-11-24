// OFFLINE database projection only: the synthetic event is never a model or account receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../dist/server/store.js';
import { createLocalNetworkCollector } from '../../dist/server/network-context-observer.js';

const at = '2026-11-08T12:00:00.000Z';
const config = { codex: { transport: 'stdio' }, clash: { enabled: true } };

function windowsProjection() {
  return {
    available: true,
    systemProxyEnabled: true,
    loopbackProxy: true,
    dshRunning: false,
    codexServerRunning: true,
    developmentCodexRunning: false,
    magpieRunning: false
  };
}

test('collector reads only bounded, valid recorded Codex path events', async () => {
  const store = new Store(':memory:');
  try {
    store.event(null, null, 'agent.event', {
      method: 'dm/codexNetworkPath',
      params: {
        role: 'planner2',
        transport: 'stdio',
        path: 'CHILD_ENV_MATCH',
        proxyEndpoint: '127.0.0.1:7890',
        proxyFingerprint: 'a'.repeat(64)
      }
    });
    store.event(null, null, 'agent.event', {
      method: 'dm/codexNetworkPath',
      params: {
        role: 'reviewer',
        transport: 'stdio',
        path: 'CHILD_ENV_MATCH',
        proxyEndpoint: '127.0.0.1:7890',
        proxyFingerprint: 'NOT_A_HASH'
      }
    });
    const collect = createLocalNetworkCollector({
      root: process.cwd(),
      store,
      clash: {
        inspect: async () => ({
          controller: { version: 'fixture', mode: 'rule', mixedPort: 7890 },
          configured: { selector: 'fixture-selector', node: 'fixture-node' },
          selectors: [{ name: 'fixture-selector', now: 'fixture-node' }],
          nodes: [{ name: 'fixture-node' }]
        })
      }
    }, {
      verifyEnvironment: async () => {},
      capture: async () => ({ code: 0, stdout: JSON.stringify(windowsProjection()), stderr: '' })
    });
    const observed = await collect(config, new AbortController().signal);
    assert.deepEqual(observed.codexPaths, [{
      at: observed.codexPaths?.[0]?.at,
      role: 'planner2',
      transport: 'stdio',
      path: 'CHILD_ENV_MATCH',
      proxyEndpoint: '127.0.0.1:7890',
      proxyFingerprint: 'a'.repeat(64)
    }]);
    assert.match(observed.codexPaths?.[0]?.at ?? '', /^20\d\d-/);
  } finally {
    store.db.close();
  }
});

test('collector reads only the latest valid persisted routed-request projection', async () => {
  const store = new Store(':memory:');
  try {
    const valid = {
      schema: 'dream-maker.routed-request-observation.v1', at, startedAt: at, completedAt: at,
      process: 'DM_CONTROLLED_TRANSPORT', targetHost: 'api.openai.com', method: 'POST',
      selectionPolicy: 'current', selectedNode: 'fixture-node', expectedNode: 'fixture-node',
      httpStatus: 200, classification: 'INFERENCE_COMPLETED', automaticRetryAllowed: false,
      requestIdSha256: 'b'.repeat(64), elapsedMs: 12
    };
    store.event(null, null, 'network.routed-request', valid);
    store.event(null, null, 'network.routed-request', { ...valid, requestIdSha256: 'NOT_A_HASH' });
    const collect = createLocalNetworkCollector({
      root: process.cwd(),
      store,
      clash: {
        inspect: async () => ({
          controller: { version: 'fixture', mode: 'rule', mixedPort: 7890 },
          configured: { selector: 'fixture-selector', node: '', selectionPolicy: 'current' },
          selectors: [{ name: 'fixture-selector', now: 'fixture-node' }],
          nodes: [{ name: 'fixture-node' }]
        })
      }
    }, {
      verifyEnvironment: async () => {},
      capture: async () => ({ code: 0, stdout: JSON.stringify(windowsProjection()), stderr: '' })
    });
    const observed = await collect(config, new AbortController().signal);
    assert.equal(observed.latestRoutedRequest?.classification, 'INFERENCE_COMPLETED');
    assert.equal(observed.controller.selectionPolicy, 'current');
    assert.equal(observed.controller.selectionMatchesExpected, null);
  } finally {
    store.db.close();
  }
});

test('collector keeps separate latest OpenAI and DeepSeek request evidence', async () => {
  const store = new Store(':memory:');
  try {
    const base = {
      schema: 'dream-maker.routed-request-observation.v1', at, startedAt: at, completedAt: at,
      process: 'DM_CONTROLLED_TRANSPORT', selectionPolicy: 'current',
      selectedNode: 'fixture-node', expectedNode: 'fixture-node',
      automaticRetryAllowed: false, requestIdSha256: null, elapsedMs: 12
    };
    store.event(null, null, 'network.routed-request', {
      ...base, targetHost: 'api.openai.com', method: 'POST',
      httpStatus: 200, classification: 'INFERENCE_COMPLETED'
    });
    store.event(null, null, 'network.routed-request', {
      ...base, targetHost: 'api.deepseek.com', method: 'POST',
      httpStatus: 503, classification: 'HTTP_5XX_UPSTREAM_FAILURE'
    });
    const collect = createLocalNetworkCollector({
      root: process.cwd(),
      store,
      clash: {
        inspect: async () => ({
          controller: { version: 'fixture', mode: 'rule', mixedPort: 7890 },
          configured: { selector: 'fixture-selector', node: '', selectionPolicy: 'current' },
          selectors: [{ name: 'fixture-selector', now: 'fixture-node' }],
          nodes: [{ name: 'fixture-node' }]
        })
      }
    }, {
      verifyEnvironment: async () => {},
      capture: async () => ({ code: 0, stdout: JSON.stringify(windowsProjection()), stderr: '' })
    });
    const observed = await collect(config, new AbortController().signal);
    assert.equal(observed.latestRoutedRequests?.openAi?.classification, 'INFERENCE_COMPLETED');
    assert.equal(observed.latestRoutedRequests?.deepSeek?.classification, 'HTTP_5XX_UPSTREAM_FAILURE');
    assert.equal(observed.latestRoutedRequest?.targetHost, 'api.deepseek.com');
  } finally {
    store.db.close();
  }
});

test('collector reads a bounded request-level Codex route separately from agent recovery events', async () => {
  const store = new Store(':memory:');
  try {
    const valid = {
      schema: 'dream-maker.codex-request-path.v1',
      at,
      startedAt: at,
      completedAt: at,
      role: 'reviewer',
      method: 'turn/start',
      targetHost: 'chatgpt.com',
      targetPort: 443,
      path: 'REQUEST_ROUTE_VERIFIED',
      processPid: 4242,
      processIdentitySha256: 'a'.repeat(64),
      sourcePortSha256: 'b'.repeat(64),
      proxyEndpoint: '127.0.0.1:7890',
      selectedNode: 'fixture-node',
      expectedNode: 'fixture-node',
      chains: ['fixture-node', 'fixture-group'],
      classification: 'INFERENCE_COMPLETED',
      httpStatus: 200,
      requestIdSha256: 'c'.repeat(64),
      automaticRetryAllowed: false,
      sourcePort: 50123,
      rawRequestId: 'must-not-survive',
      secret: 'must-not-survive'
    };
    store.event(null, null, 'network.codex-request', valid);
    store.event(null, null, 'network.codex-request', {
      ...valid,
      path: 'REQUEST_ROUTE_VERIFIED',
      requestIdSha256: 'NOT_A_HASH'
    });
    const collect = createLocalNetworkCollector({
      root: process.cwd(),
      store,
      clash: {
        inspect: async () => ({
          controller: { version: 'fixture', mode: 'rule', mixedPort: 7890 },
          configured: { selector: 'fixture-selector', node: '', selectionPolicy: 'current' },
          selectors: [{ name: 'fixture-selector', now: 'fixture-node' }],
          nodes: [{ name: 'fixture-node' }]
        })
      }
    }, {
      verifyEnvironment: async () => {},
      capture: async () => ({ code: 0, stdout: JSON.stringify(windowsProjection()), stderr: '' })
    });
    const observed = await collect({ ...config, codex: { transport: 'stdio' } }, new AbortController().signal);
    assert.equal(observed.latestCodexRequest?.role, 'reviewer');
    assert.equal(observed.latestCodexRequest?.targetHost, 'chatgpt.com');
    assert.equal(observed.latestCodexRequest?.path, 'REQUEST_ROUTE_VERIFIED');
    assert.equal('sourcePort' in observed.latestCodexRequest, false);
    assert.equal('rawRequestId' in observed.latestCodexRequest, false);
    assert.equal('secret' in observed.latestCodexRequest, false);
  } finally {
    store.db.close();
  }
});
