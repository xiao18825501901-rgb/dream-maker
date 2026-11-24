import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, ready, root } from './helpers.mjs';
import { Engine } from '../dist/server/engine.js';

const codeOf = (fn) => fn().then(() => 'NONE', error => error.code ?? 'NO_CODE');
// A worker that dies mid-write still holds the project lease — that is the state reconciliation exists for.
// Delivery now releases the lease when a run completes, so a finished demo run no longer models a crashed
// writer; the test re-takes the lease explicitly instead of relying on delivery keeping it.
const dead = (h, runId) => h.store.tx(() => {
    const r = h.store.run(runId);
    r.state = 'BLOCKED';
    r.reason = 'WORKER_RESTART_RESULT_UNCERTAIN';
    r.updatedAt = '2020-01-01T00:00:00.000Z';
    h.store.saveRun(r);
    if (!h.store.owns(r.projectId, r.id)) h.store.acquire(r.projectId, r.id);
});

test('an uncertain run is reconciled only with proofs and the release is recorded by the product', async (t) => {
    const h = harness(t);
    const { p, s } = await ready(h, 'demo');
    const run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    dead(h, run.id);
    assert.equal(h.store.owns(p.id, run.id), true, 'the dead run still holds the writer lease');
    const out = await h.engine.reconcile(run.id);
    assert.equal(out.state, 'CANCELLED');
    assert.equal(out.reason, 'PROCESS_OWNERSHIP_RECONCILED');
    assert.equal(h.store.owns(p.id, run.id), false, 'the lease is released, not deleted by hand');
    const events = h.store.events(p.id).filter(e => e.type === 'run.reconciled');
    assert.equal(events.length, 1, 'the reconciliation is auditable');
    assert.ok(JSON.stringify(events[0]).includes('runId'));
});

test('reconcile refuses while this process still owns the run', async (t) => {
    const h = harness(t, 200);
    const { p, s } = await ready(h, 'demo');
    const run = h.engine.create(p.id, s.hash, true);
    assert.equal(await codeOf(() => h.engine.reconcile(run.id)), 'PROCESS_OWNERSHIP_ACTIVE');
    assert.equal(h.store.owns(p.id, run.id), true);
    await h.engine.settled(run.id);
});

test('reconcile refuses a run that is not waiting for reconciliation', async (t) => {
    const h = harness(t);
    const { p, s } = await ready(h, 'demo');
    const run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    assert.equal(await codeOf(() => h.engine.reconcile(run.id)), 'RECONCILIATION_NOT_REQUIRED');
});

test('a host that outlived its parent blocks the release instead of being assumed dead', async (t) => {
    const h = harness(t);
    const { p, s } = await ready(h, 'demo');
    const run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    dead(h, run.id);
    // Reconstruct the same controller on this test's private root. Never replace a real native
    // host.pid under the developer checkout to simulate an orphan. No model/job is dispatched.
    const recovered=new Engine(h.store,h.laya,()=>h.config,h.dir,h.dir,0);t.after(()=>recovered.close());
    const watched = resolve(h.dir, '.runtime/native/dsh-home');
    mkdirSync(watched, { recursive: true });
    const watchedPid = resolve(watched, 'host.pid');
    writeFileSync(watchedPid, String(process.pid));
    assert.equal(await codeOf(() => recovered.reconcile(run.id)), 'PROCESS_OWNERSHIP_UNPROVEN');
    assert.equal(h.store.owns(p.id, run.id), true, 'a possibly-alive host keeps the lease in place');
});
