// The acceptance step is the owner's alone, so the run view has to offer it: ui.ts has handled the
// accept -> confirmation dialog -> confirm-accept flow all along, but views.ts never rendered a button that
// dispatches it, so the only way to accept a delivery was a manual POST. This pins the surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shell } from '../../dist/web/views.js';
import { harness, ready } from '../helpers.mjs';

const viewFor = (project, spec, run, tab = 'run') => ({
    mode: 'local',
    screen: 'project',
    projects: [project],
    snapshot: { project, spec, runs: run ? [run] : [], records: [] },
    settings: null,
    tab,
    busy: false,
    error: '',
    events: [],
    connection: 'closed',
    railClosed: false,
    files: [],
    fileName: '',
    logLimit: 200
});

test('the accept action is offered exactly when a delivery is waiting for the owner', async t => {
    const h = harness(t), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true);
    await h.engine.settled(run.id);
    const delivered = h.store.run(run.id);
    assert.equal(delivered.state, 'READY_FOR_DELIVERY');
    assert.match(shell(viewFor(h.store.project(p.id), s, delivered)), /data-action="accept"/, 'a delivered run offers acceptance');
    const accepted = h.engine.accept(run.id);
    assert.equal(accepted.state, 'ACCEPTED');
    assert.doesNotMatch(shell(viewFor(h.store.project(p.id), s, h.store.run(run.id))), /data-action="accept"/, 'an accepted run offers nothing left to accept');
});

test('a run that has not delivered offers no acceptance button', async t => {
    const h = harness(t, 200), { p, s } = await ready(h), run = h.engine.create(p.id, s.hash, true);
    const running = h.store.run(run.id);
    assert.notEqual(running.state, 'READY_FOR_DELIVERY');
    assert.doesNotMatch(shell(viewFor(h.store.project(p.id), s, running)), /data-action="accept"/);
    await h.engine.cancel(run.id);
});
