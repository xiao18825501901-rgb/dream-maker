// OFFLINE response-stream contract: no CFW mutation, OAuth or model request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { observeRoutedResponse } from '../../dist/server/routed-response-observer.js';

function input(response, overrides = {}) {
  const observations = [];
  return {
    observations,
    value: {
      response,
      target: 'https://api.openai.com/v1/responses',
      method: 'POST',
      selectionPolicy: 'current',
      selectedNode: 'fixture-node',
      expectedNode: 'fixture-node',
      role: 'executor',
      startedAt: '2026-11-08T12:00:00.000Z',
      started: performance.now() - 25,
      record: observation => observations.push(observation),
      ...overrides
    }
  };
}

test('a complete stream records inference completion with the routed node', async () => {
  const fixture = input(new Response(JSON.stringify({
    id: 'resp_fixture',
    object: 'response',
    status: 'completed',
    output: []
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-success-private' }
  }));
  const observed = observeRoutedResponse(fixture.value);
  assert.equal((await observed.json()).status, 'completed');
  assert.equal(fixture.observations.length, 1);
  assert.equal(fixture.observations[0].classification, 'INFERENCE_COMPLETED');
  assert.equal(fixture.observations[0].role, 'executor');
  assert.equal(fixture.observations[0].selectedNode, 'fixture-node');
  assert.equal(fixture.observations[0].expectedNode, 'fixture-node');
  assert.equal(fixture.observations[0].automaticRetryAllowed, false);
});

test('HTTP 200 with an incomplete inference envelope is not model success', async () => {
  const fixture = input(new Response(JSON.stringify({
    id: 'resp_fixture',
    object: 'response',
    status: 'incomplete',
    output: []
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  const observed = observeRoutedResponse(fixture.value);
  assert.equal((await observed.json()).status, 'incomplete');
  assert.equal(fixture.observations.length, 1);
  assert.equal(fixture.observations[0].classification, 'HTTP_SUCCESS_NON_INFERENCE');
  assert.equal(fixture.observations[0].automaticRetryAllowed, false);
});

test('SSE completion requires the provider terminal event, not just HTTP 200', async () => {
  const completed = input(new Response(
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }
  ));
  const completedResponse = observeRoutedResponse(completed.value);
  await completedResponse.text();
  assert.equal(completed.observations[0].classification, 'INFERENCE_COMPLETED');

  const cutOff = input(new Response(
    'event: response.output_text.delta\n' +
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }
  ));
  const cutOffResponse = observeRoutedResponse(cutOff.value);
  await cutOffResponse.text();
  assert.equal(cutOff.observations[0].classification, 'HTTP_SUCCESS_NON_INFERENCE');
});

test('a successful model-list request is not mislabeled as inference completion', async () => {
  const fixture = input(new Response('{"data":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }), {
    target: 'https://api.openai.com/v1/models',
    method: 'GET'
  });
  const observed = observeRoutedResponse(fixture.value);
  assert.equal(await observed.text(), '{"data":[]}');
  assert.equal(fixture.observations.length, 1);
  assert.equal(fixture.observations[0].classification, 'HTTP_SUCCESS_NON_INFERENCE');
  assert.equal(fixture.observations[0].automaticRetryAllowed, false);
});

test('an exact region-policy body is classified without persisting the body or raw request id', async () => {
  const requestId = 'req_region_private_0123456789';
  const body = '{"error":{"code":"unsupported_country_region_territory","message":"PRIVATE_BODY_CANARY"}}';
  const fixture = input(new Response(body, {
    status: 403,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId }
  }), {
    target: 'https://api.openai.com/v1/responses',
    method: 'POST'
  });
  const response = observeRoutedResponse(fixture.value);
  assert.equal(await response.text(), body);
  assert.equal(fixture.observations.length, 1);
  const observation = fixture.observations[0];
  assert.equal(observation.classification, 'REGION_OR_POLICY_RESTRICTED');
  assert.equal(observation.httpStatus, 403);
  assert.equal(observation.automaticRetryAllowed, false);
  assert.equal(observation.requestIdSha256,
    createHash('sha256').update(requestId).digest('hex'));
  const serialized = JSON.stringify(observation);
  assert.doesNotMatch(serialized, new RegExp(requestId));
  assert.doesNotMatch(serialized, /PRIVATE_BODY_CANARY/);
  assert.doesNotMatch(serialized, /authorization|api[-_]?key|cookie/i);
});

test('a stream that fails after yielding is recorded as interrupted exactly once', async () => {
  let pulls = 0;
  const fixture = input(new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1)
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      else
        controller.error(Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' }));
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  }));
  const response = observeRoutedResponse(fixture.value);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  await assert.rejects(reader.read());
  assert.equal(fixture.observations.length, 1);
  assert.equal(fixture.observations[0].classification, 'STREAM_INTERRUPTED');
  assert.equal(fixture.observations[0].automaticRetryAllowed, true);
});
