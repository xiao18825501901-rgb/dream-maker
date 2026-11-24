import test from 'node:test';
import assert from 'node:assert/strict';
import { mapWorkspaceToWsl } from '../dist/server/wsl-workspace.js';

test('K07-W1 a safe root and run id map to one POSIX path', () => {
    const m = mapWorkspaceToWsl({ wslRoot: '/opt/dream-maker-controller/work', runId: 'run-abc_1' });
    assert.equal(m.linuxPath, '/opt/dream-maker-controller/work/run-abc_1');
    assert.equal(m.relative, 'run-abc_1');
    assert.equal(mapWorkspaceToWsl({ wslRoot: '/opt/x/', runId: 'r1' }).linuxPath, '/opt/x/r1');
});

test('K07-W2 a Windows-looking or relative root is refused', () => {
    for (const wslRoot of ['C:\\Users\\x', 'relative/path', '', '/opt/../etc', '/opt//x', '/opt/x y']) {
        assert.throws(() => mapWorkspaceToWsl({ wslRoot, runId: 'r1' }), { code: 'WSL_ROOT_INVALID' }, wslRoot);
    }
});

test('K07-W3 a run id is never silently rewritten: unsafe ids are refused', () => {
    for (const runId of ['', '.', '..', '../escape', 'a/b', 'a b', 'x'.repeat(81)]) {
        assert.throws(() => mapWorkspaceToWsl({ wslRoot: '/opt/x', runId }), { code: 'WSL_RUN_ID_INVALID' }, JSON.stringify(runId));
    }
});
