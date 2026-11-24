// OFFLINE projection: TCP reachability is never promoted to proxy use or eligibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  networkContextsSnapshot,
  readWslProxyReachability
} from '../../dist/server/network-contexts.js';
import {
  networkContextsPanel,
  readNetworkContexts
} from '../../dist/web/network-context-view.js';

const at = '2026-11-10T00:00:00.000Z';
const reachable = {
  schema: 'dream-maker.wsl-proxy-reachability.v1',
  state: 'TCP_REACHABLE_ONLY',
  gateway: '172.27.48.1',
  port: 7890,
  elapsedMs: 1,
  routeSource: 'WSL_DEFAULT_ROUTE',
  networkPayloadBytes: 0,
  httpRequests: 0,
  tlsHandshakes: 0,
  modelCalls: 0,
  filesWritten: 0
};
const observations = () => ({
  windows: {
    available: true,
    systemProxyEnabled: true,
    loopbackProxy: true
  },
  wsl: {
    available: true,
    codexLoginRunning: false,
    codexServerRunning: false,
    proxyPresent: false,
    account: { mode: 'UNKNOWN', fingerprint: null },
    rejections: []
  },
  controller: {
    available: true,
    selectors: 2,
    nodes: 17,
    selectionPolicy: 'current',
    configuredSelector: 'selector',
    configuredNode: null,
    selectedNode: 'current-node',
    selectionMatchesExpected: null,
    mixedPort: 7890
  },
  dshHistory: null,
  wslProxyReachability: reachable
});

test('WSL TCP reachability keeps actual proxy use, account and inference unverified', () => {
  const config = {
    codex: {
      transport: 'wsl',
      wslDistro: 'DreamMaker-Acceptance-F-20261101-R2'
    },
    clash: { enabled: true, selectionPolicy: 'current' }
  };
  const snapshot = networkContextsSnapshot(config, observations(), at);
  const wsl = snapshot.contexts.find(row => row.id === 'wsl-codex-login');
  assert.equal(snapshot.wslProxyReachability.state, 'TCP_REACHABLE_ONLY');
  assert.equal(wsl.path.state, 'SCOPE_BLOCKED');
  assert.equal(wsl.routing.observed.state, 'NOT_VERIFIED');
  assert.equal(wsl.service.state, 'NOT_VERIFIED');
  assert.equal(snapshot.openAi.authentication.state, 'NOT_VERIFIED');
  assert.equal(snapshot.openAi.serviceEligibility.state, 'NOT_VERIFIED');
  assert.equal(snapshot.openAi.inference.state, 'NOT_RUN');
});

test('panels expose TCP-only evidence without offering node switching or login', () => {
  const config = {
    codex: { transport: 'wsl' },
    clash: { enabled: true, selectionPolicy: 'current' }
  };
  const snapshot = networkContextsSnapshot(config, observations(), at);
  const html = networkContextsPanel({ networkContexts: readNetworkContexts(snapshot) });
  assert.match(html, /WSL 到 Windows CFW：仅 TCP 可达/);
  assert.match(html, /172[.]27[.]48[.]1:7890/);
  assert.match(html, /不能证明 WSL Codex 实际使用了该代理/);
  assert.doesNotMatch(html, /data-action="(?:login|clash-select|clash-node)"/);
});

test('WSL helper projections reject attempted HTTP, TLS, model and unsafe gateway claims', () => {
  assert.equal(readWslProxyReachability(null).state, 'NOT_TESTED');
  assert.equal(readWslProxyReachability(reachable).state, 'TCP_REACHABLE_ONLY');
  for (const change of [
    { gateway: '8.8.8.8' },
    { gateway: '127.0.0.1' },
    { httpRequests: 1 },
    { tlsHandshakes: 1 },
    { modelCalls: 1 },
    { filesWritten: 1 },
    { elapsedMs: null }
  ]) {
    assert.throws(
      () => readWslProxyReachability({ ...reachable, ...change }),
      error => error.code === 'NETWORK_WSL_PROXY_OBSERVATION_INVALID'
    );
  }
});
