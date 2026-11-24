// Offline controller regression. This does not contact Codex, OpenAI or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DreamMakerUI } from '../../dist/web/ui.js';

function controller(adapter) {
  const ui = Object.create(DreamMakerUI.prototype);
  ui.adapter = adapter;
  ui.v = {
    busy: false,
    screen: 'settings',
    codexMetadataLoading: false,
    codexMetadata: { observedAt: 'OLD_EVIDENCE' },
    codexMetadataError: ''
  };
  ui.disposed = false;
  ui.epoch = 1;
  ui.codexMetadataSeq = 0;
  ui.render = () => {};
  return ui;
}

test('a rejected metadata request clears the old success before showing failure', async () => {
  const ui = controller({
    mode: 'local',
    presentation: 'normal',
    async request() {
      throw new Error('synthetic transport failure');
    }
  });

  await ui.readCodexMetadata();

  assert.equal(ui.v.codexMetadata, undefined);
  assert.match(ui.v.codexMetadataError, /上次结果已隐藏/);
  assert.match(ui.v.codexMetadataError, /没有发起模型推理、登录或网络修改/);
  assert.equal(ui.v.codexMetadataLoading, false);
});

test('a stale rejected request cannot clear evidence from a newer request', async () => {
  const ui = controller({
    mode: 'local',
    presentation: 'normal',
    async request() {
      ui.codexMetadataSeq += 1;
      ui.v.codexMetadata = { observedAt: 'NEW_EVIDENCE' };
      throw new Error('late stale failure');
    }
  });

  await ui.readCodexMetadata();

  assert.deepEqual(ui.v.codexMetadata, { observedAt: 'NEW_EVIDENCE' });
  assert.equal(ui.v.codexMetadataError, '');
  // The newer request owns the loading state; the stale completion must not clear it.
  assert.equal(ui.v.codexMetadataLoading, true);
});
