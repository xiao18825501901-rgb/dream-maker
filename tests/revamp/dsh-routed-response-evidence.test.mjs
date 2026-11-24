// OFFLINE composition proof: actual local gateway HTTP, synthetic upstream only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { NativeBudget } from '../../dist/server/native-budget.js';
import { DeepSeekGateway } from '../../dist/server/deepseek-gateway.js';
import { observeRoutedResponse } from '../../dist/server/routed-response-observer.js';
import { harness } from '../helpers.mjs';

test('the DSH gateway completes through the same routed response observer', async t => {
  const h = harness(t);
  const budget = new NativeBudget(resolve(h.dir, 'dsh-route-budget.sqlite'), {
    scopeId: 'OFFLINE', authorizationHash: 'OFFLINE', totalMicros: 50000000,
    probeMicros: 5000000, warningMicros: 40000000, maxInFlight: 1, maxRepairs: 2
  });
  const observations = [];
  let upstreamCalls = 0;
  const price = () => ({
    provider: 'deepseek-official', model: 'deepseek-flash', currency: 'CNY',
    source: 'OFFLINE', expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxInputTokens: 1048576, inputMissMicrosPerMillion: 2000000,
    inputHitMicrosPerMillion: 40000, outputMicrosPerMillion: 8000000
  });
  const transport = async () => {
    upstreamCalls += 1;
    return observeRoutedResponse({
      response: new Response(JSON.stringify({
        id: 'offline-response',
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { content: 'OFFLINE_RESPONSE' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_dsh_private' }
      }),
      target: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      selectionPolicy: 'current',
      selectedNode: 'fixture-node',
      expectedNode: 'fixture-node',
      role: 'executor',
      startedAt: '2026-11-08T12:00:00.000Z',
      started: performance.now(),
      record: observation => observations.push(observation)
    });
  };
  const gateway = new DeepSeekGateway(
    budget, price, 'OFFLINE_KEY', 128, 1, transport, 'chat-completions'
  );
  try {
    const route = await gateway.start();
    const response = await fetch(route.url + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + route.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'OFFLINE_ONLY' }],
        max_tokens: 128,
        stream: false
      })
    });
    const responseBody = await response.text();
    assert.equal(response.status, 200, responseBody);
    assert.equal(upstreamCalls, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].classification, 'INFERENCE_COMPLETED');
    assert.equal(observations[0].targetHost, 'api.deepseek.com');
    assert.equal(observations[0].role, 'executor');
    assert.equal(observations[0].selectedNode, 'fixture-node');
    assert.equal(gateway.receipts()[0].outcome, 'COMPLETE');
    assert.equal(budget.requests()[0].usageStatus, 'KNOWN');
    assert.doesNotMatch(JSON.stringify(observations), /req_dsh_private|OFFLINE_KEY/);
  } finally {
    await gateway.close();
    budget.close();
  }
});
