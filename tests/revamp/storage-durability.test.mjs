// Read-only Windows volume health. Synthetic cases are not storage acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {probeStorageVolumeHealth,assertStorageVolumeHealthy} from '../../dist/server/storage-durability.js';
import {root} from '../helpers.mjs';

const raw = (overrides = {}) => ({
  schema: 'dream-maker.windows-volume-health.v1',
  drive: 'F:',
  fileSystem: 'NTFS',
  healthStatus: 'Healthy',
  operationalStatus: 'OK',
  totalBytes: 1000000,
  availableBytes: 500000,
  ...overrides
});

test('a healthy Windows volume produces a healthy read-only health record', async () => {
  const result = await probeStorageVolumeHealth(resolve(root, '.runtime'), {
    runner: async drive => {
      assert.equal(drive, 'F:');
      return raw();
    },
    now: () => new Date('2026-11-07T00:00:00.000Z')
  });
  assert.deepEqual(result, {
    schema: 'dream-maker.storage-volume-health.v1',
    scope: 'VOLUME_HEALTH_ONLY',
    drive: 'F:',
    fileSystem: 'NTFS',
    healthStatus: 'Healthy',
    operationalStatus: 'OK',
    totalBytes: 1000000,
    availableBytes: 500000,
    state: 'HEALTHY',
    evidence: 'WINDOWS_STORAGE_READ_ONLY',
    checkedAt: '2026-11-07T00:00:00.000Z'
  });
  assert.doesNotThrow(() => assertStorageVolumeHealthy(result));
});

test('dirty or warning volume state stays visible and blocks the durable-write gate', async () => {
  const result = await probeStorageVolumeHealth(resolve(root, '.runtime'), {
    runner: async () => raw({
      fileSystem: 'exFAT',
      healthStatus: 'Warning',
      operationalStatus: 'Full Repair Needed'
    })
  });
  assert.equal(result.state, 'REPAIR_REQUIRED');
  assert.equal(result.fileSystem, 'exFAT');
  assert.equal(result.operationalStatus, 'Full Repair Needed');
  assert.throws(
    () => assertStorageVolumeHealthy(result),
    {code: 'STORAGE_VOLUME_REPAIR_REQUIRED'}
  );
});

test('missing, malformed, limit-breaking or mismatched probe output is UNKNOWN and never healthy', async () => {
  const cases = [
    async () => { throw new Error('offline probe unavailable'); },
    async () => raw({drive: 'E:'}),
    async () => raw({totalBytes: -1}),
    async () => raw({availableBytes: 2000000}),
    async () => ({...raw(), extra: 'not allowed'}),
    async () => raw({healthStatus: ''})
  ];
  for (const runner of cases) {
    const result = await probeStorageVolumeHealth(resolve(root, '.runtime'), {runner});
    assert.equal(result.state, 'UNKNOWN');
    assert.equal(result.evidence, 'PROBE_UNAVAILABLE');
    assert.throws(
      () => assertStorageVolumeHealthy(result),
      {code: 'STORAGE_VOLUME_HEALTH_UNKNOWN'}
    );
  }
});

test('the actual Windows probe is read-only, bounded and reports the current F volume', {skip: process.platform !== 'win32'}, async () => {
  const result = await probeStorageVolumeHealth(resolve(root, '.runtime'));
  assert.equal(result.drive, 'F:');
  assert.equal(result.evidence, 'WINDOWS_STORAGE_READ_ONLY');
  assert.ok(['HEALTHY', 'REPAIR_REQUIRED'].includes(result.state));
  assert.ok(Number.isSafeInteger(result.totalBytes) && result.totalBytes > 0);
  assert.ok(Number.isSafeInteger(result.availableBytes) && result.availableBytes >= 0);
});
