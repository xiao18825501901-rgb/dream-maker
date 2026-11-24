import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedJsonTarget } from '../../dist/server/security.js';

test('the Laya protocol may use its configured loopback port only on fixed service paths', () => {
  for (const [url, method] of [
    ['http://127.0.0.1:8765/health', 'GET'],
    ['http://127.0.0.1:49321/info', 'GET'],
    ['http://127.0.0.1:8765/v1/decide', 'POST']
  ]) {
    assert.equal(allowedJsonTarget(url, method).href, url);
  }

  for (const [url, method] of [
    ['http://127.0.0.1:8765/admin', 'GET'],
    ['http://127.0.0.1:8765/health', 'POST'],
    ['http://127.0.0.1:8765/info', 'POST'],
    ['http://127.0.0.1:8765/v1/decide', 'GET'],
    ['http://localhost:8765/health', 'GET'],
    ['http://127.0.0.1:8765/health?redirect=1', 'GET']
  ]) {
    assert.throws(() => allowedJsonTarget(url, method), { code: 'NETWORK_TARGET_DENIED' });
  }
});
