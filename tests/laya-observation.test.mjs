import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayaObserver, assertLayaOffForAllTurns } from '../dist/server/laya-observation.js';

// A07/K09: what counts as proof that Laya was off. No model, no bridge, no browser.

const off = role => ({ role, mode: 'off', adoption: 'off' });
const abstain = role => ({ role, mode: 'off', adoption: 'abstained' });

test('A07-L1 zero observed turns is not proof, and says so', () => {
    const summary = createLayaObserver().summary();
    assert.equal(summary.turns, 0);
    assert.equal(summary.fullyOff, false);
    assert.equal(summary.reason, 'NO_TURNS_OBSERVED');
    assert.throws(() => assertLayaOffForAllTurns(summary), { code: 'LAYA_OFF_NOT_PROVEN' });
});

test('A07-L2 every dispatch in off mode with no influence is proof', () => {
    const observer = createLayaObserver();
    for (const role of ['planner1', 'planner2', 'executor', 'reviewer']) observer.record(off(role));
    const summary = observer.summary();
    assert.equal(summary.turns, 4);
    assert.equal(summary.influencedTurns, 0);
    assert.equal(summary.fullyOff, true);
    assert.doesNotThrow(() => assertLayaOffForAllTurns(summary));
    assert.deepEqual(summary.byRole, { planner1: 1, planner2: 1, executor: 1, reviewer: 1 });
});

test('A07-L3 a single influenced turn invalidates the claim', () => {
    const observer = createLayaObserver();
    observer.record(off('planner1'));
    observer.record({ role: 'planner2', mode: 'off', adoption: 'advisory',applied:true,runMode:'live' });
    const summary = observer.summary();
    assert.equal(summary.influencedTurns, 1);
    assert.equal(summary.fullyOff, false);
    assert.equal(summary.reason, 'INFLUENCED_TURNS_PRESENT');
    assert.throws(() => assertLayaOffForAllTurns(summary), { code: 'LAYA_OFF_NOT_PROVEN' });
});

test('A07-L4 a turn taken in another mode invalidates the claim even if adoption looks off', () => {
    const observer = createLayaObserver();
    observer.record(off('planner1'));
    observer.record({ role: 'executor', mode: 'on', adoption: 'off' });
    const summary = observer.summary();
    assert.equal(summary.fullyOff, false);
    assert.equal(summary.reason, 'MODE_NOT_OFF');
    assert.deepEqual(summary.byMode, { off: 1, on: 1 });
});

test('A07-L5 abstained counts as uninfluenced, and counts stay per adoption', () => {
    const observer = createLayaObserver();
    observer.record(off('planner1'));
    observer.record(abstain('planner2'));
    const summary = observer.summary();
    assert.equal(summary.fullyOff, true);
    assert.deepEqual(summary.byAdoption, { off: 1, abstained: 1 });
});

test('A07-L6 malformed records are ignored rather than counted as off', () => {
    const observer = createLayaObserver();
    observer.record(undefined);
    observer.record({ role: '', mode: 'off', adoption: 'off' });
    assert.equal(observer.summary().turns, 0, 'a nameless record must not become evidence');
});
