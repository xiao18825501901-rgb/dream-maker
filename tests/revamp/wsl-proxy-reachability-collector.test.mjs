// OFFLINE collector contract: the dedicated WSL TCP capability check is
// independent from the selected Codex transport and never reads credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createLocalNetworkCollector } from '../../dist/server/network-context-observer.js';

const distro = 'DreamMaker-Acceptance-F-20261101-R2';
const reachable = {
  schema: 'dream-maker.wsl-proxy-reachability.v1',
  state: 'TCP_REACHABLE_ONLY',
  gateway: '172.27.48.1',
  port: 7890,
  elapsedMs: 2,
  routeSource: 'WSL_DEFAULT_ROUTE',
  networkPayloadBytes: 0,
  httpRequests: 0,
  tlsHandshakes: 0,
  modelCalls: 0,
  filesWritten: 0
};
const helperObservation = targetHost => ({
  schema: 'dream-maker.wsl-proxy-tls-helper-observation.v1',
  state: 'CONNECT_AND_TLS_COMPLETED',
  targetHost,
  targetPort: 443,
  gateway: '172.27.48.1',
  proxyPort: 7890,
  protocol: 'TLSv1.3',
  alpn: 'http/1.1',
  authorized: true,
  elapsedMs: 21,
  errorClass: null,
  proxyConnectRequests: 1,
  proxyControlBytes: 93,
  originHttpRequests: 0,
  modelCalls: 0,
  filesWritten: 0
});
const readiness = targetHost => ({
  schema: 'dream-maker.wsl-proxy-tls-readiness.v1',
  stage: 'READY',
  targetHost,
  targetPort: 443,
  gateway: '172.27.48.1',
  proxyPort: 7890,
  sourceAddress: '172.27.53.208',
  sourcePort: 42900
});

test('collector checks the dedicated WSL proxy capability even when Codex uses stdio', { skip: process.platform !== 'win32' }, async () => {
  const calls = [];
  const traced = [];
  const store = {
    db: {
      prepare() {
        return { all: () => [] };
      }
    }
  };
  const collector = createLocalNetworkCollector({
    root: resolve('.'),
    store,
    clash: {
      inspect: async () => ({
        controller: { version: 'fixture', mode: 'rule', mixedPort: 7890, controllerPort: 49697 },
        configured: { selector: 'fixture-selector', node: '', selectionPolicy: 'current' },
        selectors: [{ name: 'fixture-selector', now: 'fixture-node' }],
        nodes: [{ name: 'fixture-node' }]
      }),
      traceConnection: async identity => {
        traced.push(identity);
        return {
          chains: ['fixture-node', 'fixture-selector'],
          rule: 'Match',
          inboundPortMatched: false
        };
      }
    }
  }, {
    verifyEnvironment: async () => {
      throw new Error('stdio collection must not inspect WSL credentials');
    },
    capture: async (command, _args, options) => {
      calls.push(command);
      if (command.toLowerCase().endsWith('wsl.exe')) {
        const input = JSON.parse(options.input);
        if (input.targetHost) {
          options.onStdout?.(JSON.stringify(readiness(input.targetHost)) + '\n');
          return {
            code: 0,
            stdout: JSON.stringify(readiness(input.targetHost)) + '\n' + JSON.stringify(helperObservation(input.targetHost)) + '\n',
            stderr: ''
          };
        }
        assert.deepEqual(input, { port: 7890 });
        return { code: 0, stdout: JSON.stringify(reachable), stderr: '' };
      }
      if (Object.hasOwn(JSON.parse(options.input), 'mixedPort')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            available: true,
            mixedPort: 7890,
            bindings: ['LOOPBACK'],
            ownerMatchesController: true
          }),
          stderr: ''
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          available: true,
          systemProxyEnabled: true,
          loopbackProxy: true,
          dshRunning: false,
          codexServerRunning: false,
          developmentCodexRunning: false,
          magpieRunning: false
        }),
        stderr: ''
      };
    }
  });
  const config = {
    codex: {
      transport: 'stdio',
      wslDistro: distro,
      wslHome: '/opt/dream-maker-controller/codex-home-p2',
      wslBinary: '/opt/dream-maker-controller/codex',
      wslCommand: 'wsl.exe'
    },
    clash: { enabled: true }
  };
  const observed = await collector(config, new AbortController().signal);
  assert.equal(observed.wsl.available, false);
  assert.equal(observed.wslProxyReachability?.state, 'TCP_REACHABLE_ONLY');
  assert.equal(observed.wslProxyReachability?.gateway, '172.27.48.1');
  assert.ok(calls.some(command => command.toLowerCase().endsWith('wsl.exe')));
  assert.equal(observed.wslProxyTls?.length, 2);
  assert.deepEqual(observed.wslProxyTls.map(value => value.targetHost), ['api.openai.com', 'chatgpt.com']);
  for (const value of observed.wslProxyTls) {
    assert.equal(value.state, 'CONNECT_AND_TLS_COMPLETED');
    assert.equal(value.protocol, 'TLSv1.3');
    assert.equal(value.selectedNode, 'fixture-node');
    assert.equal(value.expectedNode, 'fixture-node');
    assert.equal(value.selectionMatchesExpected, true);
    assert.equal(value.nodeChainMatched, true);
    assert.equal(value.originHttpRequests, 0);
    assert.equal(value.modelCalls, 0);
  }
  assert.equal(traced.length, 2);
  assert.doesNotMatch(JSON.stringify(observed.wslProxyTls), /172[.]27[.]53[.]208|42900/);
});

test('collector does not hide an uncertain WSL TLS helper cleanup', { skip: process.platform !== 'win32' }, async () => {
  const store = {
    db: {
      prepare() {
        return { all: () => [] };
      }
    }
  };
  const collector = createLocalNetworkCollector({
    root: resolve('.'),
    store,
    clash: {
      inspect: async () => ({
        controller: { version: 'fixture', mode: 'rule', mixedPort: 7890, controllerPort: 49697 },
        configured: { selector: 'fixture-selector', node: '', selectionPolicy: 'current' },
        selectors: [{ name: 'fixture-selector', now: 'fixture-node' }],
        nodes: [{ name: 'fixture-node' }]
      }),
      traceConnection: async () => {
        throw new Error('cleanup failure must happen before association');
      }
    }
  }, {
    verifyEnvironment: async () => {
      throw new Error('stdio collection must not inspect WSL credentials');
    },
    capture: async (_command, _args, options) => {
      const input = JSON.parse(options.input);
      if (input.targetHost) {
        const error = new Error('synthetic cleanup uncertainty');
        error.code = 'PROCESS_CLEANUP_UNPROVEN';
        throw error;
      }
      if (Object.hasOwn(input, 'port')) {
        return { code: 0, stdout: JSON.stringify(reachable), stderr: '' };
      }
      if (Object.hasOwn(input, 'mixedPort')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            available: true,
            mixedPort: 7890,
            bindings: ['LOOPBACK'],
            ownerMatchesController: true
          }),
          stderr: ''
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          available: true,
          systemProxyEnabled: true,
          loopbackProxy: true,
          dshRunning: false,
          codexServerRunning: false,
          developmentCodexRunning: false,
          magpieRunning: false
        }),
        stderr: ''
      };
    }
  });
  const config = {
    codex: {
      transport: 'stdio',
      wslDistro: distro,
      wslHome: '/opt/dream-maker-controller/codex-home-p2',
      wslBinary: '/opt/dream-maker-controller/codex',
      wslCommand: 'wsl.exe'
    },
    clash: { enabled: true }
  };
  await assert.rejects(
    collector(config, new AbortController().signal),
    error => error?.code === 'PROCESS_CLEANUP_UNPROVEN'
  );
});
