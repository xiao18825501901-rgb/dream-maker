// OFFLINE controller contract: no CFW mutation, upstream request, OAuth or model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defaults, parseConfig, Settings } from '../../dist/server/config.js';
import { ClashService } from '../../dist/server/clash-service.js';

function health(selectedNode) {
  return {
    schema: 'dream-maker.local-proxy-health.v1',
    scope: 'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',
    startedAt: '2026-11-08T12:00:00.000Z',
    completedAt: '2026-11-08T12:00:00.010Z',
    state: 'SHORT_WINDOW_OK',
    address: '127.0.0.1:7890',
    controller: 'READABLE',
    samples: [{ at: '2026-11-08T12:00:00.000Z', state: 'CONNECTED', elapsedMs: 1 }],
    websocket: 'NOT_TESTED',
    modelCalls: 0,
    oauthAttempts: 0,
    networkSettingsChanged: false,
    openAiTls: {
      state: 'TLS_HANDSHAKE_COMPLETED',
      target: 'api.openai.com:443',
      protocol: 'TLSv1.3',
      authorized: true,
      alpn: 'http/1.1',
      elapsedMs: 5,
      selectedNode,
      selectionMatchesExpected: true,
      nodeChainMatched: true,
      errorClass: null,
      httpRequestSent: false,
      modelCalls: 0
    }
  };
}

async function controllerFixture() {
  let selected = 'user-node-a';
  let mutations = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/configs') {
      response.end(JSON.stringify({ mode: 'rule', 'mixed-port': 7890 }));
      return;
    }
    if (request.url === '/proxies') {
      response.end(JSON.stringify({
        proxies: {
          selector: { name: 'selector', type: 'Selector', now: selected, all: ['user-node-a', 'user-node-b'] },
          'user-node-a': { name: 'user-node-a', type: 'Shadowsocks' },
          'user-node-b': { name: 'user-node-b', type: 'Trojan' }
        }
      }));
      return;
    }
    if (request.url === '/proxies/selector' && request.method === 'GET') {
      response.end(JSON.stringify({ name: 'selector', type: 'Selector', now: selected, all: ['user-node-a', 'user-node-b'] }));
      return;
    }
    if (request.url === '/proxies/selector' && request.method === 'PUT') {
      mutations += 1;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'mutation forbidden in fixture' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    endpointPort: address.port,
    setSelected(value) { selected = value; },
    get selected() { return selected; },
    get mutations() { return mutations; },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

test('current-user Clash route follows the live selection without changing it', async () => {
  const fixture = await controllerFixture();
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-current-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${fixture.endpointPort}`,
    'secret: fixture-secret'
  ].join('\n'));
  const config = structuredClone(defaults);
  config.clash = {
    enabled: true,
    configPath: clashPath,
    selector: 'selector',
    node: '',
    selectionPolicy: 'current',
    expectedMode: 'rule'
  };
  const service = new ClashService(() => config, resolve(dir, 'state'));
  try {
    const result = await service.withRun('run_current', AbortSignal.timeout(5000), async () => {
      const environment = service.childEnvironment();
      assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:7890/');
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(fixture.selected, 'user-node-a');
    assert.equal(fixture.mutations, 0);
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('current-user Clash route fails closed if the user selection changes during the action', async () => {
  const fixture = await controllerFixture();
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-current-change-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${fixture.endpointPort}`,
    'secret: fixture-secret'
  ].join('\n'));
  const config = structuredClone(defaults);
  config.clash = {
    enabled: true,
    configPath: clashPath,
    selector: 'selector',
    node: '',
    selectionPolicy: 'current',
    expectedMode: 'rule'
  };
  const service = new ClashService(() => config, resolve(dir, 'state'));
  try {
    await assert.rejects(
      service.withRun('run_current_change', AbortSignal.timeout(5000), async () => {
        fixture.setSelected('user-node-b');
      }),
      { code: 'CLASH_SELECTION_CHANGED_DURING_RUN' }
    );
    assert.equal(fixture.selected, 'user-node-b');
    assert.equal(fixture.mutations, 0);
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local stability check uses a read-only current-selection lease and no controller mutation', async () => {
  const fixture = await controllerFixture();
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-current-health-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${fixture.endpointPort}`,
    'secret: fixture-secret'
  ].join('\n'));
  const config = structuredClone(defaults);
  config.clash = {
    enabled: true,
    configPath: clashPath,
    selector: 'selector',
    node: '',
    selectionPolicy: 'current',
    expectedMode: 'rule'
  };
  let expected = null;
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    undefined,
    async input => {
      expected = input.expectedNode;
      return health(input.expectedNode);
    }
  );
  try {
    const result = await service.observeLocalStability(AbortSignal.timeout(5000));
    assert.equal(expected, 'user-node-a');
    assert.equal(result.openAiTls.selectedNode, 'user-node-a');
    assert.match(result.endpointFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(fixture.selected, 'user-node-a');
    assert.equal(fixture.mutations, 0);
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local stability check fails closed if the user changes selection during the probe', async () => {
  const fixture = await controllerFixture();
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-current-health-change-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${fixture.endpointPort}`,
    'secret: fixture-secret'
  ].join('\n'));
  const config = structuredClone(defaults);
  config.clash = {
    enabled: true,
    configPath: clashPath,
    selector: 'selector',
    node: '',
    selectionPolicy: 'current',
    expectedMode: 'rule'
  };
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    undefined,
    async input => {
      fixture.setSelected('user-node-b');
      return health(input.expectedNode);
    }
  );
  try {
    await assert.rejects(
      service.observeLocalStability(AbortSignal.timeout(5000)),
      { code: 'CLASH_SELECTION_CHANGED_DURING_RUN' }
    );
    assert.equal(fixture.selected, 'user-node-b');
    assert.equal(fixture.mutations, 0);
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configuration exposes an explicit current-selection policy without a trusted path', () => {
  const legacy = structuredClone(defaults);
  delete legacy.clash.selectionPolicy;
  assert.equal(parseConfig(legacy).clash.selectionPolicy, 'pinned');

  const current = structuredClone(defaults);
  current.clash = { ...current.clash, selectionPolicy: 'current' };
  assert.equal(parseConfig(current).clash.selectionPolicy, 'current');

  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-policy-setting-'));
  try {
    const path = resolve(dir, 'config.json');
    const settings = new Settings(path);
    settings.updateUI({
      clash: {
        enabled: true,
        selector: 'selector',
        node: '',
        selectionPolicy: 'current',
        expectedMode: 'rule',
        configPath: 'C:/must-not-be-accepted/config.yaml'
      }
    });
    assert.equal(settings.value.clash.selectionPolicy, 'current');
    assert.notEqual(settings.value.clash.configPath, 'C:/must-not-be-accepted/config.yaml');
    assert.equal(settings.public().config.clash.selectionPolicy, 'current');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON Provider body interruption records one failure without resending or claiming inference', async () => {
  const fixture = await controllerFixture();
  const dir = mkdtempSync(resolve(tmpdir(), 'dm-clash-json-interruption-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, `mixed-port: 7890\nexternal-controller: 127.0.0.1:${fixture.endpointPort}\nsecret: fixture-secret\n`);
  const config = structuredClone(defaults);
  config.clash = {...config.clash, enabled:true, configPath:clashPath, selector:'selector', selectionPolicy:'current'};
  const records = [];
  let requests = 0;
  const service = new ClashService(() => config, resolve(dir, 'state'), record => records.push(record), undefined, async input => {
    requests++;
    input.onRoute({selectedNode:'user-node-a', chains:['user-node-a','selector']});
    let pulls = 0;
    return new Response(new ReadableStream({pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('{"partial":'));
      else controller.error(Object.assign(new Error('PRIVATE_BODY_CANARY'), {code:'ECONNRESET'}));
    }}), {headers:{'content-type':'application/json','x-request-id':'req-private-canary'}});
  });
  try {
    await assert.rejects(service.withRun('run_json_interruption', AbortSignal.timeout(5000), () =>
      service.jsonRequest('https://api.openai.com/v1/responses', {method:'POST',body:'{}'})));
    assert.equal(requests, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].classification, 'STREAM_INTERRUPTED');
    assert.equal(records[0].selectedNode, 'user-node-a');
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_BODY_CANARY|req-private-canary/);
    assert.equal(fixture.mutations, 0);
  } finally {
    await fixture.close();
    rmSync(dir, {recursive:true,force:true});
  }
});
