import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {assertCustomModelPrices,assertNativePriceForRoute} from '../../dist/server/native-budget.js';

const route = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  currency: 'CNY',
};

function price(overrides = {}) {
  return {
    ...route,
    source: 'OFFLINE_TEST_PRICE',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxInputTokens: 1_048_576,
    inputMissMicrosPerMillion: 2_000_000,
    inputHitMicrosPerMillion: 40_000,
    outputMicrosPerMillion: 8_000_000,
    ...overrides,
  };
}

test('matching route remains valid', () => {
  assert.doesNotThrow(() => assertNativePriceForRoute(price(), route));
});

test('route mismatch has its own error', () => {
  assert.throws(
    () => assertNativePriceForRoute(price({ model: 'other' }), route),
    { code: 'NATIVE_PRICE_ROUTE_MISMATCH' },
  );
});

test('expired matching route is reported as expired', () => {
  assert.throws(
    () => assertNativePriceForRoute(price({ expiresAt: '2000-01-01T00:00:00Z' }), route),
    { code: 'NATIVE_PRICE_EXPIRED' },
  );
});

test('non-conservative matching route is rejected separately', () => {
  assert.throws(
    () => assertNativePriceForRoute(price({ maxInputTokens: 1_000 }), route),
    { code: 'NATIVE_CONSERVATIVE_PRICE_REQUIRED' },
  );
});

test('Custom price bindings accept only exact provider/model keys and local pinned references', () => {
  const root = resolve('offline-price-scope');
  const ref = {path: resolve(root, 'price.json'), sha256: 'a'.repeat(64)};
  assert.doesNotThrow(() => assertCustomModelPrices(undefined, root));
  assert.doesNotThrow(() => assertCustomModelPrices({'deepseek-official/deepseek-flash': ref}, root));
  assert.doesNotThrow(() => assertCustomModelPrices({'kimi/kimi-code/kimi-for-coding': ref}, root));
  for (const invalid of [
    null,
    [ref],
    {executor: ref},
    {'/deepseek-flash': ref},
    {'deepseek-official/': ref},
    {'deepseek-official/deepseek-flash': null},
    {'deepseek-official/deepseek-flash': {...ref, path: 'price.json'}},
    {'deepseek-official/deepseek-flash': {...ref, path: resolve(root, '..', 'price.json')}},
    {'deepseek-official/deepseek-flash': {...ref, sha256: 'unpinned'}},
    {'deepseek-official/deepseek-flash': {...ref, extra: true}},
  ]) assert.throws(() => assertCustomModelPrices(invalid, root), {code: 'NATIVE_CUSTOM_MODEL_PRICES_INVALID'});
});

