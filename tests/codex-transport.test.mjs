// OFFLINE transport tests. The "wsl.exe" here is tests/fixtures/fake-wsl.mjs: it records the
// argv it receives and forwards stdio to the offline codex fixture. It is NOT WSL, and no Linux
// process, credential or model request is involved. Real WSL launch stays unverified (login 403).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexRunner } from '../dist/server/providers/codex.js';
import { codexLaunch, windowsCodexResumeRequest } from '../dist/server/providers/codex-transport.js';
import { parseConfig } from '../dist/server/config.js';
import { harness, root } from './helpers.mjs';

const wslConfig = h => {
    const c = h.config;
    c.codex = {
        command: 'unused-windows-binary', args: ['app-server'], home: h.dir, model: 'fixture-not-a-model',
        permissionProfile: 'dream-maker-source-read', policyFile: resolve(root,'config/codex-agent-readonly.toml'),
        transport: 'wsl', wslCommand: process.execPath, wslDistro: 'DreamMaker-Acceptance-20261011',
        wslCwdRoot: '/opt/dream-maker-controller/source', wslBinary: '/opt/dream-maker-controller/codex-0.162.0/codex',
        wslHome: '/opt/dream-maker-controller/codex-home'
    };
    return c;
};

test('K07-11 stdio transport keeps the configured Windows command untouched', () => {
    const h = harness(test);
    const l = codexLaunch(parseConfig(h.config), h.dir);
    assert.equal(l.transport, 'stdio');
    assert.equal(l.command, 'codex');
    assert.deepEqual(l.args, ['app-server']);
    assert.equal(l.cwd, h.dir);
});

test('Windows Codex cold resume uses the strict 0.162.0 request schema', () => {
    const request = windowsCodexResumeRequest({
        threadId: '01a1b5b5-c62e-7e82-bf4c-35b8de4fc337',
        model: 'gpt-6-sol',
        cwd: 'F:\\DreamMakerSuite\\worktrees\\kimi-p1-v1\\.runtime\\windows-codex\\planner2-test\\packet',
        permissionProfile: 'dream-maker-supervisor-data',
        config: { default_permissions: 'dream-maker-supervisor-data' },
        excludeTurns: false
    });
    assert.deepEqual(Object.keys(request).sort(), [
        'approvalPolicy', 'config', 'cwd', 'excludeTurns', 'model', 'modelProvider',
        'permissions', 'runtimeWorkspaceRoots', 'serviceTier', 'threadId'
    ]);
    assert.equal(Object.hasOwn(request, 'environments'), false);
    assert.equal(request.modelProvider, 'openai');
    assert.equal(request.serviceTier, 'default');
    assert.equal(request.approvalPolicy, 'never');
    assert.deepEqual(request.runtimeWorkspaceRoots, []);
});

test('K07-12 wsl transport builds an argv with no shell string and no Windows cwd', () => {
    const h = harness(test);
    const l = codexLaunch(parseConfig(wslConfig(h)), h.dir);
    assert.equal(l.transport, 'wsl');
    // The isolated Linux home must be set INSIDE the distro: wsl.exe does not forward CODEX_HOME, and
    // without it the CLI silently uses its default home (no login -> no subscription account).
    assert.deepEqual(l.args, ['-d', 'DreamMaker-Acceptance-20261011', '--cd', '/opt/dream-maker-controller/source', '--', '/usr/bin/env', 'HOME=/opt/dream-maker-controller/codex-home', 'CODEX_HOME=/opt/dream-maker-controller/codex-home', '/opt/dream-maker-controller/codex-0.162.0/codex', 'app-server']);
    assert.equal(l.cwd, undefined);
    assert.equal(l.args.join(' ').includes(h.dir), false);
});

test('K07-13 unsafe distro, cwd, binary or missing Linux home are refused before spawn', () => {
    const h = harness(test);
    for (const [patch, code] of [
        [{ wslDistro: 'evil; rm -rf /' }, 'CODEX_WSL_DISTRO_INVALID'],
        [{ wslDistro: '' }, 'CODEX_WSL_DISTRO_INVALID'],
        [{ wslCwdRoot: '/opt/$(whoami)' }, 'CODEX_WSL_CWD_INVALID'],
        [{ wslCwdRoot: 'relative/path' }, 'CODEX_WSL_CWD_INVALID'],
        [{ wslCwdRoot: '/opt/../etc' }, 'CODEX_WSL_CWD_INVALID'],
        [{ wslBinary: '/opt/bin with space' }, 'CODEX_WSL_BINARY_INVALID'],
        [{ wslHome: '' }, 'CODEX_WSL_HOME_REQUIRED']
    ]) {
        const c = wslConfig(h);
        Object.assign(c.codex, patch);
        assert.throws(() => codexLaunch(parseConfig(c), h.dir), { code }, JSON.stringify(patch));
    }
});

test('K07-14 the runner itself refuses an unsafe wsl launch before spawning any child', async t => {
    const h = harness(t);
    const c = wslConfig(h);
    c.codex.wslCwdRoot = '/opt/$(whoami)';
    const runner = new CodexRunner(() => c, root);
    await assert.rejects(runner.run({ workspace: h.dir, prompt: 'frozen data', model: c.codex.model, specHash: 'fixture', runId: 'fixture', role: 'planner2', laya: { adoption: 'off' }, signal: new AbortController().signal }, () => { }), { code: 'CODEX_WSL_CWD_INVALID' });
    assert.equal(existsSync(resolve(h.dir, 'codex-fixture-requests.jsonl')), false);
});
test('WSL never forwards the retained Windows npm launcher to the Linux executable',t=>{
 const h=harness(t),c=wslConfig(h);c.codex.args=['C:\\Users\\Hp\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js','app-server'];
 const launched=codexLaunch(c,h.dir);assert.equal(launched.args.includes(c.codex.args[0]),false);
 assert.equal(launched.args.at(-1),'app-server');assert.deepEqual(c.codex.args,['C:\\Users\\Hp\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js','app-server']);
 c.codex.args=['unreviewed-file.js','app-server'];assert.throws(()=>codexLaunch(c,h.dir),{code:'CODEX_WSL_ARGS_DENIED'});
});
test('WSL Codex refuses an unqualified Windows Clash route before spawning or making a model turn',async t=>{
 const h=harness(t),c=wslConfig(h);c.clash.enabled=true;
 await assert.rejects(new CodexRunner(()=>c,root).run({workspace:h.dir,prompt:'offline supplied data',model:c.codex.model,specHash:'offline',runId:'offline',role:'planner2',laya:{adoption:'off'},signal:new AbortController().signal},()=>{}),{code:'CODEX_WSL_PROXY_BINDING_UNVERIFIED'});
 assert.equal(existsSync(resolve(h.dir,'codex-fixture-requests.jsonl')),false);
});
// NOTE (K07-B): a full end-to-end run through a fake "wsl.exe" is not possible on Windows
// without an executable stub, because the runner spawns command+args with shell:false. The real
// WSL launch must be exercised against the dedicated distro once the Linux CLI login is not
// refused with HTTP 403; until then this file proves the launch shape and the refusals only.
