// OFFLINE bounded-context regression. No Laya service, model or credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ready } from '../helpers.mjs';
import { hash } from '../../dist/server/security.js';
import { roleAssistanceBrief } from '../../dist/server/flow/role-assistance.js';

async function rig(t) {
  const h = harness(t), { p, s } = await ready(h);
  h.engine.launch = () => {};
  const created = h.engine.create(p.id, s.hash, true), run = h.store.run(created.id);
  run.mode = 'live'; run.state = run.phase = 'IMPLEMENTING';
  h.store.saveRun(run);
  return { h, p, run: h.store.run(created.id) };
}

test('bounded source context stops at 600 bytes and marks itself partial', async t => {
  const { h, p, run } = await rig(t);
  const content = Array.from({length: 80}, (_, i) => `export const line_${i} = ${i};`).join('\n');
  const snapshot = {
    schema: 'dream-maker.source-snapshot.v1',
    runId: run.id,
    specHash: run.specHash,
    treeHash: 'T'.repeat(64),
    files: [{path: 'src/main.ts', encoding: 'utf8', content, sha256: hash(Buffer.from(content, 'utf8'))}]
  };
  const {sha256, ...body} = snapshot;
  snapshot.sha256 = hash(body);
  h.store.record('SourceSnapshot', p.id, run.id, snapshot);
  const brief = roleAssistanceBrief(h.store, run, 'executor', 'task-data', true, undefined);
  assert.ok(brief.state.sourceSpan);
  assert.ok(Buffer.byteLength(brief.state.sourceSpan.content) <= 600);
  assert.equal(brief.state.sourceSpan.partial, true);
  assert.equal(brief.state.sourceSpan.path, 'src/main.ts');
  assert.equal(brief.state.sourceSpan.lineStart, 1);
  assert.ok(brief.state.sourceSpan.fileHash);
});

test('without a verified snapshot the brief carries no source span', async t => {
  const { h, run } = await rig(t);
  const brief = roleAssistanceBrief(h.store, run, 'reviewer', 'task-data', true, undefined);
  assert.equal(brief.state.sourceSpan, null);
  assert.equal(brief.support.coverage, 'TASK_AND_BOUNDED_SOURCE_CONTEXT_NOT_FULL_REVIEW');
  assert.equal(brief.support.authority, 'ADVISORY_ONLY');
});
