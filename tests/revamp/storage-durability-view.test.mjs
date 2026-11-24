// Text rendering only. No storage or product state is changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenancePage} from '../../dist/web/maintenance-view.js';

const status = {
  schema: 'dream-maker.maintenance.v1',
  scope: 'APPLICATION_STATE_ONLY',
  completeProjectBackup: false,
  snapshots: [],
  usage: {bytes: 0, limitBytes: 1000, snapshots: 0, rehearsals: 0},
  modelsCalled: 0,
  automaticResume: false,
  storageVolume: {
    schema: 'dream-maker.storage-volume-health.v1',
    scope: 'VOLUME_HEALTH_ONLY',
    drive: 'F:',
    fileSystem: 'exFAT',
    healthStatus: 'Warning',
    operationalStatus: 'Full Repair Needed',
    totalBytes: 1000,
    availableBytes: 250,
    state: 'REPAIR_REQUIRED',
    evidence: 'WINDOWS_STORAGE_READ_ONLY',
    checkedAt: '2026-11-07T00:00:00.000Z'
  }
};

test('maintenance shows the Windows repair warning without claiming automatic repair or durability', () => {
  const html = maintenancePage(status);
  assert.match(html, /F:/);
  assert.match(html, /exFAT/);
  assert.match(html, /Full Repair Needed/);
  assert.match(html, /需要修复/);
  assert.match(html, /没有.*自动修复/);
  assert.match(html, /只代表.*卷.*健康/);
  assert.doesNotMatch(html, /<script>|data-action="(?:repair|format|unmount)/);
});

test('unavailable volume health renders as unknown and keeps the repair boundary visible', () => {
  const html = maintenancePage({
    ...status,
    storageVolume: {
      ...status.storageVolume,
      fileSystem: null,
      healthStatus: null,
      operationalStatus: null,
      totalBytes: null,
      availableBytes: null,
      state: 'UNKNOWN',
      evidence: 'PROBE_UNAVAILABLE'
    }
  });
  assert.match(html, /无法读取.*健康状态/);
  assert.match(html, /不代表.*已通过|不代表.*耐久/);
});
