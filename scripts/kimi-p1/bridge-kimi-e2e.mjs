#!/usr/bin/env node
// C03: production-shaped RESTORE delivery. The real controller spawns the real wsl.exe, which runs
// bridge.py, which owns the REAL patched Kimi server. A synthetic token is restored over the fd
// channel; the check is that the Kimi server stops saying "no token" and starts rejecting the token
// upstream — i.e. the credential actually reached the storage. No account, no model call.
import { spawn } from 'node:child_process';
import { createKimiBridgeController } from '../../dist/server/kimi-bridge-controller.js';
import { kimiBridgeLaunch } from '../../dist/server/kimi-bridge-launcher.js';
import { createKimiCredentialAuthority } from '../../dist/server/kimi-credential-authority.js';

const DISTRO = 'DreamMaker-Acceptance-20261011';
const HOME = '/opt/dream-maker-controller/kimi-home-2.2.0';
const DIST = '/opt/dream-maker-controller/kimi-source-472192c/apps/kimi-code/dist/main.mjs';
const NODE = '/opt/dream-maker-controller/toolchain/node-v24.22.0-linux-x64/bin/node';
const PORT = '58631';

let value = null;
const store = {
    async save(_n, v) { value = structuredClone(v); },
    async load() { return value ?? undefined; },
    async loadRecord() { return value == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(value) }; },
    async remove() { value = null; },
    async list() { return value ? ['kimi-code'] : []; }
};
const authority = createKimiCredentialAuthority({ store });
await authority.restore();
await authority.commit({
    token: { accessToken: 'DM_BRIDGE_E2E', refreshToken: 'DM_BRIDGE_E2E_R', expiresAt: Date.now() + 3_600_000, expiresIn: 3600, scope: 'kimi-code', tokenType: 'Bearer' },
    generation: 1,
    messageId: 'restore-1'
});

// A leftover server from a previous round would make the port bind fail and look like a bridge bug.
await new Promise(resolve => {
    const clean = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', 'pkill', '-f', 'dist/main.mjs'], { stdio: 'ignore' });
    clean.on('exit', resolve);
    clean.on('error', resolve);
});
await new Promise(r => setTimeout(r, 1200));

// Hand-built launch (diagnostic): the launcher has no slot for --log-dir, and we need the child's own
// output to tell "died silently" apart from "never started".
const launch = {
    command: 'wsl.exe',
    // -u root is not cosmetic: the isolated home is 0700 root-owned, so the default WSL user cannot
    // read it and the server never starts. Every working manual invocation had this flag.
    args: ['-d', DISTRO, '-u', 'root', '--', '/usr/bin/python3', '/tmp/dm-bridge-smoke/bridge.py', '--home', HOME, '--log-dir', '/tmp/dm-bridge-smoke/logs', '--', NODE, DIST, 'web', '--no-open', '--port', PORT],
    env: {}
};
const controller = createKimiBridgeController({
    launch, spawn, authority, instanceId: 'ctl-kimi', accountRef: 'kimi:synthetic',
    onExit: info => console.log('EXIT', JSON.stringify(info))
});
await controller.start();
console.log('SENT', JSON.stringify(controller.session().sent().map(f => f.type)));

// Give the Kimi server time to boot, then ask it about the account from inside the distro.
const probe = `import json,urllib.request,urllib.error
BASE='http://127.0.0.1:${PORT}'
tok=open('${HOME}/server.token').read().strip()
r=urllib.request.Request(BASE+'/api/v1/oauth/userinfo'); r.add_header('Authorization','Bearer '+tok)
try:
    with urllib.request.urlopen(r,timeout=20) as x: s,d=x.status,json.loads(x.read().decode())
except urllib.error.HTTPError as e: s,d=e.code,json.loads(e.read().decode() or '{}')
except Exception as e: s,d=-1,{'err':str(e)[:60]}
msg=str(((d.get('data') or {}).get('message')) or '')[:120]
print(json.dumps({'status':s,'kind':(d.get('data') or {}).get('kind'),'message':msg}))`;

async function query() {
    return await new Promise(resolve => {
        const child = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', '/usr/bin/python3', '-c', probe], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', c => { out += c.toString(); });
        child.on('exit', () => resolve(out.trim()));
        child.on('error', () => resolve(''));
    });
}

let last = '';
for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 1000));
    last = await query();
    if (last && !last.includes('No token for')) break;
}
console.log('USERINFO', last);
console.log('DIAGNOSTICS', JSON.stringify(controller.process()?.diagnostics() ?? []));
controller.stop();
