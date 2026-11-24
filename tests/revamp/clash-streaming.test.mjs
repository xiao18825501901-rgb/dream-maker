import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  clashFetch,
  controlledResponseStream
} from '../../dist/server/clash-transport.js';

test('controlled response stream yields incrementally and classifies a midstream reset', async () => {
  let pulls = 0, cleaned = 0;
  async function* upstream() {
    pulls += 1;
    yield new TextEncoder().encode('data: first\n\n');
    throw Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' });
  }
  const stream = controlledResponseStream(upstream(), {
    cleanup: () => { cleaned += 1; },
    maxBytes: 1024,
    idleMs: 5000
  });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  await assert.rejects(reader.read(), error =>
    error.code === 'STREAM_INTERRUPTED' &&
    error.networkFailure.classification === 'STREAM_INTERRUPTED');
  assert.equal(pulls, 1);
  assert.equal(cleaned, 1);
});

test('aborting after the first chunk closes the controlled stream and upstream iterator', async () => {
  const abort = new AbortController();
  let pulls = 0, cleaned = 0, returned = 0;
  const upstream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      pulls += 1;
      return pulls === 1
        ? Promise.resolve({ done: false, value: new TextEncoder().encode('data: first\n\n') })
        : new Promise(() => {});
    },
    return() {
      returned += 1;
      return Promise.resolve({ done: true, value: undefined });
    }
  };
  const stream = controlledResponseStream(upstream, {
    cleanup: () => { cleaned += 1; },
    signal: abort.signal,
    maxBytes: 1024,
    idleMs: 5000
  });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  const pending = reader.read();
  abort.abort();
  const outcome = await Promise.race([
    pending.then(() => ({ kind: 'resolved' }), error => ({ kind: 'rejected', error })),
    delay(500, { kind: 'timeout' })
  ]);
  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.error.code, 'CLASH_REQUEST_ABORTED');
  assert.equal(outcome.error.networkFailure.classification, 'STREAM_INTERRUPTED');
  assert.equal(outcome.error.networkFailure.retry, 'NO_AUTOMATIC_RETRY');
  assert.equal(outcome.error.networkFailure.automaticRetryAllowed, false);
  assert.equal(cleaned, 1);
  assert.equal(returned, 1);
});

test('fake CONNECT proxy reset is classified without reaching OpenAI', async t => {
  const proxy = http.createServer();
  proxy.on('connect', (_request, socket) => socket.destroy());
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const address = proxy.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);
  await assert.rejects(
    clashFetch({
      proxyUrl: `http://127.0.0.1:${address.port}/`,
      expectedNode: 'fixture-node',
      controller: {
        traceConnection: async () => ({ chains: ['fixture-node'] })
      }
    }, 'https://api.openai.com/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    }),
    error => error.networkFailure?.classification === 'PROXY_CONNECTION_RESET'
  );
});

test('a closed local proxy port is a TCP failure, not a reset', async () => {
  const proxy = http.createServer();
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);
  const port = address.port;
  await new Promise(resolve => proxy.close(resolve));
  await assert.rejects(
    clashFetch({
      proxyUrl: `http://127.0.0.1:${port}/`,
      expectedNode: 'fixture-node',
      controller: {
        traceConnection: async () => ({ chains: ['fixture-node'] })
      }
    }, 'https://api.openai.com/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    }),
    error => error.networkFailure?.classification === 'TCP_CONNECTION_FAILURE' &&
      error.networkFailure?.context === 'PROXY' &&
      error.networkFailure?.automaticRetryAllowed === true
  );
});
