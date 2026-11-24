#!/usr/bin/env node
// Controlled reconciliation of a run whose worker died without a result.
// This is the ONLY supported way to give up the writer lease of such a run: it goes through
// Engine.reconcile, which refuses unless every ownership proof holds and records a run.reconciled event.
import { resolve } from 'node:path';
import { Store } from '../dist/server/store.js';
import { LayaBridge } from '../dist/server/laya.js';
import { Engine } from '../dist/server/engine.js';
import { parseConfig } from '../dist/server/config.js';
import { readFileSync } from 'node:fs';

const [, , runId, flag] = process.argv;
if (!runId || flag !== '--confirm') {
  console.error('usage: node scripts/reconcile-run.mjs <runId> --confirm');
  console.error('refuses without --confirm because it cancels a Live run and releases its lease');
  process.exit(2);
}
const root = resolve('.');
const config = parseConfig(JSON.parse(readFileSync(resolve(root, 'config/local.json'), 'utf8')));
const store = new Store(resolve(root, '.runtime/dream-maker.sqlite'));
const engine = new Engine(store, new LayaBridge(() => config), () => config, root, resolve(root, '.runtime'));
try {
  const before = store.run(runId);
  console.log('BEFORE', JSON.stringify({ state: before.state, reason: before.reason, phase: before.phase, attempt: before.attempt, lease: store.owns(before.projectId, runId) }));
  const after = await engine.reconcile(runId);
  console.log('AFTER ', JSON.stringify({ state: after.state, reason: after.reason, lease: store.owns(after.projectId, runId) }));
} finally {
  await engine.close();
  store.close();
}
