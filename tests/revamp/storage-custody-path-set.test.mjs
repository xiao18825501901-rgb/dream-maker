// OFFLINE_CONTRACT_ONLY: validates the custody path plan; real Windows handle checks are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  custodyParentDirectories,
  pinCustodyParentDirectories,
  STORAGE_CUSTODY_PARENT_DIRECTORY_LIMIT,
} from '../../dist/server/storage-custody-paths.js';

test('custody path plan includes every unique parent and rejects unsafe or excessive paths', () => {
  const paths = [
    'workspaces/run-a/docs/readme.md',
    'workspaces/run-a/docs/help.md',
    'workspaces/run-a/src/main.mjs',
    'sqlite-images/' + 'a'.repeat(64) + '.sqlite',
    'application.sqlite',
  ];
  assert.deepEqual(custodyParentDirectories(paths), [
    'sqlite-images',
    'workspaces',
    'workspaces/run-a',
    'workspaces/run-a/docs',
    'workspaces/run-a/src',
  ]);
  for (const denied of ['../outside/file', '/absolute/file', 'workspaces\\run\\file', 'workspaces//file']) {
    assert.throws(() => custodyParentDirectories([denied]), {code: 'STORAGE_CUSTODY_PATH_DENIED'});
  }
  const tooMany = Array.from(
    {length: STORAGE_CUSTODY_PARENT_DIRECTORY_LIMIT + 1},
    (_, index) => `workspaces/run-${index}/file.txt`,
  );
  assert.throws(() => custodyParentDirectories(tooMany), {code: 'STORAGE_CUSTODY_PATH_LIMIT'});
});

test('custody path plan pins every parent through the original keeper lease', async () => {
  const calls = [];
  const lease = {
    async directory(path, create) {
      calls.push([path, create]);
      return {path, identity: '1:2'};
    },
  };
  const count = await pinCustodyParentDirectories(
    lease,
    'controller/registered-backups/snapshot_' + 'b'.repeat(32),
    ['workspaces/run-a/docs/readme.md', 'workspaces/run-a/src/main.mjs', 'application.sqlite'],
    true,
  );
  assert.equal(count, 4);
  assert.deepEqual(calls, [
    ['controller/registered-backups/snapshot_' + 'b'.repeat(32) + '/workspaces', true],
    ['controller/registered-backups/snapshot_' + 'b'.repeat(32) + '/workspaces/run-a', true],
    ['controller/registered-backups/snapshot_' + 'b'.repeat(32) + '/workspaces/run-a/docs', true],
    ['controller/registered-backups/snapshot_' + 'b'.repeat(32) + '/workspaces/run-a/src', true],
  ]);
});
