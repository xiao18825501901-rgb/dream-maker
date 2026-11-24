import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { controlledProxyEnvironment } from '../../dist/server/clash-service.js';
import {
  codexLaunch,
  inspectCodexProxyEnvironment,
  loopbackProxyPortFromEnvironment,
  parseWslProxyBinding,
  wslProxyEnvironment,
  wslProxyFromEnvironment
} from '../../dist/server/providers/codex-transport.js';
import { wslProxyBindingFromObservation } from '../../dist/server/providers/codex-wsl-proxy.js';
import { defaults, parseConfig } from '../../dist/server/config.js';

test('synthetic Windows Codex child receives one consistent controlled proxy tuple', () => {
  const environment = controlledProxyEnvironment(
    { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    'http://127.0.0.1:7890/'
  );
  const child = spawnSync(process.execPath, ['-e', [
    'process.stdout.write(JSON.stringify({',
    'HTTP_PROXY:process.env.HTTP_PROXY,',
    'HTTPS_PROXY:process.env.HTTPS_PROXY,',
    'ALL_PROXY:process.env.ALL_PROXY,',
    'NO_PROXY:process.env.NO_PROXY',
    '}))'
  ].join('')], {
    env: environment,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(child.status, 0, child.stderr);
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.HTTP_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(actual.HTTPS_PROXY, actual.HTTP_PROXY);
  assert.equal(actual.ALL_PROXY, actual.HTTP_PROXY);
  assert.match(actual.NO_PROXY, /127[.]0[.]0[.]1/);
});

test('Codex route evidence distinguishes configured child environment from model eligibility', () => {
  const evidence = inspectCodexProxyEnvironment({
    clash: { enabled: true },
    codex: { transport: 'stdio' }
  }, {
    HTTP_PROXY: 'http://127.0.0.1:7890/',
    HTTPS_PROXY: 'http://127.0.0.1:7890/',
    ALL_PROXY: 'http://127.0.0.1:7890/',
    NO_PROXY: 'localhost,127.0.0.1,::1,[::1]'
  });
  assert.equal(evidence.path, 'CHILD_ENV_MATCH');
  assert.equal(evidence.proxyEndpoint, '127.0.0.1:7890');
  assert.equal(evidence.networkReachability, 'NOT_TESTED');
  assert.equal(evidence.authentication, 'NOT_VERIFIED');
  assert.equal(evidence.serviceEligibility, 'NOT_VERIFIED');
  assert.equal(evidence.modelInference, 'NOT_RUN');
});

test('enabled CFW without a leased child proxy fails closed', () => {
  assert.throws(() => inspectCodexProxyEnvironment({
    clash: { enabled: true },
    codex: { transport: 'stdio' }
  }, {}), { code: 'CODEX_PROXY_ENVIRONMENT_MISSING' });
});

test('mixed child proxy variables fail closed instead of choosing one silently', () => {
  assert.throws(() => inspectCodexProxyEnvironment({
    clash: { enabled: true },
    codex: { transport: 'stdio' }
  }, {
    HTTP_PROXY: 'http://127.0.0.1:7890/',
    HTTPS_PROXY: 'http://127.0.0.1:7891/',
    ALL_PROXY: 'http://127.0.0.1:7890/'
  }), { code: 'CODEX_PROXY_ENVIRONMENT_MISMATCH' });
});

test('WSL only accepts a private host gateway and emits one explicit child proxy tuple', () => {
  const binding = parseWslProxyBinding('http://172.27.48.1:7890/');
  assert.deepEqual(binding, {gateway:'172.27.48.1',port:7890,proxyUrl:'http://172.27.48.1:7890/'});
  const environment = wslProxyEnvironment(binding);
  assert.equal(environment.HTTP_PROXY, binding.proxyUrl);
  assert.equal(environment.https_proxy, binding.proxyUrl);
  assert.equal(environment.NO_PROXY, 'localhost,127.0.0.1,::1,[::1]');
  assert.throws(() => parseWslProxyBinding('http://127.0.0.1:7890/'), {code:'CODEX_WSL_PROXY_BINDING_UNVERIFIED'});
  assert.throws(() => parseWslProxyBinding('http://172.27.48.1:7890/?x=1'), {code:'CODEX_WSL_PROXY_BINDING_UNVERIFIED'});
});

test('WSL environment builders revalidate every endpoint and size-case alias', () => {
  assert.throws(() => wslProxyEnvironment({
    gateway:'127.0.0.1',port:7890,proxyUrl:'http://127.0.0.1:7890/'
  }), {code:'CODEX_WSL_PROXY_BINDING_UNVERIFIED'});
  assert.throws(() => wslProxyEnvironment({
    gateway:'172.27.48.1',port:0,proxyUrl:'http://172.27.48.1:0/'
  }), {code:'CODEX_WSL_PROXY_BINDING_UNVERIFIED'});
  assert.deepEqual(wslProxyFromEnvironment({
    HTTP_PROXY:'http://172.27.48.1:7890/',
    http_proxy:'http://172.27.48.1:7890/',
    HTTPS_PROXY:'http://172.27.48.1:7890/',
    https_proxy:'http://172.27.48.1:7890/',
    ALL_PROXY:'http://172.27.48.1:7890/',
    all_proxy:'http://172.27.48.1:7890/'
  }), {gateway:'172.27.48.1',port:7890,proxyUrl:'http://172.27.48.1:7890/'});
  assert.throws(() => wslProxyFromEnvironment({
    HTTP_PROXY:'http://172.27.48.1:7890/',
    http_proxy:'http://172.27.48.1:7891/',
    HTTPS_PROXY:'http://172.27.48.1:7890/',
    https_proxy:'http://172.27.48.1:7890/',
    ALL_PROXY:'http://172.27.48.1:7890/',
    all_proxy:'http://172.27.48.1:7890/'
  }), {code:'CODEX_PROXY_ENVIRONMENT_MISMATCH'});
});

test('WSL launch passes the discovered gateway proxy into /usr/bin/env, not Windows loopback', () => {
  const config = parseConfig(structuredClone(defaults));
  config.codex = {
    ...config.codex,
    transport:'wsl', wslDistro:'DreamMaker-Acceptance-F-20261101-R2',
    wslCommand:'wsl.exe', wslCwdRoot:'/opt/dream-maker-controller/codex-work',
    wslBinary:'/opt/dream-maker-controller/codex/bin/codex', wslHome:'/opt/dream-maker-controller/codex-home',
    args:['app-server']
  };
  config.clash.enabled = true;
  const launch = codexLaunch(config, 'C:\\workspace', {wslProxy:parseWslProxyBinding('http://172.27.48.1:7890/')});
  assert.ok(launch.args.includes('HTTP_PROXY=http://172.27.48.1:7890/'));
  assert.ok(launch.args.includes('NO_PROXY=localhost,127.0.0.1,::1,[::1]'));
  assert.equal(launch.args.includes('HTTP_PROXY=http://127.0.0.1:7890/'), false);
});

test('WSL helper observation is not promoted when it is not a bounded TCP success', () => {
  const valid = {
    schema:'dream-maker.wsl-proxy-reachability.v1', state:'TCP_REACHABLE_ONLY',
    gateway:'172.27.48.1', port:7890, elapsedMs:12, routeSource:'WSL_DEFAULT_ROUTE',
    networkPayloadBytes:0, httpRequests:0, tlsHandshakes:0, modelCalls:0, filesWritten:0
  };
  assert.equal(wslProxyBindingFromObservation(valid,7890).proxyUrl, 'http://172.27.48.1:7890/');
  for (const mutate of [
    value => { value.gateway = '127.0.0.1'; },
    value => { value.httpRequests = 1; },
    value => { value.state = 'UNREACHABLE'; },
    value => { value.port = 7891; }
  ]) {
    const changed = structuredClone(valid); mutate(changed);
    assert.throws(() => wslProxyBindingFromObservation(changed,7890), {code:'CODEX_WSL_PROXY_BINDING_UNVERIFIED'});
  }
});
