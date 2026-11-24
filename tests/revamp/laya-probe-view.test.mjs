import test from 'node:test';
import assert from 'node:assert/strict';
import { layaProbePanel, readLayaProbe } from '../../dist/web/laya-probe-view.js';

test('a successful probe exposes only bounded service facts and never raw response secrets', () => {
  const result = readLayaProbe({
    base: 'http://127.0.0.1:8765',
    health: {
      ok: true,
      status: 'ok',
      Authorization: 'Bearer MUST_NOT_RENDER',
      cookie: 'MUST_NOT_RENDER'
    },
    info: {
      revision: 'fixture-revision',
      tokenizer: 'fixture-tokenizer',
      device: 'cpu',
      apiKey: 'MUST_NOT_RENDER'
    },
    verified: 'HTTP_ONLY_NOT_MODEL_QUALITY'
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.reachable, true);
  assert.equal(result.value.health, 'REPORTED_OK');
  assert.equal(result.value.revision, 'fixture-revision');
  assert.equal(result.value.modelQuality, 'NOT_VERIFIED');

  const html = layaProbePanel({ result, expectedRevision: 'fixture-revision' });
  assert.match(html, /服务已响应/);
  assert.match(html, /127\.0\.0\.1:8765/);
  assert.match(html, /fixture-revision/);
  assert.match(html, /与当前预期一致/);
  assert.match(html, /不代表分类质量/);
  assert.doesNotMatch(html, /MUST_NOT_RENDER|Authorization|cookie|apiKey/);
});

test('the view fails closed for a non-loopback endpoint or missing HTTP-only provenance', () => {
  const remote = readLayaProbe({
    base: 'https://example.invalid',
    health: { ok: true },
    info: { revision: 'remote' },
    verified: 'HTTP_ONLY_NOT_MODEL_QUALITY'
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.code, 'LAYA_PROBE_ENDPOINT_INVALID');
  assert.match(layaProbePanel({ result: remote }), /只允许检查本机回环服务/);

  const unproven = readLayaProbe({
    base: 'http://127.0.0.1:8765',
    health: { ok: true },
    info: { revision: 'fixture-revision' },
    verified: 'MODEL_QUALITY_VERIFIED'
  });
  assert.equal(unproven.ok, false);
  assert.equal(unproven.code, 'LAYA_PROBE_RESULT_INVALID');
  assert.match(layaProbePanel({ result: unproven }), /没有返回可核对的本机检查结果/);
});

test('response-only and mismatch states stay honest instead of claiming health or model quality', () => {
  const unknown = readLayaProbe({
    base: 'http://127.0.0.1:8765',
    health: { message: 'listening' },
    info: { model_revision: 'different-revision' },
    verified: 'HTTP_ONLY_NOT_MODEL_QUALITY'
  });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.value.health, 'RESPONSE_ONLY');
  const html = layaProbePanel({ result: unknown, expectedRevision: 'expected-revision' });
  assert.match(html, /已响应，未确认健康/);
  assert.match(html, /与当前预期不一致/);
  assert.match(html, /HTTP 可达/);
  assert.doesNotMatch(html, /模型质量已通过/);
});
