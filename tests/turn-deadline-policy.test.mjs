import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfig, defaults } from '../dist/server/config.js';
import { OPERATOR_REQUEST_CEILING } from '../dist/server/operator-ceiling.js';

const base = JSON.parse(JSON.stringify(defaults));
const withLimits = (limits) => parseConfig({ ...base, limits: { ...base.limits, ...limits } });

test('one executor turn may run past the old five-minute wall but never without a bound', () => {
    assert.equal(withLimits({ stepTimeoutMs: 1320000 }).limits.stepTimeoutMs, 1320000);
    assert.throws(() => withLimits({ stepTimeoutMs: 1800001 }), /INVALID_INTEGER/);
    assert.throws(() => withLimits({ stepTimeoutMs: 999 }), /INVALID_INTEGER/);
});

test('the no-progress watchdog defaults to two minutes and stays inside a finite window', () => {
    assert.equal(defaults.limits.idleTimeoutMs, 120000);
    assert.equal(withLimits({ idleTimeoutMs: 30000 }).limits.idleTimeoutMs, 30000);
    assert.equal(withLimits({ idleTimeoutMs: undefined }).limits.idleTimeoutMs, 120000);
    assert.throws(() => withLimits({ idleTimeoutMs: 5000 }), /INVALID_INTEGER/);
    assert.throws(() => withLimits({ idleTimeoutMs: 900001 }), /INVALID_INTEGER/);
});

test('a run may be long, but maxSeconds is still a hard finite ceiling', () => {
    assert.equal(withLimits({ maxSeconds: 10800 }).limits.maxSeconds, 10800);
    assert.throws(() => withLimits({ maxSeconds: 21601 }), /INVALID_INTEGER/);
});

// These two read the OPERATOR's machine-local binding (.runtime/native/template.json, config/local.json,
// config/native-owner.local.json). That is deliberate — the point is to check the real dispatch config — but the
// engineering package excludes those files, so extracting the package and running npm test produced three red
// failures that say nothing about the code. Absent binding now skips with a reason; a present binding still
// asserts exactly as before.
const operatorFile = path => existsSync(resolve(path)) ? resolve(path) : null;
test('the bridge deadline exceeds the host run deadline actually written to the dispatch config', t => {
    const templatePath = operatorFile('.runtime/native/template.json'), localPath = operatorFile('config/local.json');
    if (!templatePath || !localPath) { t.skip('needs the operator\'s local binding (excluded from the public package)'); return; }
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    assert.ok(Number.isSafeInteger(template.timeoutMs) && template.timeoutMs <= 1800000, 'host deadline stays finite');
    assert.ok(template.timeoutMs > 300000, 'host deadline now exceeds the retired five-minute cap');
    assert.ok(local.limits.stepTimeoutMs > template.timeoutMs, 'the bridge waits longer than the host it owns');
    assert.ok(Number.isSafeInteger(local.limits.idleTimeoutMs), 'the watchdog is configured in the live config');
});

// The operator binding is written at the owner-authorized ceiling. Comparing against the constant instead
// of a literal is the point: each raise used to need an edit here too, and a missed one read as a product
// regression rather than a stale test.
test('the operator request ceiling matches the latest owner-authorized raise without touching history', t => {
    const operatorPath = operatorFile('config/native-owner.local.json');
    if (!operatorPath) { t.skip('needs the operator\'s local binding (excluded from the public package)'); return; }
    assert.equal(JSON.parse(readFileSync(operatorPath, 'utf8')).maxRequests, OPERATOR_REQUEST_CEILING);
    assert.ok(Number.isSafeInteger(OPERATOR_REQUEST_CEILING) && OPERATOR_REQUEST_CEILING > 0);
});
