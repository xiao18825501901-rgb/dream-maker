// OFFLINE product-wiring proof: no CFW mutation, upstream request, OAuth or model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaults } from '../../dist/server/config.js';
import { ClashService } from '../../dist/server/clash-service.js';

async function controllerFixture() {
  let selected = 'user-node';
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
          selector: {
            name: 'selector',
            type: 'Selector',
            now: selected,
            all: ['user-node', 'other-node']
          },
          'user-node': { name: 'user-node', type: 'Shadowsocks' },
          'other-node': { name: 'other-node', type: 'Trojan' }
        }
      }));
      return;
    }
    if (request.url === '/proxies/selector' && request.method === 'GET') {
      response.end(JSON.stringify({
        name: 'selector',
        type: 'Selector',
        now: selected,
        all: ['user-node', 'other-node']
      }));
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
    get selected() {
      return selected;
    },
    get mutations() {
      return mutations;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

test('ClashService.fetch observes the actual routed node and response lifecycle', async () => {
  const controller = await controllerFixture();
  const tempRoot = 'F:/DreamMakerSuite/temp';
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(resolve(tempRoot, 'dm-clash-product-fetch-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${controller.endpointPort}`,
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

  const observations = [];
  const transportInputs = [];
  let transportCalls = 0;
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    observation => observations.push(observation),
    undefined,
    async (input, url, init) => {
      transportCalls += 1;
      transportInputs.push({
        url: String(url),
        method: String(init.method ?? 'GET'),
        expectedNode: input.expectedNode,
        proxyUrl: input.proxyUrl
      });
      input.onRoute?.({ selectedNode: 'user-node', chains: ['user-node', 'provider-node'] });
      return String(url).endsWith('/v1/responses')
        ? new Response(JSON.stringify({
            id: 'resp_fixture',
            object: 'response',
            status: 'completed',
            output: []
          }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'req_private_product_fetch'
            }
          })
        : new Response('{"data":[]}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
    }
  );

  try {
    const bodies = await service.withRun(
      'run_product_fetch',
      AbortSignal.timeout(5000),
      async () => {
        const inference = await service.fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            authorization: 'SYNTHETIC_AUTH_HEADER_NOT_A_SECRET',
            'content-type': 'application/json'
          },
          body: '{}'
        });
        const inferenceBody = await inference.text();
        const models = await service.fetch('https://api.openai.com/v1/models', {
          method: 'GET'
        });
        const modelsBody = await models.text();
        return { inferenceBody, modelsBody };
      }
    );

    assert.deepEqual(bodies, {
      inferenceBody: JSON.stringify({
        id: 'resp_fixture',
        object: 'response',
        status: 'completed',
        output: []
      }),
      modelsBody: '{"data":[]}'
    });
    assert.equal(transportCalls, 2);
    assert.deepEqual(transportInputs, [
      {
        url: 'https://api.openai.com/v1/responses',
        method: 'POST',
        expectedNode: 'user-node',
        proxyUrl: 'http://127.0.0.1:7890/'
      },
      {
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        expectedNode: 'user-node',
        proxyUrl: 'http://127.0.0.1:7890/'
      }
    ]);
    assert.equal(observations.length, 2);
    assert.equal(observations[0].classification, 'INFERENCE_COMPLETED');
    assert.equal(observations[0].selectedNode, 'user-node');
    assert.equal(observations[0].expectedNode, 'user-node');
    assert.equal(observations[0].automaticRetryAllowed, false);
    assert.equal(observations[0].requestIdSha256,
      createHash('sha256').update('req_private_product_fetch').digest('hex'));
    assert.equal(observations[1].classification, 'HTTP_SUCCESS_NON_INFERENCE');
    assert.equal(observations[1].targetHost, 'api.openai.com');
    assert.equal(observations[0].role, undefined);
    assert.equal(observations[1].role, undefined);
    assert.doesNotMatch(
      JSON.stringify(observations),
      /req_private_product_fetch|SYNTHETIC_AUTH_HEADER_NOT_A_SECRET|fixture\".*output/
    );
    assert.equal(controller.selected, 'user-node');
    assert.equal(controller.mutations, 0);
  } finally {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('role-bound streaming fetch records only the explicitly selected role', async () => {
  const controller = await controllerFixture();
  const tempRoot = 'F:/DreamMakerSuite/temp';
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(resolve(tempRoot, 'dm-clash-role-stream-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${controller.endpointPort}`,
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
  const observations = [];
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    observation => observations.push(observation),
    undefined,
    async (input, url) => {
      input.onRoute?.({ selectedNode: 'user-node', chains: ['user-node', 'provider-node'] });
      return new Response(JSON.stringify(String(url).endsWith('/v1/responses')
        ? { id: 'resp_fixture', object: 'response', status: 'completed', output: [] }
        : {
            id: 'chatcmpl_fixture',
            choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }]
          }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  );

  try {
    await service.withRun('run_role_stream', AbortSignal.timeout(5000), async () => {
      const executorFetch = service.fetchForRole('executor');
      const reviewerFetch = service.fetchForRole('reviewer');
      await (await executorFetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}' })).text();
      await (await reviewerFetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' })).text();
      assert.throws(() => service.fetchForRole('unknown'), { code: 'NETWORK_REQUEST_ROLE_INVALID' });
    });
    assert.deepEqual(observations.map(item => item.role), ['executor', 'reviewer']);
    assert.deepEqual(observations.map(item => item.targetHost), ['api.deepseek.com', 'api.openai.com']);
    assert.equal(observations[0].classification, 'INFERENCE_COMPLETED');
    assert.equal(observations[1].classification, 'INFERENCE_COMPLETED');
    assert.equal(controller.mutations, 0);
  } finally {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('current-selection request without a run lease keeps the observed node as its expected path', async () => {
  const controller = await controllerFixture();
  const tempRoot = 'F:/DreamMakerSuite/temp';
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(resolve(tempRoot, 'dm-clash-transient-current-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${controller.endpointPort}`,
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
  const observations = [];
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    observation => observations.push(observation),
    undefined,
    async (input, _url) => {
      input.onRoute?.({selectedNode:'user-node',chains:['user-node','provider-node']});
      return new Response(JSON.stringify({
        id:'resp_fixture',
        object:'response',
        status:'completed',
        output:[]
      }), {
        status: 200,
        headers: {'content-type':'application/json'}
      });
    }
  );

  try {
    const value = await service.jsonRequestForRole('planner1')(
      'https://api.openai.com/v1/responses',
      {method:'POST',body:'{}'}
    );
    assert.deepEqual(value, {
      id:'resp_fixture',
      object:'response',
      status:'completed',
      output:[]
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].role, 'planner1');
    assert.equal(observations[0].selectionPolicy, 'current');
    assert.equal(observations[0].selectedNode, 'user-node');
    assert.equal(observations[0].expectedNode, 'user-node');
    assert.equal(controller.mutations, 0);
  } finally {
    await controller.close();
    rmSync(dir, {recursive:true,force:true});
  }
});

test('role-bound JSON transport records planner1 separately and classifies a 403 policy refusal once', async () => {
  const controller = await controllerFixture();
  const tempRoot = 'F:/DreamMakerSuite/temp';
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(resolve(tempRoot, 'dm-clash-role-json-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${controller.endpointPort}`,
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

  const observations = [];
  let transportCalls = 0;
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    observation => observations.push(observation),
    undefined,
    async (input, _url, _init) => {
      transportCalls += 1;
      input.onRoute?.({ selectedNode: 'user-node', chains: ['user-node', 'provider-node'] });
      return new Response(JSON.stringify({
        error: { code: 'unsupported_country_region_territory', message: 'PRIVATE_UPSTREAM_BODY' }
      }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_private_role_policy'
        }
      });
    }
  );

  try {
    await assert.rejects(
      service.withRun(
        'run_role_json',
        AbortSignal.timeout(5000),
        () => service.jsonRequestForRole('planner1')('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: '{}'
        })
      ),
      error => error.networkFailure?.classification === 'REGION_OR_POLICY_RESTRICTED' &&
        error.networkFailure?.retry === 'NO_AUTOMATIC_RETRY'
    );
    assert.equal(transportCalls, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].role, 'planner1');
    assert.equal(observations[0].classification, 'REGION_OR_POLICY_RESTRICTED');
    assert.equal(observations[0].automaticRetryAllowed, false);
    assert.doesNotMatch(JSON.stringify(observations), /PRIVATE_UPSTREAM_BODY|req_private_role_policy/);
  } finally {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DM-managed loopback Magpie requests bypass CFW transport and never acquire a proxy invocation', async () => {
  const controller = await controllerFixture();
  const tempRoot = 'F:/DreamMakerSuite/temp';
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(resolve(tempRoot, 'dm-clash-loopback-direct-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${controller.endpointPort}`,
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

  let localRequests = 0;
  const local = createServer((request, response) => {
    localRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ path: request.url, route: 'DIRECT_LOOPBACK' }));
  });
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  const address = local.address();
  assert.ok(address && typeof address === 'object');

  let proxyInvocations = 0;
  const observations = [];
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    observation => observations.push(observation),
    undefined,
    async () => {
      proxyInvocations += 1;
      throw new Error('LOOPBACK_REQUEST_MUST_NOT_USE_CFW');
    }
  );

  try {
    const value = await service.withRun(
      'run_loopback_magpie',
      AbortSignal.timeout(5000),
      async () => {
        const response = await service.fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"synthetic":"OFFLINE_LOCAL_MAGPIE_REQUEST"}'
        });
        return response.json();
      }
    );
    assert.deepEqual(value, { path: '/v1/messages', route: 'DIRECT_LOOPBACK' });
    assert.equal(localRequests, 1);
    assert.equal(proxyInvocations, 0);
    assert.equal(observations.length, 0);
    assert.equal(controller.mutations, 0);
  } finally {
    local.closeAllConnections();
    await new Promise(resolve => local.close(resolve));
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('research fetch uses its own CFW transport and records planner1 source retrieval', async () => {
  const controller = await controllerFixture();
  const tempRoot = 'F:/DreamMakerSuite/temp';
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(resolve(tempRoot, 'dm-clash-research-fetch-'));
  const clashPath = resolve(dir, 'config.yaml');
  writeFileSync(clashPath, [
    'mixed-port: 7890',
    `external-controller: 127.0.0.1:${controller.endpointPort}`,
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

  const observations = [];
  let modelTransportCalls = 0;
  const researchInputs = [];
  const service = new ClashService(
    () => config,
    resolve(dir, 'state'),
    observation => observations.push(observation),
    undefined,
    async () => {
      modelTransportCalls += 1;
      throw new Error('RESEARCH_REQUEST_MUST_NOT_USE_MODEL_TRANSPORT');
    },
    async (input, url, init) => {
      researchInputs.push({
        url: String(url),
        method: String(init.method ?? 'GET'),
        expectedNode: input.expectedNode,
        proxyUrl: input.proxyUrl
      });
      input.onRoute?.({
        selectedNode: 'user-node',
        chains: ['user-node', 'provider-node']
      });
      return new Response(JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{ full_name: 'fixture/research-result' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  );

  try {
    const body = await service.withRun(
      'run_research_fetch',
      AbortSignal.timeout(5000),
      async () => {
        const response = await service.researchFetch(
          'https://api.github.com/search/repositories?q=fixture&per_page=1',
          {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'x-github-api-version': '2022-11-28'
            }
          }
        );
        return response.json();
      }
    );

    assert.equal(body.total_count, 1);
    assert.equal(modelTransportCalls, 0);
    assert.deepEqual(researchInputs, [{
      url: 'https://api.github.com/search/repositories?q=fixture&per_page=1',
      method: 'GET',
      expectedNode: 'user-node',
      proxyUrl: 'http://127.0.0.1:7890/'
    }]);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].role, 'planner1');
    assert.equal(observations[0].targetHost, 'api.github.com');
    assert.equal(observations[0].selectedNode, 'user-node');
    assert.equal(observations[0].expectedNode, 'user-node');
    assert.equal(observations[0].classification, 'HTTP_SUCCESS_NON_INFERENCE');
    assert.equal(controller.mutations, 0);
    assert.doesNotMatch(
      JSON.stringify(observations),
      /fixture\/research-result/
    );
  } finally {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
