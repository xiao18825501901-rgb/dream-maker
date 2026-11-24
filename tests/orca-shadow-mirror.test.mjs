import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowMirror, resolveOrcaMode } from '../dist/server/orca/shadow.js';

// A09 source half: the bounded event mirror. No Orca, no engine.

test('A09-M1 OFF records nothing at all', () => {
    const mirror = createShadowMirror({ mode: 'OFF' });
    assert.equal(mirror.push('run.started', 'run_1'), null);
    assert.deepEqual(mirror.recent(), []);
    assert.deepEqual(mirror.stats(), { accepted: 0, dropped: 0, mode: 'OFF' });
});

test('A09-M2 SHADOW projects bounded events and reports counts', () => {
    const mirror = createShadowMirror({ mode: 'SHADOW', clock: () => Date.parse('2026-10-18T00:00:00.000Z') });
    const event = mirror.push('role.dispatch', 'run_1', 'planner2');
    assert.deepEqual(event, { at: '2026-10-18T00:00:00.000Z', kind: 'role.dispatch', runId: 'run_1', detail: 'planner2' });
    assert.equal(mirror.recent().length, 1);
    assert.equal(mirror.stats().accepted, 1);
});

test('A09-M3 the buffer is bounded and drops are counted, not hidden', () => {
    const mirror = createShadowMirror({ mode: 'SHADOW', maxEvents: 3 });
    for (let i = 0; i < 5; i++) mirror.push('tick', 'run_1', String(i));
    assert.equal(mirror.recent().length, 3);
    assert.deepEqual(mirror.recent().map(e => e.detail), ['2', '3', '4']);
    assert.equal(mirror.stats().dropped, 2);
    assert.equal(mirror.stats().accepted, 5);
});

test('A09-M4 absurd bounds and oversized fields are bounded', () => {
    assert.throws(() => createShadowMirror({ mode: 'SHADOW', maxEvents: 0 }), /SHADOW_MAX_EVENTS_INVALID/);
    assert.throws(() => createShadowMirror({ mode: 'SHADOW', maxEvents: 99_999 }), /SHADOW_MAX_EVENTS_INVALID/);
    const mirror = createShadowMirror({ mode: 'SHADOW' });
    const event = mirror.push('x'.repeat(500), 'run_1', 'y'.repeat(500));
    assert.equal(event.kind.length, 64);
    assert.equal(event.detail.length, 200);
});
// HA-003/A09: an unsupported or misspelled mode must degrade VISIBLY, never silently.
test('A09-M1 the requested Orca mode is reported when it cannot take effect', () => {
    assert.deepEqual(resolveOrcaMode(undefined), { requested: 'OFF', effective: 'OFF', degraded: false, reason: null });
    assert.deepEqual(resolveOrcaMode('off'), { requested: 'OFF', effective: 'OFF', degraded: false, reason: null });
    assert.deepEqual(resolveOrcaMode(' shadow '), { requested: 'SHADOW', effective: 'SHADOW', degraded: false, reason: null });
    assert.deepEqual(resolveOrcaMode('MANAGED_EXECUTOR'), { requested: 'MANAGED_EXECUTOR', effective: 'MANAGED_EXECUTOR', degraded: false, reason: null });
    // The plausible-but-unsupported spellings:
    // An empty variable is "not set", not a mode that was rejected.
    assert.deepEqual(resolveOrcaMode(''), { requested: 'OFF', effective: 'OFF', degraded: false, reason: null });
    for (const raw of ['MANAGED', 'SHADOWW', 'AUTO']) {
        const r = resolveOrcaMode(raw);
        assert.equal(r.effective, 'OFF', raw);
        assert.equal(r.degraded, true, raw);
        assert.equal(r.reason, 'ORCA_MODE_NOT_AVAILABLE', raw);
        assert.equal(r.requested, (raw ?? '').trim().toUpperCase() || 'OFF', raw);
    }
});
