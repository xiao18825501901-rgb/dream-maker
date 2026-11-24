import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { harness } from './helpers.mjs';
import { fingerprint, compare, readJson } from '../scripts/lib/local-inventory.mjs';

test('inventory reads Windows UTF-8 BOM metadata without changing hashed bytes', t => {
    const h = harness(t), path = resolve(h.dir, 'package.json');
    writeFileSync(path, '\uFEFF{"name":"local-native","version":"1.0"}');
    assert.deepEqual(readJson(path), { name: 'local-native', version: '1.0' });
    assert.equal(readFileSync(path)[0], 0xef);
});

test('local inventory hashes only explicit files and preserves their exact bytes', t => {
    const h = harness(t), path = resolve(h.dir, 'profile.json');
    writeFileSync(path, '{"secret":"synthetic-audit-canary"}\r\n');
    const bytes = readFileSync(path), report = fingerprint([path]);
    assert.equal(report[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(JSON.stringify(report).includes('synthetic-audit-canary'), false);
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(compare(report, fingerprint([path])), { unchanged: true, changed: [], unverified: [] });
});

test('two missing observations do not prove protected bytes unchanged', t => {
    const h = harness(t), path = resolve(h.dir, 'never-present');
    const report = fingerprint([path]), result = compare(report, report);
    assert.equal(result.unchanged, false);
    assert.deepEqual(result.unverified, [path]);
});

test('inventory retains missing and changed files as failures of preservation', t => {
    const h = harness(t), path = resolve(h.dir, 'preset.yml'), missing = resolve(h.dir, 'absent');
    const before = fingerprint([path, missing]);
    assert.equal(before[0].status, 'MISSING');
    writeFileSync(path, 'new bytes');
    const result = compare(before, fingerprint([path, missing]));
    assert.equal(result.unchanged, false);
    assert.deepEqual(result.changed, [path]);
});

test('inventory never follows links outside the explicit scope', t => {
    const h = harness(t), linked = resolve(h.dir, 'link'), external = resolve(h.dir, 'external');
    mkdirSync(external);
    writeFileSync(resolve(external, 'profile.json'), 'outside');
    symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(fingerprint([resolve(linked, 'profile.json')])[0].status, 'LINK_DENIED');
});
