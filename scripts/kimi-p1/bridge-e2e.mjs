#!/usr/bin/env node
// C03 end-to-end: the REAL controller spawns the REAL wsl.exe + bridge.py, which owns a synthetic
// child speaking the fd3/fd4 frame protocol. No Kimi, no account, no model — the point is that the
// rotation is only acknowledged after the durable commit.
import { spawn } from 'node:child_process';
import { createKimiBridgeController } from '../../dist/server/kimi-bridge-controller.js';
import { kimiBridgeLaunch } from '../../dist/server/kimi-bridge-launcher.js';
import { createKimiCredentialAuthority } from '../../dist/server/kimi-credential-authority.js';

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

const launch = kimiBridgeLaunch({
    distro: 'DreamMaker-Acceptance-20261011',
    script: '/tmp/dm-bridge-smoke/bridge.py',
    home: '/tmp/dm-bridge-smoke/home',
    interpreter: '/usr/bin/python3',
    child: ['/usr/bin/python3', '/tmp/dm-bridge-smoke/stub2.py']
});
console.log('ARGV', JSON.stringify(launch.args));
const controller = createKimiBridgeController({
    launch, spawn, authority, instanceId: 'ctl-e2e', accountRef: 'kimi:synthetic',
    onExit: info => console.log('EXIT', JSON.stringify(info))
});
await controller.start();
console.log('SENT', JSON.stringify(controller.session().sent().map(f => f.type)));

// Wait for the synthetic child's rotation to be committed and acknowledged.
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
    const acked = controller.session().sent().some(f => f.type === 'COMMIT_ACK');
    if (acked) break;
    await new Promise(r => setTimeout(r, 250));
}
console.log('DIAGNOSTICS', JSON.stringify(controller.process()?.diagnostics() ?? []));
const sent = controller.session().sent().map(f => f.type);
console.log('FINAL_SENT', JSON.stringify(sent));
console.log('STORE_WRITES', writes.length);
const ack = controller.session().sent().find(f => f.type === 'COMMIT_ACK');
console.log('ACK', JSON.stringify(ack ? { generation: ack.generation, messageId: ack.messageId } : null));
controller.stop();
const ok = sent.includes('COMMIT_ACK') && writes.length === 1 && ack?.messageId === 'rotate-1';
console.log(ok ? 'E2E_OK' : 'E2E_FAILED');
process.exit(ok ? 0 : 1);
