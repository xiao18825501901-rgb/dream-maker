import test from 'node:test';
import assert from 'node:assert/strict';
import { codexEnv } from '../dist/server/providers/codex-transport.js';
import { defaults, parseConfig } from '../dist/server/config.js';

// A03: the product CLI's environment. Pure data, no process, no login, no model. The point of these
// tests is the invariant the plan calls out: a WSL launch must never hand the daily Codex home (or
// the daily credentials inside it) to the generated-command namespace.

const cfg = (over = {}) => {
    const c = parseConfig(structuredClone(defaults));
    c.codex = { ...c.codex, ...over };
    return c;
};

test('A03-1 a wsl launch points CODEX_HOME at the isolated Linux home and nothing else', () => {
    const env = codexEnv(cfg({ transport: 'wsl', home: 'C:\\Users\\Hp\\.codex-product', wslHome: '/opt/codex-home-product' }));
    assert.deepEqual(env, { CODEX_HOME: '/opt/codex-home-product' });
    assert.equal(Object.keys(env).length, 1, 'no inherited keys are smuggled through this helper');
    assert.equal(JSON.stringify(env).includes('C:'), false, 'the Windows home never appears in the child env');
});

test('A03-2 a stdio launch uses the configured Windows home', () => {
    const env = codexEnv(cfg({ transport: 'stdio', home: 'C:\\Users\\Hp\\.codex-product' }));
    assert.deepEqual(env, { CODEX_HOME: 'C:\\Users\\Hp\\.codex-product' });
});

test('A03-3 a WSL home that resolves to the same directory as the daily home is refused as not isolated', () => {
    // Same directory on both sides = no isolation. (A Windows-shaped wslHome is rejected earlier,
    // by the POSIX-path check in A03-4, so this case uses a shared POSIX path.)
    assert.throws(() => codexEnv(cfg({ transport: 'wsl', home: '/opt/shared-codex-home', wslHome: '/opt/shared-codex-home' })), { code: 'CODEX_HOME_NOT_ISOLATED' });
    assert.throws(() => codexEnv(cfg({ transport: 'wsl', home: '/OPT/Shared-Codex-Home', wslHome: '/opt/shared-codex-home' })), { code: 'CODEX_HOME_NOT_ISOLATED' });
    assert.doesNotThrow(() => codexEnv(cfg({ transport: 'wsl', home: '/opt/one', wslHome: '/opt/two' })));
});

test('A03-4 a Windows or relative path can never become a Linux CODEX_HOME', () => {
    assert.throws(() => codexEnv(cfg({ transport: 'wsl', wslHome: 'C:\\Users\\Hp\\.codex' })), { code: 'CODEX_WSL_HOME_INVALID' });
    assert.throws(() => codexEnv(cfg({ transport: 'wsl', wslHome: '.codex' })), { code: 'CODEX_WSL_HOME_INVALID' });
    assert.throws(() => codexEnv(cfg({ transport: 'wsl', wslHome: '/opt/a b' })), { code: 'CODEX_WSL_HOME_INVALID' });
    assert.throws(() => codexEnv(cfg({ transport: 'wsl', wslHome: '/opt/../etc' })), { code: 'CODEX_WSL_HOME_INVALID' });
    assert.throws(() => codexEnv(cfg({ transport: 'wsl', wslHome: '' })), { code: 'CODEX_WSL_HOME_INVALID' });
});

test('A03-5 a stdio launch without any home is refused', () => {
    assert.throws(() => codexEnv(cfg({ transport: 'stdio', home: '' })), { code: 'ISOLATED_CODEX_HOME_REQUIRED' });
});
