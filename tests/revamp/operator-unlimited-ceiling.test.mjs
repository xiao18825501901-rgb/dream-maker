// Owner-directed continuation has no cumulative request stop. Per-flow call,
// tool, time and money guards remain active and are covered by their own tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createNativeOwner} from '../../dist/server/native-owner.js';
import {hash} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';

test('the owner can continue without the legacy cumulative request stop', async t => {
  const h = harness(t);
  const authority = {
    scopeId: 'OFFLINE_UNLIMITED_CONTINUATION',
    authorizationHash: 'OWNER_AUTHORIZED_UNLIMITED_REQUESTS',
    totalMicros: 50000000,
    probeMicros: 5000000,
    warningMicros: 40000000,
    maxInFlight: 1,
    maxRepairs: 2,
  };
  const authorityPath = resolve(h.dir, 'authority.json');
  writeFileSync(authorityPath, JSON.stringify(authority));
  mkdirSync(resolve(h.dir, 'config'), {recursive: true});
  writeFileSync(resolve(h.dir, 'config/native-owner.local.json'), JSON.stringify({
    schema: 'dream-maker.native-owner.v1',
    scopeRoot: h.dir,
    authority: {
      path: authorityPath,
      sha256: hash(readFileSync(authorityPath)),
    },
    maxOutputTokens: 128,
    maxRequests: 1_000_000,
  }));

  const owner = createNativeOwner({
    root: h.dir,
    store: h.store,
    getConfig: () => h.config,
  });

  try {
    assert.throws(
      () => owner.assertReady('build'),
      error => error?.code !== 'NATIVE_OPERATOR_CONFIG_INVALID',
    );
  } finally {
    await owner.close();
  }
});
