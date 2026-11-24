import test from 'node:test';
import assert from 'node:assert/strict';
import { attachShadowMirror } from '../dist/server/orca/shadow-attach.js';
import { createShadowMirror } from '../dist/server/orca/shadow.js';

// A09: the observation seam. Synthetic store only — no engine, no database.

function fakeStore() {
    const calls = [];
    return {
        calls,
        event(projectId, runId, type, payload) { calls.push({ projectId, runId, type, payload }); return calls.length; }
    };
}

test('A09-A1 engine events reach the mirror and the original call still happens', () => {
    const store = fakeStore();
    const mirror = createShadowMirror({ mode: 'SHADOW' });
    attachShadowMirror(store, mirror);
    const result = store.event('p1', 'r1', 'role.dispatch', { role: 'planner2' });
    assert.equal(result, 1, 'the original return value is preserved');
    assert.equal(store.calls.length, 1);
    assert.deepEqual(mirror.recent().map(e => e.kind), ['role.dispatch']);
    assert.equal(mirror.recent()[0].runId, 'r1');
});

test('A09-A2 a null run id is projected as an empty string, not the text "null"', () => {
    const store = fakeStore();
    const mirror = createShadowMirror({ mode: 'SHADOW' });
    attachShadowMirror(store, mirror);
    store.event('p1', null, 'project.created', {});
    assert.equal(mirror.recent()[0].runId, '');
});

test('A09-A3 a throwing mirror never breaks the business call', () => {
    const store = fakeStore();
    const explosive = { push() { throw new Error('mirror exploded'); }, recent: () => [], stats: () => ({ accepted: 0, dropped: 0, mode: 'SHADOW' }) };
    attachShadowMirror(store, explosive);
    const result = store.event('p1', 'r1', 'run.started', {});
    assert.equal(result, 1);
    assert.equal(store.calls.length, 1);
});

test('A09-A4 detaching restores the original function exactly', () => {
    const store = fakeStore();
    const before = store.event;
    const mirror = createShadowMirror({ mode: 'OFF' });
    const detach = attachShadowMirror(store, mirror);
    assert.notEqual(store.event, before);
    detach();
    assert.equal(store.event, before);
    store.event('p1', 'r1', 'x', {});
    assert.equal(mirror.recent().length, 0, 'OFF records nothing even while attached');
});
test('A09-D1 the mirror records field names, not payload values', () => {
    const store = fakeStore();
    const mirror = createShadowMirror({ mode: 'SHADOW' });
    attachShadowMirror(store, mirror);
    store.event('p1', 'r1', 'run.created', { mode: 'demo', specHash: 'deadbeef'.repeat(8), workspace: 'C:/secret/dir' });
    const detail = mirror.recent()[0].detail;
    assert.equal(detail, 'mode,specHash,workspace');
    assert.equal(detail.includes('demo'), false);
    assert.equal(detail.includes('deadbeef'), false);
    assert.equal(detail.includes('C:/secret'), false);
});

test('A09-D2 non-object payloads produce an empty detail instead of a stringified blob', () => {
    const store = fakeStore();
    const mirror = createShadowMirror({ mode: 'SHADOW' });
    attachShadowMirror(store, mirror);
    store.event('p1', 'r1', 'raw.string', 'this text must not be recorded');
    store.event('p1', 'r1', 'raw.array', [1, 2, 3]);
    store.event('p1', 'r1', 'raw.null', null);
    assert.deepEqual(mirror.recent().map(e => e.detail), ['', '', '']);
});

test('A09-D3 a payload with many fields is capped and the business call still runs', () => {
    const store = fakeStore();
    const mirror = createShadowMirror({ mode: 'SHADOW' });
    attachShadowMirror(store, mirror);
    const wide = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['f' + i, 'v' + i]));
    const result = store.event('p1', 'r1', 'wide', wide);
    assert.equal(result, 1);
    const detail = mirror.recent()[0].detail;
    assert.equal(detail.split(',').length, 8);
    assert.equal(detail.includes('v0'), false);
});
