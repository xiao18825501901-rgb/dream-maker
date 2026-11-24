// OFFLINE wiring proof: no CFW mutation, network request, OAuth or model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOwner } from '../../dist/server/native-owner.js';
import { harness } from '../helpers.mjs';

const genericFetch = async () => {
  throw new Error('GENERIC_TRANSPORT_MUST_NOT_BE_SELECTED');
};
const executorFetch = async () => {
  throw new Error('OFFLINE_EXECUTOR_TRANSPORT_NOT_INVOKED');
};

test('Classic DSH selects the executor-attributed CFW transport instead of generic fetch', t => {
  const h = harness(t);
  const roles = [];
  const owner = new NativeOwner({
    root: h.dir,
    store: h.store,
    getConfig: () => h.config,
    fetch: genericFetch,
    fetchForRole: role => {
      roles.push(role);
      return executorFetch;
    }
  });
  t.after(() => owner.close());

  assert.equal(owner.executorTransport(), executorFetch);
  assert.deepEqual(roles, ['executor']);
});

test('Classic DSH retains the generic transport only when no role binding is supplied', t => {
  const h = harness(t);
  const owner = new NativeOwner({
    root: h.dir,
    store: h.store,
    getConfig: () => h.config,
    fetch: genericFetch
  });
  t.after(() => owner.close());

  assert.equal(owner.executorTransport(), genericFetch);
});
