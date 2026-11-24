// Trusted verifier, owned by the controller; not copied into executor workspace.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = resolve(process.argv[2]);
const { add, toggle, remove, stats, restore } = await import(pathToFileURL(resolve(workspace, 'board.mjs')).href);
let n = 0;
function check(name, fn) { fn(); n++; console.log('PASS ' + name); }
check('required files', () => { for (const f of ['index.html', 'app.mjs', 'style.css', 'README.md'])
    assert.ok(existsSync(resolve(workspace, f))); });
let tasks = [];
check('add trimmed task', () => { tasks = add(tasks, ' 学习 Agent ', 'a'); assert.deepEqual(tasks, [{ id: 'a', title: '学习 Agent', done: false }]); });
check('reject empty', () => assert.throws(() => add(tasks, ' ', 'b')));
check('reject duplicate id', () => assert.throws(() => add(tasks, 'other', 'a')));
check('toggle complete', () => { tasks = toggle(tasks, 'a'); assert.equal(tasks[0].done, true); });
check('toggle back', () => { tasks = toggle(tasks, 'a'); assert.equal(tasks[0].done, false); });
check('stats', () => assert.deepEqual(stats(tasks), { total: 1, done: 0, active: 1 }));
check('restore exact', () => assert.deepEqual(restore(JSON.stringify(tasks)), tasks));
check('corrupt storage', () => assert.deepEqual(restore('{broken'), []));
check('malformed rows ignored', () => assert.deepEqual(restore('[{"x":1},null]'), []));
check('remove', () => assert.deepEqual(remove(tasks, 'a'), []));
check('real browser module present', () => assert.match(readFileSync(resolve(workspace, 'app.mjs'), 'utf8'), /localStorage/));
console.log(JSON.stringify({ schema: 'dream-maker.verification.v1', checks: n, result: 'PASS', scope: 'DEMO_TEMPLATE_ONLY' }));
