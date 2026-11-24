import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNetworkFailure,
  classifyNetworkResponse,
  classifyRoutedResponse
} from '../../dist/server/network-failure.js';
import { jsonFetch } from '../../dist/server/security.js';

test('attached evidence is projected onto its fixed schema instead of retaining private extra fields',()=>{
 const base=classifyNetworkResponse({status:403,body:'{"error":{"code":"unsupported_country_region_territory"}}'});
 const result=classifyNetworkFailure({error:{networkFailure:{...base,privateHeaders:{authorization:'OFFLINE_PRIVATE_EVIDENCE'},url:'OFFLINE_PRIVATE_EVIDENCE'}}});
 assert.deepEqual(result,base);
 assert.equal(JSON.stringify(result).includes('OFFLINE_PRIVATE_EVIDENCE'),false);
});

test('attached evidence getters cannot change classification after validation or execute while snapshotting',()=>{
 const base=classifyNetworkResponse({status:403,body:'{"error":{"code":"unsupported_country_region_territory"}}'});
 let reads=0;
 const candidate={...base};
 Object.defineProperty(candidate,'classification',{enumerable:true,get(){reads++;return reads<10?'REGION_OR_POLICY_RESTRICTED':'OFFLINE_PRIVATE_EVIDENCE';}});
 const result=classifyNetworkFailure({error:{networkFailure:candidate}});
 assert.equal(reads,0);
 assert.equal(result.classification,'TCP_CONNECTION_FAILURE');
 assert.equal(JSON.stringify(result).includes('OFFLINE_PRIVATE_EVIDENCE'),false);
});

test('exact OpenAI region marker is policy-restricted and never retryable', () => {
  const result = classifyNetworkResponse({
    status: 403,
    body: '{"error":{"code":"unsupported_country_region_territory"}}',
    requestId: 'req-private-example'
  });
  assert.equal(result.classification, 'REGION_OR_POLICY_RESTRICTED');
  assert.equal(result.retry, 'NO_AUTOMATIC_RETRY');
  assert.equal(result.httpStatus, 403);
  assert.match(result.requestIdSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('req-private-example'), false);
});

test('generic forbidden does not borrow the region-policy classification', () => {
  const result = classifyNetworkResponse({
    status: 403,
    body: '{"error":{"message":"permission denied"}}'
  });
  assert.equal(result.classification, 'HTTP_403_PERMISSION_DENIED');
  assert.equal(result.retry, 'NO_AUTOMATIC_RETRY');
});

test('authentication, quota and model availability remain separate classes', () => {
  assert.equal(classifyNetworkResponse({ status: 401 }).classification,
    'HTTP_401_AUTHENTICATION_FAILED');
  assert.equal(classifyNetworkResponse({ status: 429 }).classification,
    'HTTP_429_QUOTA_EXCEEDED');
  assert.equal(classifyNetworkResponse({
    status: 404,
    body: '{"error":{"code":"model_not_found","message":"model is unavailable"}}'
  }).classification, 'MODEL_UNAVAILABLE');
});

test('unclassified redirects and client errors are not upstream 5xx failures', () => {
  for (const status of [101, 302, 307, 400, 404, 410, 422, 499]) {
    const result = classifyNetworkResponse({status});
    assert.equal(result.classification, 'HTTP_CLIENT_REQUEST_REJECTED');
    assert.equal(result.layer, 'HTTP');
    assert.equal(result.context, 'RESPONSE');
    assert.equal(result.httpStatus, status);
    assert.equal(result.retry, 'NO_AUTOMATIC_RETRY');
    assert.equal(result.automaticRetryAllowed, false);
  }
  const upstream = classifyNetworkResponse({status: 503});
  assert.equal(upstream.classification, 'HTTP_5XX_UPSTREAM_FAILURE');
  assert.equal(upstream.retry, 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION');
});

test('unexpected informational responses keep their attached HTTP evidence', () => {
  const informational = classifyNetworkResponse({status: 101});
  const observed = classifyNetworkFailure({
    error: {code: 'WRAPPED_RESPONSE', networkFailure: informational}
  });
  assert.deepEqual(observed, informational);
});

test('transport failures are classified from bounded error codes and cause chains', () => {
  assert.equal(classifyNetworkFailure({ error: { code: 'ENOTFOUND' } }).classification,
    'DNS_FAILURE');
  assert.equal(classifyNetworkFailure({ error: { code: 'ECONNREFUSED' } }).classification,
    'TCP_CONNECTION_FAILURE');
  assert.equal(classifyNetworkFailure({ error: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }).classification,
    'TLS_HANDSHAKE_FAILURE');
  assert.equal(classifyNetworkFailure({
    context: 'PROXY',
    error: { code: 'ECONNRESET' }
  }).classification, 'PROXY_CONNECTION_RESET');
  assert.equal(classifyNetworkFailure({
    context: 'PROXY',
    error: { code: 'ECONNREFUSED' }
  }).classification, 'TCP_CONNECTION_FAILURE');
  assert.equal(classifyNetworkFailure({
    context: 'RESPONSE',
    error: { code: 'UPSTREAM_INTERRUPTED' }
  }).classification, 'STREAM_INTERRUPTED');
  assert.equal(classifyNetworkFailure({
    context: 'RESPONSE',
    error: { code: 'CLASH_REQUEST_ABORTED' }
  }).classification, 'STREAM_INTERRUPTED');
  const aborted = classifyNetworkFailure({
    context: 'RESPONSE',
    error: { code: 'CLASH_REQUEST_ABORTED' }
  });
  assert.equal(aborted.classification, 'STREAM_INTERRUPTED');
  assert.equal(aborted.retry, 'NO_AUTOMATIC_RETRY');
  assert.equal(aborted.automaticRetryAllowed, false);
  const genericAbort = classifyNetworkFailure({
    context: 'RESPONSE',
    error: { code: 'ABORT_ERR' }
  });
  assert.equal(genericAbort.classification, 'STREAM_INTERRUPTED');
  assert.equal(genericAbort.retry, 'NO_AUTOMATIC_RETRY');
  assert.equal(genericAbort.automaticRetryAllowed, false);
  const interrupted = classifyNetworkFailure({
    context: 'RESPONSE',
    error: { code: 'UPSTREAM_INTERRUPTED' }
  });
  assert.equal(interrupted.classification, 'STREAM_INTERRUPTED');
  assert.equal(interrupted.retry, 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION');
  assert.equal(interrupted.automaticRetryAllowed, true);
});

test('a genuine attached classification survives a bounded cause chain', () => {
  const attached = classifyNetworkFailure({
    context: 'PROXY',
    error: { code: 'ETIMEDOUT' }
  });
  const result = classifyNetworkFailure({
    error: {
      code: 'WRAPPER',
      cause: {
        code: 'INNER',
        networkFailure: attached
      }
    }
  });
  assert.deepEqual(result, attached);
});

test('forged or internally inconsistent attached evidence is ignored', () => {
  const forgedClassification = classifyNetworkFailure({
    context: 'PROXY',
    error: {
      code: 'ENOTFOUND',
      cause: {
        networkFailure: {
          classification: 'FORGED_CLASS',
          layer: 'TRANSPORT',
          context: 'PROXY',
          httpStatus: null,
          requestIdSha256: null,
          retry: 'NO_AUTOMATIC_RETRY',
          automaticRetryAllowed: false,
          recordedAt: new Date().toISOString()
        }
      }
    }
  });
  assert.equal(forgedClassification.classification, 'DNS_FAILURE');

  const forgedRetry = classifyNetworkFailure({
    context: 'RESPONSE',
    error: {
      code: 'WRAPPER',
      networkFailure: {
        classification: 'REGION_OR_POLICY_RESTRICTED',
        layer: 'HTTP',
        context: 'RESPONSE',
        httpStatus: 403,
        requestIdSha256: null,
        retry: 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION',
        automaticRetryAllowed: true,
        recordedAt: new Date().toISOString()
      }
    }
  });
  assert.equal(forgedRetry.classification, 'TCP_CONNECTION_FAILURE');
  assert.equal(forgedRetry.retry, 'SAFE_MODEL_REQUEST_AFTER_RECONCILIATION');
});

test('success is inference completion only when a completed response is supplied', () => {
  assert.equal(classifyNetworkResponse({ status: 200 }).classification,
    'HTTP_SUCCESS_NON_INFERENCE');
  assert.equal(classifyNetworkResponse({ status: 204 }).classification,
    'HTTP_SUCCESS_NON_INFERENCE');
  assert.equal(classifyRoutedResponse({
    status: 200,
    inferenceRequest: false,
    target: 'https://api.openai.com/v1/models'
  }).classification, 'HTTP_SUCCESS_NON_INFERENCE');
  assert.equal(classifyRoutedResponse({
    status: 200,
    inferenceRequest: true,
    target: 'https://api.openai.com/v1/responses',
    payload: { id: 'resp_fixture', object: 'response', status: 'completed', output: [] }
  }).classification, 'INFERENCE_COMPLETED');
});

test('HTTP 200 without completed inference evidence is never recorded as model success', () => {
  const incomplete = classifyRoutedResponse({
    status: 200,
    inferenceRequest: true,
    target: 'https://api.openai.com/v1/responses',
    payload: { id: 'resp_fixture', object: 'response', status: 'incomplete', output: [] }
  });
  assert.equal(incomplete.classification, 'HTTP_SUCCESS_NON_INFERENCE');
  assert.equal(incomplete.automaticRetryAllowed, false);

  const emptyEnvelope = classifyRoutedResponse({
    status: 200,
    inferenceRequest: true,
    target: 'https://api.deepseek.com/chat/completions',
    payload: { data: [] }
  });
  assert.equal(emptyEnvelope.classification, 'HTTP_SUCCESS_NON_INFERENCE');

  const lengthLimited = classifyRoutedResponse({
    status: 200,
    inferenceRequest: true,
    target: 'https://api.deepseek.com/chat/completions',
    payload: {
      id: 'chatcmpl_fixture',
      choices: [{ message: { content: '' }, finish_reason: 'length' }]
    }
  });
  assert.equal(lengthLimited.classification, 'HTTP_SUCCESS_NON_INFERENCE');
});

test('completed chat and Anthropic envelopes are recognized without borrowing OpenAI status', () => {
  assert.equal(classifyRoutedResponse({
    status: 200,
    inferenceRequest: true,
    target: 'https://api.deepseek.com/chat/completions',
    payload: {
      id: 'chatcmpl_fixture',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
    }
  }).classification, 'INFERENCE_COMPLETED');
  assert.equal(classifyRoutedResponse({
    status: 200,
    inferenceRequest: true,
    target: 'https://api.deepseek.com/anthropic/v1/messages',
    payload: { id: 'msg_fixture', type: 'message', stop_reason: 'end_turn', content: [] }
  }).classification, 'INFERENCE_COMPLETED');
});

test('jsonFetch performs one attempt and rejects a region denial with structured evidence', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":{"code":"unsupported_country_region_territory"}}', {
      status: 403,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_region' }
    });
  };
  await assert.rejects(
    jsonFetch('https://api.openai.com/v1/models', { method: 'GET' }),
    error => error.code === 'UPSTREAM_HTTP_403' &&
      error.networkFailure.classification === 'REGION_OR_POLICY_RESTRICTED' &&
      error.networkFailure.retry === 'NO_AUTOMATIC_RETRY'
  );
  assert.equal(calls, 1);
});
