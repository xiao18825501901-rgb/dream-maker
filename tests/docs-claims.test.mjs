// README told the reader '58 项 Node 测试通过' and '真实 Codex / DSH / Laya 联调为 NOT_RUN' long after 777 tests
// and two Live deliveries existed. A summary number is a claim, so it has to be checkable: this compares the
// count in README's 验证记录 section with the newest suite log the way verify-delivery.mjs reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './helpers.mjs';

const newestSuite = () => {
    const dir = resolve(root, '.runtime');
    let names = [];
    try { names = readdirSync(dir).filter(name => /^suite-\d+\.log$/.test(name)); } catch { return null; }
    const newest = names.map(name => ({ name, at: statSync(resolve(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
    if (!newest) return null;
    const text = readFileSync(resolve(dir, newest.name), 'utf8');
    const total = Number((text.match(/ℹ tests (\d+)/) ?? [])[1]);
    const pass = Number((text.match(/ℹ pass (\d+)/) ?? [])[1]);
    return Number.isSafeInteger(total) && Number.isSafeInteger(pass) ? { name: newest.name, total, pass } : null;
};

test('README states the regression count that the newest suite log actually recorded', t => {
    const suite = newestSuite();
    if (!suite) { t.skip('no .runtime/suite-*.log in this checkout'); return; }
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## 验证记录'));
    const claimed = section.slice(0, section.indexOf('\n## '));
    assert.match(claimed, /\d+/, 'README 验证记录 must state a number');
    const numbers = [...claimed.matchAll(/(\d+)\s*项/g)].map(match => Number(match[1]));
    assert.ok(numbers.includes(suite.total), 'README claims ' + JSON.stringify(numbers) + ' but ' + suite.name + ' recorded ' + suite.total + ' tests; update README 验证记录');
});

test('README does not present the retired Archon label as the current status', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const lines = readme.split('\n');
    assert.equal(lines.some(line => /ARCHON_NATIVE_UNVERIFIED/.test(line) && !/ARCHON_NATIVE_BOUND/.test(line)), false, 'a bare ARCHON_NATIVE_UNVERIFIED line reads as the current status; name both outcomes instead');
});
