// OFFLINE contract: the WSL diagnostic is displayed as a capability and node
// correlation observation, never as a WSL Codex process or inference result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readWslProxyTlsObservation,
  networkContextsSnapshot
} from '../../dist/server/network-contexts.js';
import {
  networkContextsPanel,
  readNetworkContexts
} from '../../dist/web/network-context-view.js';

const at = '2026-11-10T00:00:00Z';
const target = (targetHost, overrides = {}) => ({
  schema: 'dream-maker.wsl-proxy-tls-observation.v1',
  state: 'CONNECT_AND_TLS_COMPLETED',
  targetHost,
  targetPort: 443,
  gateway: '172.27.48.1',
  proxyPort: 7890,
  protocol: 'TLSv1.3',
  alpn: 'http/1.1',
  authorized: true,
  elapsedMs: 21,
  cipher: 'TLS_AES_256_GCM_SHA384',
  errorClass: null,
  sourcePortSha256: 'a'.repeat(64),
  selectedNode: 'fixture-node',
  expectedNode: 'fixture-node',
  selectionMatchesExpected: true,
  nodeChainMatched: true,
  chains: ['fixture-node', 'fixture-selector'],
  proxyConnectRequests: 1,
  proxyControlBytes: 93,
  originHttpRequests: 0,
  modelCalls: 0,
  filesWritten: 0,
  ...overrides
});
const observations = () => ({
  windows: { available: true, systemProxyEnabled: true, loopbackProxy: true },
  wsl: {
    available: false,
    codexLoginRunning: false,
    codexServerRunning: false,
    proxyPresent: true,
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
  dshHistory: null,
  wslProxyTls: [target('api.openai.com'), target('chatgpt.com')]
});

test('a completed WSL TLS observation is accepted and retains a hashed source port only', () => {
  const parsed = readWslProxyTlsObservation(target('api.openai.com'));
  assert.equal(parsed.state, 'CONNECT_AND_TLS_COMPLETED');
  assert.equal(parsed.sourcePortSha256, 'a'.repeat(64));
  assert.equal(parsed.originHttpRequests, 0);
  assert.throws(
    () => readWslProxyTlsObservation(target('api.openai.com', { originHttpRequests: 1 })),
    error => error.code === 'NETWORK_WSL_PROXY_TLS_OBSERVATION_INVALID'
  );
  assert.throws(
    () => readWslProxyTlsObservation(target('api.openai.com', { targetPort: 80 })),
    error => error.code === 'NETWORK_WSL_PROXY_TLS_OBSERVATION_INVALID'
  );
});

test('the settings panel separates WSL capability evidence from actual Codex and inference evidence', () => {
  const snapshot = networkContextsSnapshot(
    { codex: { transport: 'stdio' }, clash: { enabled: true, selectionPolicy: 'current' } },
    observations(),
    at
  );
  const view = networkContextsPanel({ networkContexts: readNetworkContexts(snapshot) });
  assert.match(view, /专用 WSL 经现有 CFW 的 OpenAI 目标检查/);
  assert.match(view, /WSL 到 OpenAI API/);
  assert.match(view, /WSL 到 Codex 登录域/);
  assert.match(view, /不是实际 WSL Codex 进程证据/);
  assert.doesNotMatch(view, /172[.]27[.]53[.]208/);
  assert.doesNotMatch(view, /INFERENCE_COMPLETED/);
});
