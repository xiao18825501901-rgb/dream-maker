import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnWatchdog } from '../dist/server/turn-watchdog.js';

function manual() {
    let fn = null;
    let cleared = 0;
    return {
        now: () => 0,
        setIntervalFn: (f) => { fn = f; return { unref() { }, [Symbol.toPrimitive]: () => 0 }; },
        clearIntervalFn: () => { cleared++; },
        tick: () => fn && fn(),
        cleared: () => cleared,
        setNow(holder, value) { holder.value = value; }
    };
}

test('turn watchdog fires only after the idle window with no touch', () => {
    let now = 0, stalls = 0;
    const ctl = manual();
    const wd = createTurnWatchdog({ idleMs: 120000, onStall: () => { stalls++; }, now: () => now, setIntervalFn: ctl.setIntervalFn, clearIntervalFn: ctl.clearIntervalFn });
    now = 60000; ctl.tick();
    assert.equal(stalls, 0, 'inside the window nothing fires');
    now = 120001; ctl.tick();
    assert.equal(stalls, 1, 'past the window the host is declared stalled');
    ctl.tick();
    assert.equal(stalls, 1, 'a stall is reported once, not repeatedly');
    wd.stop();
});

test('a touched watchdog never fires and cannot be renewed by the task', () => {
    let now = 0, stalls = 0;
    const ctl = manual();
    const wd = createTurnWatchdog({ idleMs: 10000, onStall: () => { stalls++; }, now: () => now, setIntervalFn: ctl.setIntervalFn, clearIntervalFn: ctl.clearIntervalFn });
    for (let i = 0; i < 50; i++) { now += 5000; wd.touch(); ctl.tick(); }
    assert.equal(stalls, 0);
    now += 10001; ctl.tick();
    assert.equal(stalls, 1);
    wd.stop();
});

test('stop() clears the interval so a finished turn cannot report a stall', () => {
    let stalls = 0;
    const ctl = manual();
    const wd = createTurnWatchdog({ idleMs: 1000, onStall: () => { stalls++; }, now: () => 0, setIntervalFn: ctl.setIntervalFn, clearIntervalFn: ctl.clearIntervalFn });
    wd.stop();
    assert.equal(ctl.cleared(), 1);
    ctl.tick();
    assert.equal(stalls, 0);
});
