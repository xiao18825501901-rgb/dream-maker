#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createKimiBridgeController } from '../../dist/server/kimi-bridge-controller.js';
import { kimiBridgeConnectorLaunch } from '../../dist/server/kimi-bridge-launcher.js';
import { createKimiCredentialAuthority } from '../../dist/server/kimi-credential-authority.js';

const DISTRO = 'DreamMaker-Acceptance-20261011';
const SOCK = process.argv[2] ?? '/tmp/dm-bridge-smoke/ctl4.sock';
const ALREADY_RUNNING = process.argv[3] === '--already-running';
const CONNECTOR = '/tmp/dm-bridge-smoke/connect.py';

function wsl(argv, stdio = "ignore") {
    return spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', ...argv], { shell: false, stdio });
}

// Start the socket bridge (with the synthetic child) inside the distro.
const startLine = 'pkill -f "bridge.py --home" 2>/dev/null; pkill -f stub2.py 2>/dev/null; rm -f ' + SOCK + '; nohup /usr/bin/python3 /tmp/dm-bridge-smoke/bridge.py --home /tmp/dm-bridge-smoke/home --socket ' + SOCK + ' -- /usr/bin/python3 /tmp/dm-bridge-smoke/stub2.py > /tmp/dm-bridge-smoke/e2e-conn.log 2>&1 &';
if (!ALREADY_RUNNING) {
    await new Promise(res => { const c = wsl(['/bin/bash', '-lc', startLine]); c.on('exit', res); c.on('error', res); });
    await new Promise(r => setTimeout(r, 2000));
} else {
    console.log('USING_EXISTING_BRIDGE', SOCK);
}

let value = null;
const writes = [];
const store = {
    async save(_n, v) { writes.push(v); value = structuredClone(v); },
    async load() { return value ?? undefined; },
    async loadRecord() { return value == null ? { status: 'MISSING' } : { status: 'OK', record: structuredClone(value) }; },
    async remove() { value = null; },
    async list() { return value ? ['kimi-code'] : []; }
};
const authority = createKimiCredentialAuthority({ store });
await authority.restore();

const launch = kimiBridgeConnectorLaunch({ distro: DISTRO, socket: SOCK, connector: CONNECTOR });
const controller = createKimiBridgeController({ launch, spawn, authority, instanceId: 'ctl-conn', accountRef: 'kimi:synthetic' });
await controller.start();
console.log('SENT', JSON.stringify(controller.session().sent().map(f => f.type)));

const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
    if (controller.session().sent().some(f => f.type === 'COMMIT_ACK')) break;
    await new Promise(r => setTimeout(r, 250));
}
const sent = controller.session().sent().map(f => f.type);
console.log('FINAL', JSON.stringify(sent), 'WRITES', writes.length);
console.log('DIAG', JSON.stringify((controller.process()?.diagnostics() ?? []).slice(-2)));
controller.stop();
const ok = sent.includes('COMMIT_ACK') && writes.length === 1;
console.log(ok ? 'CONNECTOR-E2E_OK' : 'CONNECTOR-E2E_FAILED');
process.exit(ok ? 0 : 1);